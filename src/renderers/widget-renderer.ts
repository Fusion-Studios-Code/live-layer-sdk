// ─── Widget Renderer ─────────────────────────────────────────────────
// Floating bubble (bottom-right/left/center) that expands to a panel.
// Panel contains video container, transcript, connect/disconnect, and
// agent state indicator. LiveKit session wired by the parent widget.

export interface WidgetRendererConfig {
  mediaType: "video" | "audio" | "chat";
  position: "bottom-right" | "bottom-left" | "center";
  colors: {
    border?: string;
    agentColor?: string;
    backgroundColor?: string;
    messageColor?: string;
  };
  toggles: {
    allowCamera: boolean;
    allowScreenShare: boolean;
    allowMic: boolean;
    allowTyping: boolean;
  };
}

export interface WidgetRendererResult {
  expand: () => void;
  collapse: () => void;
  contentEl: HTMLElement;
  connectBtn: HTMLButtonElement;
  disconnectBtn: HTMLButtonElement;
}

const POSITION_STYLES: Record<string, string> = {
  "bottom-right": "right: 20px; bottom: 20px;",
  "bottom-left": "left: 20px; bottom: 20px;",
  "center": "left: 50%; bottom: 20px; transform: translateX(-50%);",
};

function buildStyles(config: WidgetRendererConfig): string {
  const pos = POSITION_STYLES[config.position] ?? POSITION_STYLES["bottom-right"];
  return `
    :host {
      --ll-border: ${config.colors.border ?? "#e5e7eb"};
      --ll-agent-color: ${config.colors.agentColor ?? "#6366f1"};
      --ll-bg: ${config.colors.backgroundColor ?? "#ffffff"};
      --ll-message: ${config.colors.messageColor ?? "#1f2937"};
    }
    .ll-bubble {
      position: fixed;
      ${pos}
      width: 60px;
      height: 60px;
      border-radius: 50%;
      background: var(--ll-agent-color);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      z-index: 2147483646;
      transition: transform 0.2s ease;
      border: none;
      padding: 0;
    }
    .ll-bubble:hover { transform: scale(1.08); }
    .ll-bubble svg { width: 28px; height: 28px; fill: #fff; }

    .ll-panel {
      position: fixed;
      ${pos}
      width: 380px;
      height: 560px;
      border-radius: 16px;
      background: var(--ll-bg);
      border: 1px solid var(--ll-border);
      box-shadow: 0 8px 30px rgba(0,0,0,0.12);
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .ll-panel[hidden] { display: none; }

    .ll-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      border-bottom: 1px solid var(--ll-border);
      color: var(--ll-message);
      font-weight: 600;
      font-size: 14px;
    }
    .ll-close {
      background: none;
      border: none;
      cursor: pointer;
      padding: 4px;
      color: var(--ll-message);
      font-size: 18px;
      line-height: 1;
    }

    .ll-content {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .ll-video-container {
      flex: 1;
      background: #f5f5f5;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 200px;
      position: relative;
    }

    .ll-agent-indicator {
      position: absolute;
      top: 8px;
      right: 8px;
      font-size: 11px;
      font-weight: 500;
      color: #fff;
      background: rgba(0,0,0,0.4);
      backdrop-filter: blur(8px);
      padding: 3px 10px;
      border-radius: 999px;
    }

    .ll-transcript-stack {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .ll-transcript {
      padding: 10px 16px;
      font-size: 13px;
      color: var(--ll-message);
      line-height: 1.4;
      min-height: 40px;
      max-height: 80px;
      overflow-y: auto;
      border-radius: 12px;
      border: 1px solid transparent;
      transition: background 220ms ease, box-shadow 220ms ease,
        border-color 220ms ease;
    }
    .ll-transcript[hidden] { display: none; }

    /* Captions affordance: orange glow when the latest transcript line
       is the agent's spoken output. Mirrors the React widget's
       .ll-expanded__transcript--agent so the script-tag and iframe
       embeds read identically. User STT keeps default (no glow). */
    .ll-transcript.ll-transcript--agent {
      background: rgba(255, 139, 61, 0.18);
      border-color: rgba(255, 175, 110, 0.45);
      box-shadow:
        0 0 18px rgba(255, 139, 61, 0.3),
        inset 0 0 0 1px rgba(255, 175, 110, 0.2);
    }

    @media (prefers-reduced-motion: reduce) {
      .ll-transcript {
        transition: none;
      }
    }

    .ll-status {
      text-align: center;
      font-size: 12px;
      color: #999;
      padding: 4px 0;
    }

    .ll-controls {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      padding: 12px 16px;
      border-top: 1px solid var(--ll-border);
    }

    .ll-connect-btn {
      width: 100%;
      padding: 10px 16px;
      font-size: 14px;
      font-weight: 500;
      color: #fff;
      background: var(--ll-agent-color);
      border: none;
      border-radius: 999px;
      cursor: pointer;
      transition: opacity 0.15s;
    }
    .ll-connect-btn:hover { opacity: 0.9; }
    .ll-connect-btn[hidden] { display: none; }

    .ll-disconnect-btn {
      width: 100%;
      padding: 10px 16px;
      font-size: 14px;
      font-weight: 500;
      color: #ef4444;
      background: transparent;
      border: 1px solid rgba(239,68,68,0.3);
      border-radius: 999px;
      cursor: pointer;
    }
    .ll-disconnect-btn[hidden] { display: none; }
  `;
}

const ICONS = {
  bubble: `<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>`,
};

export function renderWidget(
  shadowRoot: ShadowRoot,
  config: WidgetRendererConfig,
  onClose: () => void,
): WidgetRendererResult {
  const style = document.createElement("style");
  style.textContent = buildStyles(config);
  shadowRoot.appendChild(style);

  // Bubble
  const bubble = document.createElement("button");
  bubble.className = "ll-bubble";
  bubble.innerHTML = ICONS.bubble;
  bubble.setAttribute("aria-label", "Open Live Layer agent");
  shadowRoot.appendChild(bubble);

  // Panel
  const panel = document.createElement("div");
  panel.className = "ll-panel";
  panel.hidden = true;

  // Header
  const header = document.createElement("div");
  header.className = "ll-header";
  header.innerHTML = `<span>Live Layer</span>`;
  const closeBtn = document.createElement("button");
  closeBtn.className = "ll-close";
  closeBtn.innerHTML = "&times;";
  closeBtn.setAttribute("aria-label", "Close");
  header.appendChild(closeBtn);
  panel.appendChild(header);

  // Content area
  const content = document.createElement("div");
  content.className = "ll-content";

  // Video container (for LiveKit video tracks)
  const videoContainer = document.createElement("div");
  videoContainer.className = "ll-video-container";

  // Agent state indicator
  const agentIndicator = document.createElement("div");
  agentIndicator.className = "ll-agent-indicator";
  videoContainer.appendChild(agentIndicator);

  content.appendChild(videoContainer);

  // Transcript area — two pills, agent caption (orange glow) on top,
  // user STT below. Both stay in the DOM and toggle visibility based on
  // whether their slot has any text. This mirrors the React widget's
  // two-pill layout so the script-tag embed reads identically.
  const transcriptStack = document.createElement("div");
  transcriptStack.className = "ll-transcript-stack";
  const agentTranscript = document.createElement("div");
  agentTranscript.className = "ll-transcript ll-transcript--agent";
  agentTranscript.setAttribute("data-role", "agent");
  agentTranscript.hidden = true;
  const userTranscript = document.createElement("div");
  userTranscript.className = "ll-transcript ll-transcript--user";
  userTranscript.setAttribute("data-role", "user");
  userTranscript.hidden = true;
  transcriptStack.appendChild(agentTranscript);
  transcriptStack.appendChild(userTranscript);
  content.appendChild(transcriptStack);

  // Status line
  const status = document.createElement("div");
  status.className = "ll-status";
  content.appendChild(status);

  panel.appendChild(content);

  // Controls bar
  const controls = document.createElement("div");
  controls.className = "ll-controls";

  const connectBtn = document.createElement("button");
  connectBtn.className = "ll-connect-btn";
  connectBtn.textContent = "Start conversation";
  controls.appendChild(connectBtn);

  const disconnectBtn = document.createElement("button");
  disconnectBtn.className = "ll-disconnect-btn";
  disconnectBtn.textContent = "End conversation";
  disconnectBtn.hidden = true;
  controls.appendChild(disconnectBtn);

  panel.appendChild(controls);
  shadowRoot.appendChild(panel);

  // Interactions
  const expand = () => {
    bubble.hidden = true;
    panel.hidden = false;
  };
  const collapse = () => {
    panel.hidden = true;
    bubble.hidden = false;
  };

  bubble.addEventListener("click", expand);
  closeBtn.addEventListener("click", () => {
    collapse();
    onClose();
  });

  return { expand, collapse, contentEl: content, connectBtn, disconnectBtn };
}
