// ─── Event Bridge ────────────────────────────────────────────────────
// Listens for emit_event AgentCommands on the LiveKit data channel and
// re-dispatches them as CustomEvents on the widget element AND as
// window.postMessage for cross-origin iframe consumers.

/**
 * Sanitize a string by stripping HTML tags to prevent XSS when
 * payloads are rendered by the host page.
 */
export function sanitize(input: unknown): unknown {
  if (typeof input === "string") {
    return input.replace(/<[^>]*>/g, "");
  }
  if (Array.isArray(input)) {
    return input.map(sanitize);
  }
  if (input !== null && typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = sanitize(v);
    }
    return out;
  }
  return input;
}

export interface AgentEvent {
  eventName: string;
  data: Record<string, unknown>;
}

/**
 * Dispatch an agent event to the host page via two channels:
 * 1. CustomEvent on the widget element ("agent-event")
 * 2. window.postMessage with source: "livelayer"
 */
export function dispatchAgentEvent(
  element: HTMLElement,
  event: AgentEvent,
): void {
  const sanitized = sanitize(event) as AgentEvent;

  // 1. CustomEvent on the element
  try {
    element.dispatchEvent(
      new CustomEvent("agent-event", {
        bubbles: true,
        composed: true, // crosses Shadow DOM boundary
        detail: sanitized,
      }),
    );
  } catch (err) {
    // CSP may block CustomEvent construction in restrictive environments
    if (err instanceof DOMException && err.name === "SecurityError") {
      console.warn("[LiveLayer] CSP blocked CustomEvent dispatch:", err.message);
    } else {
      throw err;
    }
  }

  // 2. window.postMessage for cross-origin consumers
  try {
    window.postMessage(
      { source: "livelayer", payload: sanitized },
      "*",
    );
  } catch (err) {
    if (err instanceof DOMException && err.name === "SecurityError") {
      console.warn("[LiveLayer] CSP blocked postMessage:", err.message);
    } else {
      throw err;
    }
  }
}

/**
 * Parse a raw data channel message into an AgentEvent if it is an
 * emit_event command. Returns null for other message types.
 */
export function parseDataChannelMessage(
  raw: string | ArrayBuffer,
): AgentEvent | null {
  try {
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    const parsed = JSON.parse(text);

    if (parsed?.type === "emit_event" && typeof parsed.eventName === "string") {
      return {
        eventName: parsed.eventName,
        data: parsed.data ?? {},
      };
    }
    return null;
  } catch {
    return null;
  }
}
