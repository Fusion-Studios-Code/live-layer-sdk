// ─── Manifest transport ──────────────────────────────────────────────
//
// Publishes the field manifest to the agent via the SAME mechanism
// the live-layer monorepo's existing AgentContextProvider uses: a
// participant attribute named `agent.context` whose value is a
// JSON-serialized PageContext.
//
// Why the existing attribute path instead of a new data message:
//   - The agent worker's v0.2.4.2 [user_edit] sync block already
//     parses `agent.context`, walks PageContext.elements, writes
//     values into executor.collectedData, and rebuilds the prompt.
//     Zero agent-side changes needed.
//   - LiveKit attributes are reliable + ordered + capped at 16KB
//     per attribute — plenty for a couple dozen form fields.
//
// Debounce so React render bursts (every keystroke fires `input`)
// don't spam the data channel. 200ms matches the existing
// AgentContextProvider debounce window in the dashboard.

import type { ManifestPageContext, FieldManifest } from "./types";

const CONTEXT_ATTRIBUTE_KEY = "agent.context";
const WARN_SIZE_BYTES = 12 * 1024;

/** Minimal LiveKit Room shape we depend on. Kept structural so tests
 * can pass a stub without pulling livekit-client. */
export interface RoomLike {
  localParticipant: {
    setAttributes(attrs: Record<string, string>): Promise<void>;
  };
}

export interface TransportOptions {
  room: RoomLike;
  /** ms to debounce. Default 200. */
  debounceMs?: number;
  /**
   * Called when serialization fails (>16KB attribute). Caller can
   * trim fields, log, or fall back to a data message. Default: warn.
   */
  onOverflow?: (sizeBytes: number) => void;
}

export class ManifestTransport {
  private room: RoomLike;
  private debounceMs: number;
  private onOverflow: (sizeBytes: number) => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: ManifestPageContext | null = null;
  private destroyed = false;
  private encoder = new TextEncoder();

  constructor(opts: TransportOptions) {
    this.room = opts.room;
    this.debounceMs = opts.debounceMs ?? 200;
    this.onOverflow =
      opts.onOverflow ??
      ((size) => {
        // eslint-disable-next-line no-console
        console.warn(
          `[LiveLayer] manifest is ${size} bytes — approaching the 16KB LiveKit attribute limit. ` +
            "Consider reducing the number of tracked fields or adding data-ll-private to noisy ones.",
        );
      });
  }

  /** Schedule a publish. Coalesces multiple calls within the debounce window. */
  publish(context: ManifestPageContext): void {
    if (this.destroyed) return;
    this.pending = context;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.debounceMs);
  }

  /** Force-flush the pending context immediately (used on disconnect). */
  async flush(): Promise<void> {
    if (this.destroyed) return;
    if (!this.pending) return;
    const ctx = this.pending;
    this.pending = null;
    const json = JSON.stringify(ctx);
    const size = this.encoder.encode(json).byteLength;
    if (size > WARN_SIZE_BYTES) this.onOverflow(size);
    try {
      await this.room.localParticipant.setAttributes({
        [CONTEXT_ATTRIBUTE_KEY]: json,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[LiveLayer] manifest publish failed:", err);
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }
}

// ─── PageContext builder ──────────────────────────────────────────────

/**
 * Build the PageContext envelope from the current manifest. Pure
 * function so tests can verify the wire shape without touching a Room.
 */
export function buildPageContext(
  fields: FieldManifest[],
  doc: Document = document,
): ManifestPageContext {
  return {
    route: doc.location?.pathname ?? "/",
    step: 0,
    stepLabel: doc.title || "Page",
    elements: fields,
    availableActions: [],
    title: doc.title || "Page",
  };
}
