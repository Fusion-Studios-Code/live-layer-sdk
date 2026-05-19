// ─── <livelayer-widget> Web Component ────────────────────────────────
// Drop-in custom element that fetches the published agent config,
// renders the appropriate experience mode (widget bubble or embedded),
// and connects to LiveKit for real-time voice/video/chat.

import { renderWidget, type WidgetRendererConfig } from "./renderers/widget-renderer";
import { renderEmbedded, type EmbeddedRendererConfig } from "./renderers/embedded-renderer";
import { saveSession, loadSession, clearSession } from "./session-persistence";
import { dispatchAgentEvent, parseDataChannelMessage } from "./event-bridge";
import { LiveKitSession, type SessionCallbacks, type ConnectionState, type AgentState, type TranscriptEntry } from "./livekit-session";
import { handleAgentCommand, type AgentCapability } from "./handle-agent-command";

export { saveSession, loadSession, clearSession } from "./session-persistence";
export { dispatchAgentEvent, parseDataChannelMessage, sanitize } from "./event-bridge";
export { LiveLayerTracker, initFromScriptTag } from "./tracker";
export type { TrackerConfig, VisitorInfo } from "./tracker";
export { LiveKitSession } from "./livekit-session";
export type { SessionCallbacks, SessionOptions, AgentConfig, TranscriptEntry, ConnectionState, AgentState } from "./livekit-session";

// ─── Published Config shape (subset returned by /api/agents/{id}/config) ──

interface PublishedAgentConfig {
  experienceMode: "WIDGET" | "EMBEDDED" | "FULLSCREEN";
  widgetConfig?: {
    mediaType: "video" | "audio" | "chat";
    position: "bottom-right" | "bottom-left" | "center";
    colors: {
      border?: string;
      agentColor?: string;
      backgroundColor?: string;
      messageColor?: string;
    };
    video?: { allowCamera?: boolean; allowScreenShare?: boolean; allowTyping?: boolean };
    audio?: { allowCamera?: boolean; allowScreenShare?: boolean; allowTyping?: boolean };
  };
  embeddedConfig?: {
    mediaType: "video" | "audio" | "chat";
    container: { width: string; height: string; responsive: boolean };
    colors: {
      border?: string;
      agentColor?: string;
      backgroundColor?: string;
      messageColor?: string;
    };
    video?: { allowCamera?: boolean; allowScreenShare?: boolean; allowTyping?: boolean };
    audio?: { allowCamera?: boolean; allowScreenShare?: boolean; allowTyping?: boolean };
  };
}

// ─── Custom Element ──────────────────────────────────────────────────

// SSR guard: HTMLElement is undefined in Node. Extend a runtime-safe
// reference so the class declaration itself doesn't throw at module
// evaluation. Nothing instantiates the class on the server — the
// `customElements.define` call below is already gated on a browser
// global — so the stub never has its constructor called.
const HTMLElementBase: typeof HTMLElement =
  typeof HTMLElement !== "undefined"
    ? HTMLElement
    : (class {} as unknown as typeof HTMLElement);

class LiveLayerWidget extends HTMLElementBase {
  static readonly TAG_NAME = "livelayer-widget";

  static get observedAttributes(): string[] {
    return ["agent-id", "mode", "base-url", "api-key", "capabilities"];
  }

  private _shadowRoot: ShadowRoot;
  private _agentId: string | null = null;
  private _baseUrl: string = "";
  private _apiKey: string | null = null;
  private _abortController: AbortController | null = null;
  private _session: LiveKitSession | null = null;
  /** Reflects LiveKitSession.canResume() so connection UI can pick the right copy. */
  private _canResume = false;
  /**
   * 0.5.0 — capability allowlist. Parsed from the `capabilities`
   * attribute (JSON array of strings). undefined = unrestricted (all
   * commands allowed, matches @livelayer/react@0.4.x default).
   */
  private _capabilities: AgentCapability[] | undefined = undefined;
  /**
   * True once connectedCallback has run. Used to suppress attributeChangedCallback
   * during element upgrade — upgrade fires attribute callbacks BEFORE connectedCallback,
   * which would cause a duplicate _initialize() if we acted on them both.
   */
  private _connected = false;

  constructor() {
    super();
    this._shadowRoot = this.attachShadow({ mode: "open" });
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  connectedCallback(): void {
    this._agentId = this.getAttribute("agent-id");
    this._baseUrl = this.getAttribute("base-url") || this._detectBaseUrl();
    this._apiKey = this.getAttribute("api-key");
    this._capabilities = this._parseCapabilitiesAttr(
      this.getAttribute("capabilities"),
    );
    this._connected = true;
    if (this._agentId) {
      this._initialize(this._agentId);
    }
  }

  /**
   * Parse the `capabilities` attribute. Accepts JSON array of strings
   * (`'["navigate","scroll"]'`) or comma-separated (`"navigate,scroll"`).
   * Returns undefined for null/empty/invalid — meaning "unrestricted".
   */
  private _parseCapabilitiesAttr(raw: string | null): AgentCapability[] | undefined {
    if (!raw) return undefined;
    const valid: AgentCapability[] = [
      "navigate",
      "scroll",
      "click",
      "fill_forms",
      "submit_forms",
      "read_page",
    ];
    let arr: string[] = [];
    const trimmed = raw.trim();
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          arr = parsed.filter((x): x is string => typeof x === "string");
        }
      } catch {
        return undefined;
      }
    } else {
      arr = trimmed.split(",").map((s) => s.trim()).filter(Boolean);
    }
    return arr.filter((x): x is AgentCapability => (valid as string[]).includes(x));
  }

  disconnectedCallback(): void {
    this._connected = false;
    this._abortController?.abort();
    this._session?.destroy();
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    // Custom element upgrade fires attribute callbacks BEFORE connectedCallback. Skip those —
    // connectedCallback reads every attribute fresh and triggers init. This callback is only
    // meaningful for dynamic reconfiguration after the element is in the DOM.
    if (!this._connected) return;

    if (name === "agent-id" && newValue !== oldValue && newValue) {
      this._agentId = newValue;
      this._clear();
      this._initialize(newValue);
    }
    if (name === "base-url" && newValue !== oldValue) {
      this._baseUrl = newValue || this._detectBaseUrl();
    }
    if (name === "api-key" && newValue !== oldValue) {
      this._apiKey = newValue;
    }
    if (name === "capabilities" && newValue !== oldValue) {
      this._capabilities = this._parseCapabilitiesAttr(newValue);
    }
  }

  // ── Internals ────────────────────────────────────────────────────

  /**
   * Auto-detect base URL from the script that loaded the SDK.
   * If loaded from https://app.livelayer.studio/v1.js, uses that origin.
   * Falls back to same-origin (empty string) for first-party usage.
   */
  private _detectBaseUrl(): string {
    const scripts = document.querySelectorAll("script[src]");
    for (const script of scripts) {
      const src = script.getAttribute("src") || "";
      if (src.includes("livelayer") || src.includes("v1.js")) {
        try {
          return new URL(src).origin;
        } catch {
          // relative URL, same origin
        }
      }
    }
    return "";
  }

  private _clear(): void {
    this._abortController?.abort();
    this._session?.destroy();
    this._session = null;
    while (this._shadowRoot.firstChild) {
      this._shadowRoot.removeChild(this._shadowRoot.firstChild);
    }
  }

  private async _initialize(agentId: string): Promise<void> {
    this._abortController = new AbortController();
    const { signal } = this._abortController;

    // Check for existing session that can be rejoined
    const existingSession = loadSession(agentId);
    if (existingSession) {
      console.info("[LiveLayer] Found existing session, attempting rejoin", existingSession.roomName);
    }

    // Fetch published config
    let config: PublishedAgentConfig;
    try {
      const headers: Record<string, string> = {};
      if (this._apiKey) {
        headers["x-api-key"] = this._apiKey;
      }

      const resp = await fetch(`${this._baseUrl}/api/agents/${agentId}/config`, {
        signal,
        headers,
      });
      if (!resp.ok) {
        throw new Error(`Config fetch failed: ${resp.status}`);
      }
      config = await resp.json();
    } catch (err) {
      if (signal.aborted) return;
      console.error("[LiveLayer] Failed to fetch agent config:", err);
      this._renderError("Unable to load agent configuration");
      return;
    }

    if (signal.aborted) return;

    // Select renderer based on experienceMode
    const mode = this.getAttribute("mode") ?? config.experienceMode;

    if (mode === "WIDGET" && config.widgetConfig) {
      this._renderWidgetMode(agentId, config.widgetConfig);
    } else if (mode === "EMBEDDED" && config.embeddedConfig) {
      this._renderEmbeddedMode(agentId, config.embeddedConfig);
    } else if (mode === "FULLSCREEN") {
      this._renderError("Fullscreen mode uses hosted URLs — see docs");
    } else {
      // Fallback: render widget mode with defaults
      this._renderWidgetMode(agentId, {
        mediaType: "video",
        position: "bottom-right",
        colors: {},
      });
    }
  }

  private _createSession(agentId: string, contentEl: HTMLElement): LiveKitSession {
    const callbacks: SessionCallbacks = {
      onConnectionStateChange: (state) => {
        this._updateConnectionUI(state, contentEl);
      },
      onAgentStateChange: (state) => {
        this._updateAgentStateUI(state);
      },
      onTranscript: (entries) => {
        this._updateTranscriptUI(entries, contentEl);
      },
      onAgentConfig: () => {
        // Could update avatar/name display
      },
      onAudioTrack: () => {
        // Audio plays automatically via el.play() in the session
      },
      onVideoTrack: (videoEl) => {
        videoEl.style.cssText = "width:100%;height:100%;object-fit:cover;border-radius:8px;";
        const container = contentEl.querySelector(".ll-video-container");
        if (container) {
          container.appendChild(videoEl);
        }
      },
      onVideoTrackRemoved: () => {
        const container = contentEl.querySelector(".ll-video-container");
        if (container) {
          while (container.firstChild) container.removeChild(container.firstChild);
        }
      },
      onError: (msg) => {
        console.error("[LiveLayer]", msg);
      },
      // 0.7.0 — unified collection event. Whenever the agent records a
      // field (mid-flow OR at the end of a guided sub-conversation), we
      // fire `ll-collected` on this widget element. The detail shape is
      // discriminated on `phase`:
      //
      //   phase: "field"    — single field just landed; detail.value
      //                        is already painted into matching
      //                        [name="..."] inputs by handle-agent-
      //                        command. Subscribe if you want progress.
      //   phase: "complete" — final TaskGroup payload; detail.result
      //                        is the full DataCollectionResult.
      //
      // One event name, two phases. Host pages typically only listen
      // for phase: "complete" and ship the payload to their backend.
      onDataMessage: (msg) => {
        const cmd = msg as Record<string, unknown>;
        const handled = handleAgentCommand(cmd, {
          capabilities: this._capabilities,
          onTaskFieldUpdated: (detail) => {
            this.dispatchEvent(
              new CustomEvent("ll-collected", {
                bubbles: true,
                composed: true,
                detail: { phase: "field", ...detail },
              }),
            );
          },
          onTaskCompleted: (detail) => {
            this.dispatchEvent(
              new CustomEvent("ll-collected", {
                bubbles: true,
                composed: true,
                detail: { phase: "complete", ...detail },
              }),
            );
          },
        });
        if (handled) {
          // Also dispatch a custom event for host observability — same
          // pattern as emit_event but for universal commands.
          if (typeof cmd.type === "string") {
            this.dispatchEvent(
              new CustomEvent(`ll-${cmd.type.replace(/_/g, "-")}`, {
                bubbles: true,
                composed: true,
                detail: cmd,
              }),
            );
          }
        }
      },
      onResumabilityChange: (canResume) => {
        this._canResume = canResume;
        // Re-render the connection UI so "Restart session" swaps in on the
        // next disconnect without waiting for a state change.
        const statusEl = contentEl.querySelector(".ll-status");
        if (statusEl && statusEl.textContent === "Disconnected") {
          statusEl.textContent = canResume ? "Paused — pick up where you left off" : "Disconnected";
        }
      },
    };

    return new LiveKitSession(
      { agentId, baseUrl: this._baseUrl, apiKey: this._apiKey || undefined },
      callbacks
    );
  }

  private _updateConnectionUI(state: ConnectionState, contentEl: HTMLElement): void {
    const statusEl = contentEl.querySelector(".ll-status");
    const connectBtn = contentEl.querySelector(".ll-connect-btn") as HTMLButtonElement | null;
    const disconnectBtn = contentEl.querySelector(".ll-disconnect-btn") as HTMLButtonElement | null;

    // When disconnected with a still-valid prior session, lean into the
    // "pick up where you left off" affordance instead of plain reconnect.
    const canResume = this._canResume && this._session?.canResume() === true;

    if (statusEl) {
      statusEl.textContent =
        state === "connecting" ? "Connecting..."
          : state === "connected" ? ""
          : state === "error" ? "Connection failed"
          : state === "disconnected"
            ? (canResume ? "Paused — pick up where you left off" : "Disconnected")
            : "";
    }

    if (connectBtn) {
      connectBtn.hidden = state === "connecting" || state === "connected";
      connectBtn.textContent = canResume && (state === "disconnected" || state === "error")
        ? "Restart session"
        : "Connect";
    }
    if (disconnectBtn) {
      disconnectBtn.hidden = state !== "connected";
    }
  }

  private _updateAgentStateUI(state: AgentState): void {
    const indicator = this._shadowRoot.querySelector(".ll-agent-indicator");
    if (indicator) {
      indicator.textContent =
        state === "listening" ? "Listening"
          : state === "thinking" ? "Thinking..."
          : state === "speaking" ? "Speaking"
          : "";
    }
  }

  private _updateTranscriptUI(entries: TranscriptEntry[], contentEl: HTMLElement): void {
    // Two-pill captions: latest user STT in one pill, latest agent
    // caption in another (with the orange "from Live Layer" glow).
    // Mirrors the React widget so script-tag and iframe embeds read
    // identically — both speakers visible at once, no swap.
    const agentEl = contentEl.querySelector<HTMLElement>(
      ".ll-transcript[data-role='agent']",
    );
    const userEl = contentEl.querySelector<HTMLElement>(
      ".ll-transcript[data-role='user']",
    );
    if (!agentEl && !userEl) return;
    let latestAgent: TranscriptEntry | null = null;
    let latestUser: TranscriptEntry | null = null;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (!latestAgent && e.role === "agent") latestAgent = e;
      else if (!latestUser && e.role === "user") latestUser = e;
      if (latestAgent && latestUser) break;
    }
    if (agentEl) {
      if (latestAgent) {
        agentEl.textContent = latestAgent.text;
        agentEl.hidden = false;
      } else {
        agentEl.hidden = true;
      }
    }
    if (userEl) {
      if (latestUser) {
        userEl.textContent = latestUser.text;
        userEl.hidden = false;
      } else {
        userEl.hidden = true;
      }
    }
  }

  private _renderWidgetMode(
    agentId: string,
    wc: NonNullable<PublishedAgentConfig["widgetConfig"]>,
  ): void {
    const rendererConfig: WidgetRendererConfig = {
      mediaType: wc.mediaType,
      position: wc.position,
      colors: wc.colors,
      toggles: {
        allowCamera: wc.video?.allowCamera ?? true,
        allowScreenShare: wc.video?.allowScreenShare ?? true,
        allowMic: true,
        allowTyping: wc.video?.allowTyping ?? true,
      },
    };

    const { contentEl, connectBtn, disconnectBtn } = renderWidget(this._shadowRoot, rendererConfig, () => {
      clearSession(agentId);
    });

    const session = this._createSession(agentId, contentEl);
    this._session = session;

    connectBtn.addEventListener("click", () => session.connect());
    disconnectBtn.addEventListener("click", () => session.disconnect());
  }

  private _renderEmbeddedMode(
    agentId: string,
    ec: NonNullable<PublishedAgentConfig["embeddedConfig"]>,
  ): void {
    const rendererConfig: EmbeddedRendererConfig = {
      mediaType: ec.mediaType,
      container: ec.container,
      colors: ec.colors,
      toggles: {
        allowCamera: ec.video?.allowCamera ?? true,
        allowScreenShare: ec.video?.allowScreenShare ?? true,
        allowMic: true,
        allowTyping: ec.video?.allowTyping ?? true,
      },
    };

    const { contentEl, connectBtn, disconnectBtn } = renderEmbedded(this._shadowRoot, rendererConfig);

    const session = this._createSession(agentId, contentEl);
    this._session = session;

    connectBtn.addEventListener("click", () => session.connect());
    disconnectBtn.addEventListener("click", () => session.disconnect());
  }

  private _renderError(message: string): void {
    const style = document.createElement("style");
    style.textContent = `
      .ll-error {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        color: #ef4444;
        font-size: 13px;
        padding: 12px;
      }
    `;
    const div = document.createElement("div");
    div.className = "ll-error";
    div.textContent = message;
    this._shadowRoot.appendChild(style);
    this._shadowRoot.appendChild(div);
  }
}

// ── Register ─────────────────────────────────────────────────────────

if (typeof customElements !== "undefined" && !customElements.get(LiveLayerWidget.TAG_NAME)) {
  customElements.define(LiveLayerWidget.TAG_NAME, LiveLayerWidget);
}

export { LiveLayerWidget };
export default LiveLayerWidget;
