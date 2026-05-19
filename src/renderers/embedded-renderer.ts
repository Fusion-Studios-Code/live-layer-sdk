// ─── Embedded Renderer ───────────────────────────────────────────────
// Inline container (no floating bubble). Respects embeddedConfig.container
// sizing. Contains video container, transcript, connect/disconnect.
// LiveKit session wired by the parent widget.

export interface EmbeddedRendererConfig {
  mediaType: "video" | "audio" | "chat";
  container: {
    width: string;
    height: string;
    responsive: boolean;
  };
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

export interface EmbeddedRendererResult {
  contentEl: HTMLElement;
  connectBtn: HTMLButtonElement;
  disconnectBtn: HTMLButtonElement;
}

function buildStyles(config: EmbeddedRendererConfig): string {
  const responsive = config.container.responsive
    ? "max-width: 100%; max-height: 100%;"
    : "";
  return `
    :host {
      --ll-border: ${config.colors.border ?? "#e5e7eb"};
      --ll-agent-color: ${config.colors.agentColor ?? "#6366f1"};
      --ll-bg: ${config.colors.backgroundColor ?? "#ffffff"};
      --ll-message: ${config.colors.messageColor ?? "#1f2937"};
      display: block;
    }
    .ll-embedded {
      width: ${config.container.width};
      height: ${config.container.height};
      ${responsive}
      border-radius: 12px;
      background: var(--ll-bg);
      border: 1px solid var(--ll-border);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
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
      min-height: 150px;
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
       .ll-expanded__transcript--agent so embedded iframes read
       identically across surfaces. User STT keeps default (no glow). */
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

export function renderEmbedded(
  shadowRoot: ShadowRoot,
  config: EmbeddedRendererConfig,
): EmbeddedRendererResult {
  const style = document.createElement("style");
  style.textContent = buildStyles(config);
  shadowRoot.appendChild(style);

  const wrapper = document.createElement("div");
  wrapper.className = "ll-embedded";

  // Header
  const header = document.createElement("div");
  header.className = "ll-header";
  header.innerHTML = `<span>LiveLayer Agent</span>`;
  wrapper.appendChild(header);

  // Content area
  const content = document.createElement("div");
  content.className = "ll-content";

  // Video container
  const videoContainer = document.createElement("div");
  videoContainer.className = "ll-video-container";

  const agentIndicator = document.createElement("div");
  agentIndicator.className = "ll-agent-indicator";
  videoContainer.appendChild(agentIndicator);

  content.appendChild(videoContainer);

  // Transcript — two pills, agent caption (orange glow) on top, user
  // STT below. Both stay in the DOM and toggle visibility based on their
  // slot. Mirrors the React widget so iframe embeds read identically.
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

  // Status
  const status = document.createElement("div");
  status.className = "ll-status";
  content.appendChild(status);

  wrapper.appendChild(content);

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

  wrapper.appendChild(controls);
  shadowRoot.appendChild(wrapper);

  return { contentEl: content, connectBtn, disconnectBtn };
}
