/**
 * Live Layer Visitor Tracker
 *
 * Handles browser fingerprinting, identity resolution, and auto-tracking
 * of page views, clicks, and custom events.
 *
 * Data flow:
 *   Page load → FingerprintJS init (with adblocker fallback)
 *   → POST /api/visitors/identify → receive visitorId
 *   → Auto-track page views + clicks → batch flush every 5s
 *   → POST /api/visitors/{id}/events on flush or page exit
 */

// ─── Types ──────────────────────────────────────────────────────────

export interface TrackerConfig {
  agentId: string;
  apiBase?: string;
  autoTrack?: boolean;
  autoTrackClicks?: boolean;
}

export interface VisitorInfo {
  id: string;
  isReturning: boolean;
  sessionCount: number;
}

interface TrackEvent {
  type: "page_view" | "page_exit" | "click" | "identify" | "custom";
  url?: string;
  title?: string;
  data?: Record<string, unknown>;
  pageUrl?: string;
  duration?: number;
  scrollDepth?: number;
  timestamp: string;
}

// ─── Constants ──────────────────────────────────────────────────────

const LS_KEY = "ll_visitor_id";
const LS_LS_KEY = "ll_local_storage_id";
const FLUSH_INTERVAL_MS = 5000;
const MAX_BATCH_SIZE = 50;
const INTERACTIVE_SELECTORS = "a,button,input,[role=button],[onclick]";

// ─── Tracker Class ──────────────────────────────────────────────────

export class LiveLayerTracker {
  private config: Required<TrackerConfig>;
  private visitorId: string | null = null;
  private visitorInfo: VisitorInfo | null = null;
  private eventQueue: TrackEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private pageEntryTime = Date.now();
  private maxScrollDepth = 0;
  private clickHandler: ((e: Event) => void) | null = null;
  private initialized = false;

  constructor(config: TrackerConfig) {
    this.config = {
      agentId: config.agentId,
      apiBase: config.apiBase || "",
      autoTrack: config.autoTrack ?? true,
      autoTrackClicks: config.autoTrackClicks ?? true,
    };
  }

  /**
   * Initialize the tracker: run fingerprinting, resolve identity, start tracking.
   */
  async init(): Promise<VisitorInfo | null> {
    if (this.initialized) return this.visitorInfo;
    this.initialized = true;

    let fingerprintId: string | null = null;

    // Try FingerprintJS (graceful degradation if blocked)
    try {
      const FingerprintJS = await import("@fingerprintjs/fingerprintjs");
      const fp = await FingerprintJS.load();
      const result = await fp.get();
      fingerprintId = result.visitorId;
    } catch {
      // FingerprintJS blocked by adblocker — continue with localStorage only
    }

    // Get or create localStorage ID
    let localStorageId = this.safeGetItem(LS_LS_KEY);
    if (!localStorageId) {
      localStorageId = this.generateId();
      this.safeSetItem(LS_LS_KEY, localStorageId);
    }

    // Resolve identity
    try {
      const metadata = {
        browserLanguage: navigator.language,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        referralUrl: document.referrer || undefined,
        ...this.parseUtmParams(),
      };

      const res = await fetch(`${this.config.apiBase}/api/visitors/identify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: this.config.agentId,
          fingerprintId,
          localStorageId,
          metadata,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        this.visitorId = data.visitorId;
        this.visitorInfo = {
          id: data.visitorId,
          isReturning: data.isReturning,
          sessionCount: data.sessionCount,
        };
        this.safeSetItem(LS_KEY, data.visitorId);
      }
    } catch {
      // Network error — use cached visitor ID if available
      this.visitorId = this.safeGetItem(LS_KEY);
    }

    // Start auto-tracking
    if (this.config.autoTrack && this.visitorId) {
      this.startAutoTracking();
    }

    return this.visitorInfo;
  }

  /**
   * Get the resolved visitor info.
   */
  get visitor(): VisitorInfo | null {
    return this.visitorInfo;
  }

  /**
   * Get the resolved visitor ID (for passing to session creation).
   */
  getVisitorId(): string | null {
    return this.visitorId;
  }

  /**
   * Manually identify a visitor with known attributes.
   */
  identify(attrs: { name?: string; email?: string; phone?: string; company?: string; [key: string]: unknown }) {
    this.enqueue({
      type: "identify",
      data: attrs,
      pageUrl: location.href,
      timestamp: new Date().toISOString(),
    });
    // Also update the visitor record via the events pipeline
    this.flush();
  }

  /**
   * Track a custom event.
   */
  track(eventName: string, data?: Record<string, unknown>) {
    this.enqueue({
      type: "custom",
      data: { eventName, ...data },
      pageUrl: location.href,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Clean up listeners and flush remaining events.
   */
  destroy() {
    this.flush();
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.clickHandler) {
      document.body.removeEventListener("click", this.clickHandler, true);
    }
    window.removeEventListener("beforeunload", this.handlePageExit);
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
  }

  // ─── Private ────────────────────────────────────────────────────

  private startAutoTracking() {
    // Track initial page view
    this.trackPageView();

    // Listen for SPA navigation
    const origPushState = history.pushState;
    history.pushState = (...args) => {
      origPushState.apply(history, args);
      this.trackPageView();
    };
    window.addEventListener("popstate", () => this.trackPageView());

    // Track scroll depth
    window.addEventListener("scroll", () => {
      const scrollPercent = Math.round(
        (window.scrollY / (document.documentElement.scrollHeight - window.innerHeight)) * 100
      );
      this.maxScrollDepth = Math.max(this.maxScrollDepth, scrollPercent || 0);
    }, { passive: true });

    // Click tracking
    if (this.config.autoTrackClicks) {
      this.clickHandler = (e: Event) => {
        const target = (e.target as Element)?.closest?.(INTERACTIVE_SELECTORS);
        if (!target) return;

        const text = (target.textContent || "").trim().slice(0, 100);
        const tag = target.tagName.toLowerCase();
        const href = (target as HTMLAnchorElement).href || undefined;
        const llTrack = target.getAttribute("data-ll-track") || undefined;

        this.enqueue({
          type: "click",
          data: { tag, text, href, llTrack },
          pageUrl: location.href,
          timestamp: new Date().toISOString(),
        });
      };
      document.body.addEventListener("click", this.clickHandler, true);
    }

    // Page exit tracking
    window.addEventListener("beforeunload", this.handlePageExit);
    document.addEventListener("visibilitychange", this.handleVisibilityChange);

    // Start flush timer
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  private trackPageView() {
    this.pageEntryTime = Date.now();
    this.maxScrollDepth = 0;
    this.enqueue({
      type: "page_view",
      url: location.href,
      title: document.title,
      timestamp: new Date().toISOString(),
    });
  }

  private handlePageExit = () => {
    const duration = Math.round((Date.now() - this.pageEntryTime) / 1000);
    this.enqueue({
      type: "page_exit",
      url: location.href,
      duration,
      scrollDepth: this.maxScrollDepth,
      timestamp: new Date().toISOString(),
    });
    this.flush(true);
  };

  private handleVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      this.handlePageExit();
    }
  };

  private enqueue(event: TrackEvent) {
    this.eventQueue.push(event);
    if (this.eventQueue.length >= MAX_BATCH_SIZE) {
      this.flush();
    }
  }

  private flush(useBeacon = false) {
    if (!this.visitorId || this.eventQueue.length === 0) return;

    const events = this.eventQueue.splice(0, MAX_BATCH_SIZE);
    const url = `${this.config.apiBase}/api/visitors/${this.visitorId}/events`;
    const body = JSON.stringify({ events });

    if (useBeacon && typeof navigator.sendBeacon === "function") {
      navigator.sendBeacon(url, body);
    } else {
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => {
        // Failed to send — re-queue events
        this.eventQueue.unshift(...events);
      });
    }
  }

  private parseUtmParams(): Record<string, string | undefined> {
    const params = new URLSearchParams(location.search);
    return {
      utmSource: params.get("utm_source") || undefined,
      utmMedium: params.get("utm_medium") || undefined,
      utmCampaign: params.get("utm_campaign") || undefined,
      utmContent: params.get("utm_content") || undefined,
      utmTerm: params.get("utm_term") || undefined,
    };
  }

  private generateId(): string {
    return "ll_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  private safeGetItem(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  private safeSetItem(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // localStorage unavailable (incognito, storage full)
    }
  }
}

// ─── Standalone Script Entry Point ──────────────────────────────────

/**
 * Self-initializing entry point for the standalone tracker script.
 * Reads config from the script tag's data attributes.
 */
export function initFromScriptTag() {
  if (typeof document === "undefined") return;

  const script = document.currentScript as HTMLScriptElement | null;
  if (!script) return;

  const agentId = script.getAttribute("data-agent-id");
  if (!agentId) {
    console.warn("[LiveLayer] Missing data-agent-id on tracker script");
    return;
  }

  const tracker = new LiveLayerTracker({
    agentId,
    autoTrack: script.getAttribute("data-auto-track") !== "false",
    autoTrackClicks: script.getAttribute("data-auto-track-clicks") !== "false",
  });

  // Expose on window
  (window as any).LiveLayer = {
    identify: (attrs: Record<string, unknown>) => tracker.identify(attrs),
    track: (name: string, data?: Record<string, unknown>) => tracker.track(name, data),
    get visitor() { return tracker.visitor; },
    _tracker: tracker,
  };

  tracker.init();
}
