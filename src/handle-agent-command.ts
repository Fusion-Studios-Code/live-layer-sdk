// ─── handleAgentCommand ───────────────────────────────────────────────
// Shared command handler used by BOTH @livelayer/react's <AvatarWidget>
// AND the @livelayer/sdk's <livelayer-widget> web component. Keeps
// behavior parity: a fix here lands in both integration modes at once.
//
// Scope (0.5.0):
//   - navigate           — anchor click → pushState fallback
//   - scroll_page        — viewport-relative window scroll
//   - scroll_to          — scrollIntoView on a selector
//   - click              — querySelector(selector).click()
//
// NOT in this util (currently NPM-package-only via AvatarWidget):
//   - fill_form, focus_field, submit_form, request_page_context,
//     request_routes — these involve React-controlled state and DOM
//     walks that are easier to express in the React component. Future
//     0.5+ versions will port.
//
// Design rule: zero React imports. Pure DOM API only. Browser-safe.

export type AgentCapability =
  | "navigate"
  | "scroll"
  | "click"
  | "fill_forms"
  | "submit_forms"
  | "read_page"
  | "collect_data";

/**
 * Single-field update fired by the agent's data-collection TaskGroup
 * each time it records a value. Host pages typically paint the value
 * into a matching form field for live feedback.
 */
export interface TaskFieldUpdatedDetail {
  fieldId: string;
  fieldName: string;
  value: string;
  kind: string;
  source: "agent" | "slide" | "page";
  slideId?: string;
  /**
   * Set when the field belongs to a specific on-page form (i.e. the
   * agent ran `collect_from_page` against an auto-discovered form).
   * Lets the SDK paint into the right scoped input even when multiple
   * forms on the page have the same field name.
   */
  formId?: string;
}

/** Final TaskGroup completion payload. Mirrors `DataCollectionResult`. */
export interface TaskCompletedDetail {
  result: {
    sessionId: string;
    startedAt: string;
    endedAt: string;
    source: "agent" | "slide" | "page";
    slideId?: string;
    /** Set when `source: "page"` — the on-page form id the result targets. */
    formId?: string;
    results: Record<
      string,
      { fieldId: string; fieldName: string; value: string; kind: string }
    >;
    summary?: string;
  };
}

export interface HandleAgentCommandConfig {
  /** Capability allowlist; undefined = everything enabled. */
  capabilities?: AgentCapability[];
  /** Override navigate. Receives the requested href. */
  onNavigate?: (href: string) => void;
  /** Override scroll_page. */
  onScrollPage?: (
    direction: "up" | "down" | "top" | "bottom",
    behavior?: "smooth" | "instant",
  ) => void;
  /** Override scroll_to. */
  onScrollToSelector?: (
    selector: string,
    behavior?: "smooth" | "instant",
  ) => void;
  /** Override click. */
  onClick?: (selector: string) => void;
  /**
   * Fires for every `task_field_updated` command the agent emits while
   * walking a TaskGroup. The handler also auto-paints the value into
   * any matching `[data-ll-task-field="<fieldName>"]` element on the
   * host page (or, when source = "slide", into the slide form_field).
   */
  onTaskFieldUpdated?: (detail: TaskFieldUpdatedDetail) => void;
  /** Fires once when a `task_completed` command is received. */
  onTaskCompleted?: (detail: TaskCompletedDetail) => void;
}

interface CommandShape {
  type?: unknown;
  href?: unknown;
  selector?: unknown;
  direction?: unknown;
  behavior?: unknown;
}

const KNOWN_TYPES = new Set([
  "navigate",
  "scroll_page",
  "scroll_to",
  "click",
  "task_field_updated",
  "task_completed",
]);

function isAllowed(
  capabilities: AgentCapability[] | undefined,
  cap: AgentCapability,
): boolean {
  if (!capabilities) return true;
  return capabilities.includes(cap);
}

function blockedWarn(cmdType: string, cap: string) {
  console.warn(
    `[LiveLayer] Agent command "${cmdType}" blocked — capability "${cap}" not in allowlist. ` +
      "See https://livelayer.studio/docs/react/capabilities",
  );
}

/**
 * Handle a single agent command. Returns true if the command was
 * known and handled (or known-and-blocked), false if it's an unknown
 * command type the caller should forward elsewhere.
 */
export function handleAgentCommand(
  cmd: CommandShape,
  config: HandleAgentCommandConfig,
): boolean {
  if (typeof cmd.type !== "string") return false;
  if (!KNOWN_TYPES.has(cmd.type)) return false;

  const { capabilities } = config;

  if (cmd.type === "navigate") {
    if (!isAllowed(capabilities, "navigate")) {
      blockedWarn("navigate", "navigate");
      return true;
    }
    const href = typeof cmd.href === "string" ? cmd.href : "";
    if (!href) {
      console.warn(
        '[LiveLayer] Agent emitted "navigate" without href. Skipping. ' +
          "See https://livelayer.studio/docs/errors/navigate-missing-href",
      );
      return true;
    }
    if (config.onNavigate) {
      try {
        config.onNavigate(href);
      } catch (err) {
        console.warn(
          `[LiveLayer] onNavigate threw for "${href}". Falling back.`,
          err,
        );
      }
      return true;
    }
    if (typeof document !== "undefined") {
      const safe = href.replace(/"/g, '\\"');
      const anchor = document.querySelector<HTMLAnchorElement>(
        `a[href="${safe}"]`,
      );
      if (anchor) {
        anchor.click();
        return true;
      }
    }
    if (typeof window !== "undefined" && typeof history !== "undefined") {
      try {
        history.pushState({}, "", href);
        window.dispatchEvent(new PopStateEvent("popstate"));
      } catch (err) {
        console.warn(
          `[LiveLayer] history.pushState fallback failed for "${href}".`,
          err,
        );
      }
    }
    return true;
  }

  if (cmd.type === "scroll_page") {
    if (!isAllowed(capabilities, "scroll")) {
      blockedWarn("scroll_page", "scroll");
      return true;
    }
    const direction = cmd.direction;
    if (
      direction !== "up" &&
      direction !== "down" &&
      direction !== "top" &&
      direction !== "bottom"
    ) {
      console.warn(
        `[LiveLayer] scroll_page: invalid direction "${String(direction)}".`,
      );
      return true;
    }
    const behavior = cmd.behavior === "instant" ? "instant" : "smooth";
    if (config.onScrollPage) {
      try {
        config.onScrollPage(
          direction as "up" | "down" | "top" | "bottom",
          behavior as "smooth" | "instant",
        );
      } catch (err) {
        console.warn("[LiveLayer] onScrollPage threw.", err);
      }
      return true;
    }
    if (typeof window === "undefined") return true;
    const opts: ScrollToOptions = { behavior: behavior as ScrollBehavior };
    if (direction === "up") {
      window.scrollBy({ top: -window.innerHeight, ...opts });
    } else if (direction === "down") {
      window.scrollBy({ top: window.innerHeight, ...opts });
    } else if (direction === "top") {
      window.scrollTo({ top: 0, ...opts });
    } else {
      window.scrollTo({ top: document.body.scrollHeight, ...opts });
    }
    return true;
  }

  if (cmd.type === "scroll_to") {
    if (!isAllowed(capabilities, "scroll")) {
      blockedWarn("scroll_to", "scroll");
      return true;
    }
    const selector = typeof cmd.selector === "string" ? cmd.selector : "";
    if (!selector) return true;
    const behavior = cmd.behavior === "instant" ? "instant" : "smooth";
    if (config.onScrollToSelector) {
      try {
        config.onScrollToSelector(
          selector,
          behavior as "smooth" | "instant",
        );
      } catch (err) {
        console.warn("[LiveLayer] onScrollToSelector threw.", err);
      }
      return true;
    }
    if (typeof document === "undefined") return true;
    let el: Element | null = null;
    try {
      el = document.querySelector(selector);
    } catch {
      console.warn(
        `[LiveLayer] scroll_to: invalid selector "${selector}".`,
      );
      return true;
    }
    if (!el) {
      console.warn(
        `[LiveLayer] scroll_to: no element matched "${selector}".`,
      );
      return true;
    }
    el.scrollIntoView({
      behavior: behavior as ScrollBehavior,
      block: "start",
    });
    return true;
  }

  if (cmd.type === "task_field_updated") {
    if (!isAllowed(capabilities, "collect_data")) {
      blockedWarn("task_field_updated", "collect_data");
      return true;
    }
    const raw = cmd as Record<string, unknown>;
    const detail: TaskFieldUpdatedDetail = {
      fieldId: String(raw.fieldId ?? ""),
      fieldName: String(raw.fieldName ?? raw.fieldId ?? ""),
      value: typeof raw.value === "string" ? raw.value : "",
      kind: typeof raw.kind === "string" ? raw.kind : "text",
      source: raw.source === "slide" ? "slide" : "agent",
      ...(typeof raw.slideId === "string" ? { slideId: raw.slideId } : {}),
    };
    if (!detail.fieldId) return true;

    // Auto-paint into the matching form input(s). The unified API
    // looks up inputs by their plain HTML `name` attribute — no
    // separate `data-ll-task-field` tagging. Two queries:
    //
    //   1. `[name="<fieldName>"]` scoped to the matching form when
    //      the agent included `formId` (typical for collect_from_page
    //      flows over a specific on-page form), OR
    //   2. `[name="<fieldName>"]` document-wide otherwise.
    //
    // Multiple matches paint identically — same name on multiple
    // forms (e.g. signup + footer) is rare but valid; the agent owns
    // one piece of data per field name so they should mirror.
    if (typeof document !== "undefined" && detail.source === "agent") {
      const safeName = (detail.fieldName || detail.fieldId).replace(/"/g, '\\"');
      const formId = (cmd as Record<string, unknown>).formId;
      let scope: ParentNode = document;
      if (typeof formId === "string" && formId) {
        const safeFormId = formId.replace(/"/g, '\\"');
        const form =
          document.querySelector<HTMLFormElement>(`form#${CSS.escape(formId)}`) ||
          document.querySelector<HTMLFormElement>(`form[name="${safeFormId}"]`);
        if (form) scope = form;
      }
      const targets = scope.querySelectorAll<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      >(`[name="${safeName}"]`);
      targets.forEach((el) => {
        try {
          // Skip password / cc-* / data-ll-private as a defense in
          // depth — the agent shouldn't be sending us those, but if
          // it does, refuse to write into them.
          if (el.closest('[data-ll-private="true"], [data-ll-skip], .ll-widget')) return;
          if (el instanceof HTMLInputElement) {
            if (el.type === "password") return;
            const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
            if (ac === "off" || ac.startsWith("cc-")) return;
          }
          (el as HTMLInputElement).value = detail.value;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        } catch {
          /* swallow — best effort */
        }
      });
    }

    try {
      config.onTaskFieldUpdated?.(detail);
    } catch (err) {
      console.warn("[LiveLayer] onTaskFieldUpdated threw.", err);
    }
    return true;
  }

  if (cmd.type === "task_completed") {
    if (!isAllowed(capabilities, "collect_data")) {
      blockedWarn("task_completed", "collect_data");
      return true;
    }
    const raw = (cmd as Record<string, unknown>).result;
    if (!raw || typeof raw !== "object") {
      console.warn("[LiveLayer] task_completed missing `result` payload.");
      return true;
    }
    try {
      config.onTaskCompleted?.({
        result: raw as TaskCompletedDetail["result"],
      });
    } catch (err) {
      console.warn("[LiveLayer] onTaskCompleted threw.", err);
    }
    return true;
  }

  if (cmd.type === "click") {
    if (!isAllowed(capabilities, "click")) {
      blockedWarn("click", "click");
      return true;
    }
    const selector = typeof cmd.selector === "string" ? cmd.selector : "";
    if (!selector) {
      console.warn("[LiveLayer] click: missing selector.");
      return true;
    }
    if (config.onClick) {
      try {
        config.onClick(selector);
      } catch (err) {
        console.warn("[LiveLayer] onClick threw.", err);
      }
      return true;
    }
    if (typeof document === "undefined") return true;
    let el: Element | null = null;
    try {
      el = document.querySelector(selector);
    } catch {
      console.warn(
        `[LiveLayer] click: invalid selector "${selector}".`,
      );
      return true;
    }
    if (!el) {
      console.warn(
        `[LiveLayer] click: no element matched "${selector}".`,
      );
      return true;
    }
    if (el.closest('[data-ll-private="true"], .ll-widget')) {
      console.warn(
        "[LiveLayer] click: refusing to click element inside a private subtree.",
      );
      return true;
    }
    (el as HTMLElement).click?.();
    return true;
  }

  return false;
}
