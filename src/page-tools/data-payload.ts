// ─── data-payload ────────────────────────────────────────────────────
// Keeps the widget's data-channel replies under LiveKit's message
// ceiling, and turns a failed publish into a console warning instead of
// an unhandled promise rejection.
//
// Ported from @livelayer/react 0.26.0, src/utils/dataPayload.ts
// (github.com/Fusion-Studios-Code/live-layer-react @ a0ac539). Same
// budgets, same shrink order, same `context.truncated` labels, so the
// agent sees identical replies from both widgets. Left out: the
// `pageContextExtras` cap and the "extras" shrink step, because the
// script-tag widget has no host extras to send.
//
// livekit-client 2.20+ refuses to send a data packet larger than the
// negotiated SCTP max message size, clamped to 64,000 B, and rejects
// publishData() with PublishDataError. The limit applies to the whole
// encoded DataPacket (payload plus sender identity, topic and framing),
// so the payload budget below leaves headroom for that envelope.

/** livekit-client's ceiling for one data packet (RTCEngine DEFAULT_MAX_MESSAGE_SIZE). */
export const LIVEKIT_MAX_DATA_PACKET_BYTES = 64_000;

/** Payload budget: the packet ceiling minus headroom for the DataPacket envelope. */
export const MAX_DATA_PAYLOAD_BYTES = 60_000;

/** visibleText is cut to this many bytes when a reply has to shrink. */
const SHRUNK_VISIBLE_TEXT_BYTES = 2_000;

const ELLIPSIS = "…";
const ELLIPSIS_BYTES = 3;

const encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON.stringify that returns undefined for cycles, BigInt and other throws. */
function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function tryEncode(value: unknown): Uint8Array | null {
  const json = safeStringify(value);
  return json === undefined ? null : encoder.encode(json);
}

/** Cut a string to at most `maxBytes` UTF-8 bytes, ending with an ellipsis. */
export function truncateToBytes(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  if (maxBytes < ELLIPSIS_BYTES) return "";
  // Decoding a prefix can split a multi-byte character; the decoder turns
  // the partial character into U+FFFD, which is dropped here.
  const prefix = new TextDecoder()
    .decode(bytes.subarray(0, maxBytes - ELLIPSIS_BYTES))
    .replace(/�+$/, "");
  return prefix + ELLIPSIS;
}

type FormsList = Array<Record<string, unknown>>;

function clearArray(ctx: Record<string, unknown>, key: string): boolean {
  const value = ctx[key];
  if (!Array.isArray(value) || value.length === 0) return false;
  ctx[key] = [];
  return true;
}

/**
 * Ways to shrink a page context, cheapest loss first. Each returns true
 * when it changed something. Forms come last because the agent needs
 * them for fill_form / submit_form; visibleFields repeats what forms
 * carry, and the agent can list pages with get_routes when visibleLinks
 * is cut.
 */
const SHRINK_STEPS: Array<{
  label: string;
  apply: (ctx: Record<string, unknown>) => boolean;
}> = [
  { label: "visibleLinks", apply: (ctx) => clearArray(ctx, "visibleLinks") },
  { label: "visibleFields", apply: (ctx) => clearArray(ctx, "visibleFields") },
  {
    label: "formOptions",
    apply: (ctx) => {
      if (!Array.isArray(ctx.forms)) return false;
      let changed = false;
      ctx.forms = (ctx.forms as FormsList).map((form) => {
        if (!isRecord(form) || !Array.isArray(form.fields)) return form;
        return {
          ...form,
          fields: (form.fields as unknown[]).map((field) => {
            if (!isRecord(field) || !("options" in field)) return field;
            changed = true;
            const { options: _dropped, ...rest } = field;
            return rest;
          }),
        };
      });
      return changed;
    },
  },
  {
    label: "visibleText",
    apply: (ctx) => {
      if (typeof ctx.visibleText !== "string") return false;
      const cut = truncateToBytes(ctx.visibleText, SHRUNK_VISIBLE_TEXT_BYTES);
      if (cut === ctx.visibleText) return false;
      ctx.visibleText = cut;
      return true;
    },
  },
  { label: "regions", apply: (ctx) => clearArray(ctx, "regions") },
];

function stringField(value: unknown, maxBytes: number, fallback = ""): string {
  return typeof value === "string" ? truncateToBytes(value, maxBytes) : fallback;
}

/**
 * Encode a `page_context` reply so it fits one data packet.
 *
 * If the reply is over `maxBytes`, it sheds sections in SHRINK_STEPS
 * order, then forms from the end of the list, and as a last resort sends
 * only the url, title and pathname. Whatever was cut is listed in
 * `context.truncated` so the agent knows the snapshot is partial. The
 * context passed in is never mutated (the walker caches it).
 *
 * Returns null only if not even the minimal reply fits.
 */
export function encodePageContextReply(
  reply: Record<string, unknown>,
  maxBytes: number = MAX_DATA_PAYLOAD_BYTES,
): { data: Uint8Array; truncated: string[] } | null {
  if (!isRecord(reply.context)) {
    const data = tryEncode(reply);
    return data && data.byteLength <= maxBytes ? { data, truncated: [] } : null;
  }

  const ctx: Record<string, unknown> = { ...reply.context };
  const truncated: string[] = [];
  const mark = (label: string) => {
    if (!truncated.includes(label)) truncated.push(label);
  };
  const attempt = () => {
    const context = truncated.length > 0 ? { ...ctx, truncated: [...truncated] } : ctx;
    const data = tryEncode({ ...reply, context });
    return data && data.byteLength <= maxBytes ? data : null;
  };

  let data = attempt();
  if (data) return { data, truncated };

  for (const step of SHRINK_STEPS) {
    if (!step.apply(ctx)) continue;
    mark(step.label);
    data = attempt();
    if (data) return { data, truncated };
  }

  if (Array.isArray(ctx.forms) && ctx.forms.length > 0) {
    mark("forms");
    const forms = [...(ctx.forms as unknown[])];
    while (forms.length > 0) {
      forms.pop();
      ctx.forms = [...forms];
      data = attempt();
      if (data) return { data, truncated };
    }
  }

  // Last resort: where the visitor is, and nothing else.
  mark("all");
  const minimal = {
    url: stringField(ctx.url, 2_000),
    title: stringField(ctx.title, 500),
    pathname: stringField(ctx.pathname, 2_000, "/"),
    regions: [],
    visibleText: "",
    visibleLinks: [],
    visibleFields: [],
    forms: [],
    truncated: [...truncated],
  };
  data = tryEncode({ ...reply, context: minimal });
  return data && data.byteLength <= maxBytes ? { data, truncated } : null;
}

/**
 * Encode a `routes` reply so it fits one data packet, keeping as many
 * routes from the front of the list as fit.
 */
export function encodeRoutesReply(
  reply: Record<string, unknown>,
  routes: unknown[],
  maxBytes: number = MAX_DATA_PAYLOAD_BYTES,
): { data: Uint8Array; dropped: number } | null {
  const encodeWith = (count: number) => {
    const data = tryEncode({ ...reply, routes: routes.slice(0, count) });
    return data && data.byteLength <= maxBytes ? data : null;
  };
  const full = encodeWith(routes.length);
  if (full) return { data: full, dropped: 0 };
  // Largest prefix that fits, by binary search.
  let lo = 0;
  let hi = routes.length - 1;
  let best = encodeWith(0);
  let bestCount = 0;
  if (!best) return null;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const data = encodeWith(mid);
    if (data) {
      best = data;
      bestCount = mid;
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return { data: best, dropped: routes.length - bestCount };
}

/** The slice of a LiveKit LocalParticipant this module needs. */
export interface DataPublisher {
  // Method syntax keeps the parameter bivariant, so livekit-client's
  // LocalParticipant (which takes a narrower Uint8Array) is assignable.
  publishData(data: Uint8Array, options: { reliable: boolean }): unknown;
}

/**
 * Publish bytes on the reliable data channel, with no topic, without
 * letting a failure escape as an unhandled rejection. Oversized payloads
 * are not sent (the client would reject them anyway). Resolves true when
 * the publish succeeded, false otherwise; never rejects.
 */
export function publishReliable(
  publisher: DataPublisher,
  data: Uint8Array,
  label: string,
): Promise<boolean> {
  if (data.byteLength > MAX_DATA_PAYLOAD_BYTES) {
    console.warn(
      `[LiveLayer] ${label}: payload is ${data.byteLength} bytes, over the ` +
        `${MAX_DATA_PAYLOAD_BYTES} byte data-channel budget. Not sent.`,
    );
    return Promise.resolve(false);
  }
  const failed = (err: unknown) => {
    console.warn(`[LiveLayer] ${label}: publishData failed.`, err);
    return false;
  };
  try {
    return Promise.resolve(publisher.publishData(data, { reliable: true })).then(
      () => true,
      failed,
    );
  } catch (err) {
    return Promise.resolve(failed(err));
  }
}

/** JSON-encode a message and publish it with {@link publishReliable}. */
export function publishJsonReliable(
  publisher: DataPublisher,
  message: Record<string, unknown>,
  label: string,
): Promise<boolean> {
  const data = tryEncode(message);
  if (!data) {
    console.warn(`[LiveLayer] ${label}: message could not be serialized. Not sent.`);
    return Promise.resolve(false);
  }
  return publishReliable(publisher, data, label);
}
