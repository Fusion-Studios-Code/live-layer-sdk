// ─── page-tools ──────────────────────────────────────────────────────
// The client half of the worker's page tools (live-layer
// agent/lib/tools/navigation-tools.ts). Three requests wait for an
// answer, matched by the echoed `requestId`:
//
//   request_page_context → page_context            (worker waits 2 s)
//   request_routes       → routes                  (worker waits 2 s)
//   submit_form          → form_submitted
//                        | form_submit_blocked
//                        | form_submit_uncertain   (worker waits 6 s)
//
// and two act without one: fill_form, focus_field.
//
// Every reply goes out reliable, with no topic, and fits one LiveKit
// data packet (see data-payload.ts). Only commands that LiveKitSession
// accepted from the agent participant reach this module (the 0.9 trust
// boundary); it never acts on anything else.
//
// Capabilities: when the host's allowlist leaves out read_page or
// submit_forms, the request is still answered, with a refusal the agent
// can relay instead of a 2 s / 6 s silence:
//
//   { error: "capability_blocked", capability, message, ...the normal reply shape }
//
//   page_context: the refusal is repeated inside `context`, because the
//                 worker hands `context` to the LLM verbatim.
//   routes:       `routes: []` (the worker shows the LLM only the list,
//                 so this refusal is not visible there yet).
//   submit:       type form_submit_blocked, reason "capability_blocked",
//                 and the message as the one invalidFields entry, which
//                 the worker does print ("Invalid field(s): …").
//
// The behaviour is ported from @livelayer/react 0.26.0's AvatarWidget
// (github.com/Fusion-Studios-Code/live-layer-react @ a0ac539); see each
// helper module for what differs.

import {
  encodePageContextReply,
  encodeRoutesReply,
  publishJsonReliable,
  publishReliable,
  type DataPublisher,
} from "./data-payload";
import { findFillableFieldInForm, findFormByLooseId, fillField } from "./forms";
import { getCachedPageContext, type PageContext } from "./page-context";
import { getCachedRoutes } from "./routes";
import { submitForm } from "./submit-form";

export type { DataPublisher } from "./data-payload";

/** Request / command types this module handles. */
export const PAGE_COMMAND_TYPES = [
  "request_page_context",
  "request_routes",
  "submit_form",
  "fill_form",
  "focus_field",
] as const;

/** `error` value of a reply refused because of the host's capability allowlist. */
export const CAPABILITY_BLOCKED = "capability_blocked";

export const READ_PAGE_BLOCKED_MESSAGE =
  "Reading the page is turned off on this site (its widget leaves out the read_page capability), so you can't see the visitor's screen or list its links. " +
  "Don't call get_page_context or get_routes again; answer from what you already know or ask the visitor.";

export const ROUTES_BLOCKED_MESSAGE =
  "Reading the page is turned off on this site (its widget leaves out the read_page capability), so you can't list its links. " +
  "Don't call get_routes or get_page_context again; use a route from your instructions if one fits, otherwise ask the visitor.";

export const SUBMIT_BLOCKED_MESSAGE =
  "Submitting forms is turned off on this site (its widget leaves out the submit_forms capability), so nothing was sent. " +
  "Don't call submit_form again; tell the visitor you can't send it for them and ask them to press the form's own submit button.";

export interface PageCommandConfig {
  /** Whether a capability is allowed by the host's allowlist. */
  isAllowed: (cap: "read_page" | "fill_forms" | "submit_forms") => boolean;
  /**
   * Where replies go: the local participant of the room the request
   * arrived on. Null when the room is already gone; the request is then
   * dropped with a warning.
   */
  publisher: DataPublisher | null | undefined;
  /** Logs a blocked command (the shared "[LiveLayer] … blocked" warning). */
  warnBlocked: (cmdType: string, cap: string) => void;
}

function refusal(capability: string, message: string) {
  return { error: CAPABILITY_BLOCKED, capability, message };
}

function emptyContext(): PageContext {
  return {
    url: "",
    title: "",
    pathname: "/",
    regions: [],
    visibleText: "",
    visibleLinks: [],
    visibleFields: [],
    forms: [],
  };
}

/**
 * Handle one page command. Returns false for a type this module does
 * not own.
 */
export function handlePageCommand(
  cmd: Record<string, unknown>,
  config: PageCommandConfig,
): boolean {
  const type = cmd.type;
  if (typeof type !== "string" || !(PAGE_COMMAND_TYPES as readonly string[]).includes(type)) {
    return false;
  }
  const { publisher, isAllowed, warnBlocked } = config;
  const requestId = typeof cmd.requestId === "string" ? cmd.requestId : undefined;
  const withRequestId = (msg: Record<string, unknown>) => (requestId ? { ...msg, requestId } : msg);
  const warnNoRoom = () =>
    console.warn(`[LiveLayer] ${type}: not connected, so the reply was not sent.`);
  const send = (msg: Record<string, unknown>) => {
    if (!publisher) return warnNoRoom();
    void publishJsonReliable(publisher, withRequestId(msg), type);
  };

  if (type === "request_page_context") {
    if (!isAllowed("read_page")) {
      warnBlocked(type, "read_page");
      const r = refusal("read_page", READ_PAGE_BLOCKED_MESSAGE);
      send({ type: "page_context", ...r, context: r });
      return true;
    }
    if (!publisher) {
      warnNoRoom();
      return true;
    }
    let context: PageContext;
    try {
      context = getCachedPageContext();
    } catch (err) {
      console.warn("[LiveLayer] page-context extraction threw. Sending empty context.", err);
      context = emptyContext();
    }
    // Big forms can push a reply past LiveKit's 64,000-byte packet
    // limit; trim it rather than lose it.
    const encoded = encodePageContextReply(withRequestId({ type: "page_context", context }));
    if (!encoded) {
      console.warn(`[LiveLayer] ${type}: reply does not fit one data packet even after trimming. Not sent.`);
      return true;
    }
    if (encoded.truncated.length > 0) {
      console.warn(
        `[LiveLayer] ${type}: reply trimmed to fit the data-channel limit (cut: ${encoded.truncated.join(", ")}).`,
      );
    }
    void publishReliable(publisher, encoded.data, type);
    return true;
  }

  if (type === "request_routes") {
    if (!isAllowed("read_page")) {
      warnBlocked(type, "read_page");
      send({ type: "routes", ...refusal("read_page", ROUTES_BLOCKED_MESSAGE), routes: [] });
      return true;
    }
    if (!publisher) {
      warnNoRoom();
      return true;
    }
    let routes: unknown[] = [];
    try {
      routes = getCachedRoutes();
    } catch (err) {
      // React sends nothing here; an empty list answers the request
      // instead of leaving the worker to time out.
      console.warn(`[LiveLayer] ${type}: extracting routes threw. Sending an empty list.`, err);
    }
    const encoded = encodeRoutesReply(withRequestId({ type: "routes" }), routes);
    if (!encoded) {
      console.warn(`[LiveLayer] ${type}: reply does not fit one data packet. Not sent.`);
      return true;
    }
    if (encoded.dropped > 0) {
      console.warn(
        `[LiveLayer] ${type}: sent ${routes.length - encoded.dropped} of ${routes.length} routes to fit the data-channel limit.`,
      );
    }
    void publishReliable(publisher, encoded.data, type);
    return true;
  }

  const formId = typeof cmd.formId === "string" ? cmd.formId : "";

  if (type === "submit_form") {
    if (!isAllowed("submit_forms")) {
      warnBlocked(type, "submit_forms");
      send({
        type: "form_submit_blocked",
        formId,
        reason: CAPABILITY_BLOCKED,
        // The worker adds the final period.
        invalidFields: [SUBMIT_BLOCKED_MESSAGE.replace(/\.$/, "")],
        ...refusal("submit_forms", SUBMIT_BLOCKED_MESSAGE),
      });
      return true;
    }
    // React leaves these unanswered (the worker then waits out its 6 s);
    // answering says at once that nothing was submitted.
    if (!formId) {
      console.warn(`[LiveLayer] ${type}: missing formId.`);
      send({ type: "form_submit_blocked", formId, reason: "missing_form_id", invalidFields: [] });
      return true;
    }
    const form = typeof document !== "undefined" ? findFormByLooseId(document, formId) : null;
    if (!form) {
      console.warn(
        `[LiveLayer] ${type}: no <form> the agent may use matched id="${formId}" (or a matching name / data-ll-intent slug).`,
      );
      send({ type: "form_submit_blocked", formId, reason: "form_not_found", invalidFields: [] });
      return true;
    }
    submitForm(form, formId, send);
    return true;
  }

  // fill_form / focus_field: fire-and-forget, nothing is sent back.
  if (!isAllowed("fill_forms")) {
    warnBlocked(type, "fill_forms");
    return true;
  }
  if (typeof document === "undefined") return true;
  if (!formId) {
    console.warn(`[LiveLayer] ${type}: missing formId.`);
    return true;
  }
  const form = findFormByLooseId(document, formId);
  if (!form) {
    console.warn(
      `[LiveLayer] ${type}: no <form> the agent may use matched id="${formId}" (or a matching name / data-ll-intent slug). ` +
        "Forms are auto-discovered; the agent should use a PageContext.forms[].id.",
    );
    return true;
  }

  if (type === "focus_field") {
    const fieldName = typeof cmd.fieldName === "string" ? cmd.fieldName : "";
    if (!fieldName) {
      console.warn("[LiveLayer] focus_field: missing fieldName.");
      return true;
    }
    const resolved = findFillableFieldInForm(form, fieldName);
    if (resolved.el === null) {
      console.warn(
        resolved.reason === "private"
          ? `[LiveLayer] focus_field: field "${fieldName}" is privacy-protected and not focusable.`
          : `[LiveLayer] focus_field: no input matching key="${fieldName}" in form "${formId}".`,
      );
      return true;
    }
    resolved.el.focus();
    return true;
  }

  // fill_form
  const values =
    cmd.values && typeof cmd.values === "object" && !Array.isArray(cmd.values)
      ? (cmd.values as Record<string, unknown>)
      : null;
  if (!values) {
    console.warn("[LiveLayer] fill_form: missing or invalid values.");
    return true;
  }
  for (const [name, raw] of Object.entries(values)) {
    if (typeof raw !== "string") continue;
    const resolved = findFillableFieldInForm(form, name);
    if (resolved.el === null) {
      console.warn(
        resolved.reason === "private"
          ? `[LiveLayer] fill_form: field "${name}" is privacy-protected (password / cc-* / off / data-ll-private). Skipping.`
          : `[LiveLayer] fill_form: no input matching key="${name}" in form "${formId}". Skipping.`,
      );
      continue;
    }
    try {
      fillField(resolved.el, raw);
    } catch (err) {
      console.warn(`[LiveLayer] fill_form: failed to set "${name}".`, err);
    }
  }
  return true;
}
