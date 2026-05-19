// ─── @livelayer/bridge ────────────────────────────────────────────────
// Tiny vanilla-JS bridge for iframe-embed mode. Loaded as
// `<script src="https://livelayer.studio/bridge.js">` on the host page,
// alongside an `<iframe src="https://app.livelayer.studio/widget/...">`.
//
// Role: relay agent commands FROM the iframe to the host page (via
// postMessage) and host pathname updates BACK to the iframe (so
// hideOn / showOn work). Without this, iframe consumers get voice +
// avatar but zero page-aware features (cross-origin blocks DOM access).
//
// Security boundary (the entire correctness story):
//   1. We only accept postMessage events whose origin matches the
//      LiveLayer iframe origin (default app.livelayer.studio, override
//      via window.LIVELAYER_BRIDGE_ORIGIN).
//   2. We only act on payloads with `source: "livelayer"` AND a `type`
//      in our allowlist. Anything else is dropped silently.
//   3. We only run actions that have already been allowed from inside
//      the agent (capability allowlist filters there too) — this is
//      defense in depth.
//
// What we DON'T bridge (security / scope):
//   - fill_form / submit_form — DOM nodes don't postMessage cleanly,
//     and consumers should use @livelayer/react for that path.
//   - request_page_context / request_routes — same reason.
//
// Embedding consumers who need forms / page context should switch
// from iframe mode to the @livelayer/react NPM package.
//
// Build: this file compiles to dist/bridge.js as a self-executing
// IIFE (Vite's "library" build with iife output). No runtime deps.

import { handleAgentCommand } from "./handle-agent-command";

interface LiveLayerMessage {
  source?: unknown;
  type?: unknown;
  href?: unknown;
  selector?: unknown;
  direction?: unknown;
  behavior?: unknown;
}

const DEFAULT_LIVELAYER_ORIGIN = "https://app.livelayer.studio";
const ALLOWED_TYPES = new Set([
  "navigate",
  "scroll_page",
  "scroll_to",
  "click",
]);

function getAllowedOrigin(): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const win = typeof window !== "undefined" ? (window as any) : null;
  return (
    (win?.LIVELAYER_BRIDGE_ORIGIN as string | undefined) ||
    DEFAULT_LIVELAYER_ORIGIN
  );
}

let cachedIframes: HTMLIFrameElement[] = [];
let lastIframeRefresh = 0;
const IFRAME_REFRESH_MS = 1000;

function findLiveLayerIframes(): HTMLIFrameElement[] {
  const now = Date.now();
  if (now - lastIframeRefresh < IFRAME_REFRESH_MS && cachedIframes.length > 0) {
    return cachedIframes;
  }
  if (typeof document === "undefined") return [];
  const allowedOrigin = getAllowedOrigin();
  const out: HTMLIFrameElement[] = [];
  const iframes = document.querySelectorAll<HTMLIFrameElement>("iframe[src]");
  for (const f of Array.from(iframes)) {
    const src = f.getAttribute("src") || "";
    try {
      if (new URL(src).origin === allowedOrigin) {
        out.push(f);
      }
    } catch {
      // Bad URL — skip.
    }
  }
  cachedIframes = out;
  lastIframeRefresh = now;
  return out;
}

function postPathnameToIframes(): void {
  if (typeof window === "undefined") return;
  const allowedOrigin = getAllowedOrigin();
  const pathname = window.location.pathname;
  for (const f of findLiveLayerIframes()) {
    try {
      f.contentWindow?.postMessage(
        { source: "livelayer-host", type: "pathname", pathname },
        allowedOrigin,
      );
    } catch {
      // Can't postMessage — iframe may be sandboxed without
      // allow-same-origin. Drop silently.
    }
  }
}

function isLiveLayerMessage(
  e: MessageEvent,
  allowedOrigin: string,
): e is MessageEvent<LiveLayerMessage> {
  if (e.origin !== allowedOrigin) return false;
  const data = e.data as LiveLayerMessage | null;
  if (!data || typeof data !== "object") return false;
  if (data.source !== "livelayer") return false;
  if (typeof data.type !== "string") return false;
  if (!ALLOWED_TYPES.has(data.type)) return false;
  return true;
}

function init(): void {
  if (typeof window === "undefined") return;
  // Idempotent — survive duplicate <script> tags.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  if (w.__livelayer_bridge_initialized) return;
  w.__livelayer_bridge_initialized = true;

  const allowedOrigin = getAllowedOrigin();

  window.addEventListener("message", (e) => {
    if (!isLiveLayerMessage(e, allowedOrigin)) return;
    handleAgentCommand(e.data, {
      // The bridge does NOT honor a host-side capability allowlist;
      // capabilities are filtered at the agent runtime (it never sends
      // commands the agent owner hasn't enabled). Add a host-side
      // restriction by intercepting postMessage in your own script if
      // you want belt-and-braces.
    });
  });

  // Send pathname on load + on every history change so the iframe's
  // hideOn / showOn can react. Patch pushState idempotently.
  postPathnameToIframes();
  window.addEventListener("popstate", postPathnameToIframes);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wAny = window as any;
  if (!wAny.__livelayer_history_patched) {
    wAny.__livelayer_history_patched = true;
    const origPush = window.history.pushState;
    const origReplace = window.history.replaceState;
    window.history.pushState = function (...args) {
      const r = origPush.apply(
        this,
        args as Parameters<typeof window.history.pushState>,
      );
      postPathnameToIframes();
      return r;
    };
    window.history.replaceState = function (...args) {
      const r = origReplace.apply(
        this,
        args as Parameters<typeof window.history.replaceState>,
      );
      postPathnameToIframes();
      return r;
    };
  }

  // Refresh iframe list when DOM changes (consumer mounts the iframe
  // dynamically via React/Vue/etc).
  if (typeof MutationObserver !== "undefined") {
    const observer = new MutationObserver(() => {
      // Invalidate the cache; next message handler call will re-scan.
      lastIframeRefresh = 0;
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }
}

// Auto-init when loaded as a script tag.
if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
}

// Named exports so this can also be imported by tests / advanced consumers.
export { init };
