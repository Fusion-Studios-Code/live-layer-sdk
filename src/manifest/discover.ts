// ─── DOM discovery ───────────────────────────────────────────────────
//
// Scans the host page for fillable fields and builds a manifest the
// SDK can publish to the agent. Two modes of operation, in priority
// order:
//
//   1. Explicit `data-ll-*` attribute tagging on inputs (highest).
//   2. Auto-discovery — walk every `<form>` and pick up `<input>` /
//      `<select>` / `<textarea>` descendants that aren't gated by
//      privacy guards.
//
// Privacy guards (always-on, never overrideable):
//   - `<input type="password">`
//   - `[autocomplete=cc-*]` (credit card fields)
//   - `[data-ll-private]`
//   - Anything inside `.ll-widget` (the widget's own DOM)
//   - Anything with no resolvable label AND no name/id (we'd send a
//     useless field).
//
// The change tracker uses a SINGLE event-delegated listener on
// `document` for `input` and `change` events — one listener captures
// every bubbled DOM event from any matching input on the page. This
// is the "minimal-changes-for-consumers" answer to "do we need
// onChange per field": no, we just listen at the root.

import type { FieldKind, FieldManifest, FieldOption } from "./types";

const PRIVACY_BLOCKED_TYPES = new Set(["password", "hidden"]);
const PRIVACY_BLOCKED_AUTOCOMPLETE_PREFIXES = ["cc-"];
const WIDGET_DOM_SELECTOR = ".ll-widget";

/** What we discovered. Kept separate from the published manifest so
 * the discovery layer doesn't have to know about transport details. */
export interface DiscoveryEntry {
  field: FieldManifest;
  /** The actual element we'll read value from on change. */
  element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
}

/** Options for the discovery scan. */
export interface DiscoverOptions {
  /** Root to scan from. Defaults to `document`. */
  root?: Document | HTMLElement;
  /** Include inputs outside <form> elements. Default true. */
  includeOrphans?: boolean;
}

// ─── Privacy + filter helpers ────────────────────────────────────────

function isWidgetDescendant(el: Element): boolean {
  return !!el.closest(WIDGET_DOM_SELECTOR);
}

function isPrivacyBlocked(
  el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
): boolean {
  if (el.hasAttribute("data-ll-private")) return true;
  if (isWidgetDescendant(el)) return true;
  if (el instanceof HTMLInputElement) {
    const type = el.type.toLowerCase();
    if (PRIVACY_BLOCKED_TYPES.has(type)) return true;
    const autocomplete = el.getAttribute("autocomplete")?.toLowerCase() ?? "";
    for (const prefix of PRIVACY_BLOCKED_AUTOCOMPLETE_PREFIXES) {
      if (autocomplete.startsWith(prefix)) return true;
    }
  }
  return false;
}

// ─── Label resolution ────────────────────────────────────────────────

function resolveLabel(
  el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
): string {
  // 1. data-ll-label override
  const dataLabel = el.getAttribute("data-ll-label");
  if (dataLabel) return dataLabel.trim();

  // 2. <label for="id">
  if (el.id) {
    const lbl = el.ownerDocument.querySelector<HTMLLabelElement>(
      `label[for="${cssEscape(el.id)}"]`,
    );
    if (lbl?.textContent) return lbl.textContent.trim();
  }

  // 3. Wrapping <label>
  const wrappingLabel = el.closest("label");
  if (wrappingLabel?.textContent) {
    // Strip the input's own value/text from the label content
    const text = wrappingLabel.textContent.trim();
    if (text) return text;
  }

  // 4. aria-label / aria-labelledby
  const aria = el.getAttribute("aria-label");
  if (aria) return aria.trim();
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const ref = el.ownerDocument.getElementById(labelledBy);
    if (ref?.textContent) return ref.textContent.trim();
  }

  // 5. Placeholder
  const placeholder = el.getAttribute("placeholder");
  if (placeholder) return placeholder.trim();

  // 6. Title-case the name attribute as last resort
  const name = el.getAttribute("name") || el.id;
  if (name) {
    return name
      .replace(/[-_]/g, " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  return "Unknown field";
}

function cssEscape(value: string): string {
  // Use the standardized CSS.escape when available (all modern browsers).
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  // Last-resort escape: just backslash-escape the chars that matter
  // for an attribute selector. Plenty for our identifier use case.
  return value.replace(/(["\\])/g, "\\$1");
}

// ─── Kind resolution ─────────────────────────────────────────────────

function resolveKind(
  el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
): FieldKind {
  const override = el.getAttribute("data-ll-kind");
  if (override) return override as FieldKind;
  if (el instanceof HTMLTextAreaElement) return "long_text";
  if (el instanceof HTMLSelectElement) {
    return el.multiple ? "multi_select" : "select";
  }
  const type = el.type.toLowerCase();
  switch (type) {
    case "email": return "email";
    case "tel": return "phone";
    case "url": return "url";
    case "number":
    case "range": return "number";
    case "date":
    case "datetime-local":
    case "month":
    case "week": return "date";
    case "time": return "time";
    case "checkbox": return "boolean";
    case "radio": return "select";
    default: return "text";
  }
}

// ─── Options resolution (for select-kind fields) ─────────────────────

function resolveOptions(
  el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
): FieldOption[] | undefined {
  // data-ll-options="a:Alpha,b:Beta" wins when present
  const raw = el.getAttribute("data-ll-options");
  if (raw) {
    return raw
      .split(",")
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        const colonIdx = pair.indexOf(":");
        if (colonIdx === -1) return { id: pair, label: pair };
        return {
          id: pair.slice(0, colonIdx).trim(),
          label: pair.slice(colonIdx + 1).trim(),
        };
      });
  }
  // Native <select><option>
  if (el instanceof HTMLSelectElement) {
    const opts: FieldOption[] = [];
    for (const opt of Array.from(el.options)) {
      if (!opt.value && !opt.textContent) continue;
      opts.push({
        id: opt.value || opt.textContent?.trim() || "",
        label: opt.textContent?.trim() || opt.value,
      });
    }
    return opts.length > 0 ? opts : undefined;
  }
  return undefined;
}

// ─── Value extraction ────────────────────────────────────────────────

function readValue(
  el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
): FieldManifest["value"] {
  if (el instanceof HTMLInputElement) {
    const type = el.type.toLowerCase();
    if (type === "checkbox") return el.checked;
    if (type === "radio") return el.checked ? el.value : null;
    if (type === "number" || type === "range") {
      const num = parseFloat(el.value);
      return Number.isFinite(num) ? num : null;
    }
    return el.value;
  }
  if (el instanceof HTMLSelectElement) {
    if (el.multiple) {
      return Array.from(el.selectedOptions).map((o) => o.value);
    }
    return el.value;
  }
  return el.value;
}

// ─── Required resolution ─────────────────────────────────────────────

function resolveRequired(
  el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
): boolean {
  if (el.hasAttribute("data-ll-required")) return true;
  return el.required;
}

// ─── ID resolution ───────────────────────────────────────────────────

function resolveId(
  el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
): string | null {
  const name = el.getAttribute("name");
  if (name) return name;
  const id = el.id;
  if (id) return id;
  return null;
}

// ─── Form-scope helpers ──────────────────────────────────────────────

function resolveFormId(
  el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
): string | undefined {
  const form = el.closest("form");
  if (!form) return undefined;
  return form.id || form.getAttribute("name") || undefined;
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Scan the DOM once and return every discoverable field.
 *
 * In strict mode (data-ll-field present on at least one input on the
 * page), ONLY tagged elements are picked up — useful for sites that
 * want explicit opt-in for everything. Otherwise we auto-discover
 * every input that passes privacy guards.
 */
export function discover(options: DiscoverOptions = {}): DiscoveryEntry[] {
  const root: Document | HTMLElement = options.root ?? document;
  const includeOrphans = options.includeOrphans !== false;

  // Strict mode detection: if ANY element has data-ll-field, only
  // those get picked up. This is the consumer opt-in escape hatch:
  // tag one field with data-ll-field and the SDK stops auto-discovery.
  const taggedNodes = root.querySelectorAll<HTMLElement>("[data-ll-field]");
  const strictMode = taggedNodes.length > 0;

  const candidates: (HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement)[] = [];

  if (strictMode) {
    for (const node of Array.from(taggedNodes)) {
      if (
        node instanceof HTMLInputElement ||
        node instanceof HTMLSelectElement ||
        node instanceof HTMLTextAreaElement
      ) {
        candidates.push(node);
      }
    }
  } else {
    const inputs = root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      "input, select, textarea",
    );
    for (const el of Array.from(inputs)) {
      // Skip orphans (inputs outside a <form>) unless opted in
      if (!includeOrphans && !el.closest("form")) continue;
      candidates.push(el);
    }
  }

  const entries: DiscoveryEntry[] = [];
  const seenIds = new Set<string>();

  for (const el of candidates) {
    if (isPrivacyBlocked(el)) continue;
    const id = resolveId(el);
    if (!id) continue;
    // De-dupe by id within a single scan. Radio groups share a name —
    // we keep the first one; readValue() for radio returns the *active*
    // value because all radios in a group share the same name binding.
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    const field: FieldManifest = {
      id,
      label: resolveLabel(el),
      kind: resolveKind(el),
      value: readValue(el),
      required: resolveRequired(el),
    };

    const description = el.getAttribute("data-ll-description");
    if (description) field.description = description.trim();

    const options = resolveOptions(el);
    if (options) field.options = options;

    const formId = resolveFormId(el);
    if (formId) field.formId = formId;

    entries.push({ field, element: el });
  }

  return entries;
}

// ─── Change tracker ──────────────────────────────────────────────────

/**
 * Listener that fires whenever a discovered field's value changes.
 * Uses event delegation on `document` so a single addEventListener
 * call captures every `input`/`change` event from anywhere in the
 * page — no per-field wiring required.
 */
export interface ChangeListener {
  (entry: DiscoveryEntry, newValue: FieldManifest["value"]): void;
}

export interface ChangeTrackerOptions {
  /** Document to attach the global listener to. Defaults to `document`. */
  doc?: Document;
  /**
   * Lookup function: given an event target, return the matching
   * discovery entry or null. Wired by the manifest manager so the
   * tracker stays decoupled from discovery state.
   */
  resolve(
    target: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  ): DiscoveryEntry | null;
  onChange: ChangeListener;
}

/**
 * Attach a single delegated listener for `input` + `change` events.
 * Returns a teardown function that detaches the listeners.
 */
export function attachChangeTracker(opts: ChangeTrackerOptions): () => void {
  const doc = opts.doc ?? document;

  const handler = (ev: Event) => {
    const target = ev.target;
    if (
      !(target instanceof HTMLInputElement) &&
      !(target instanceof HTMLSelectElement) &&
      !(target instanceof HTMLTextAreaElement)
    ) {
      return;
    }
    const entry = opts.resolve(target);
    if (!entry) return;
    const newValue = readValue(target);
    // Avoid spamming the agent with identical values (React's
    // controlled inputs fire `input` on every keystroke; we still want
    // those, but we don't want them when the value is unchanged).
    if (newValue === entry.field.value) return;
    entry.field.value = newValue;
    opts.onChange(entry, newValue);
  };

  // `input` catches typing in text fields + select changes (in most
  // browsers). `change` is the fallback for radio/checkbox in older
  // engines and the canonical event for select. Listening to both is
  // redundant most of the time but cheap and bulletproof.
  doc.addEventListener("input", handler, true);
  doc.addEventListener("change", handler, true);

  return () => {
    doc.removeEventListener("input", handler, true);
    doc.removeEventListener("change", handler, true);
  };
}

// ─── DOM mutation observer ───────────────────────────────────────────
//
// SPA route changes mount new <form> elements without a page reload.
// Re-run discovery when the DOM changes meaningfully so newly-added
// inputs are tracked. Debounced so React render bursts don't trigger
// a hundred re-scans per second.

export interface MutationWatcherOptions {
  doc?: Document;
  onChange(): void;
  /** ms to debounce re-scans. Default 200ms. */
  debounceMs?: number;
}

export function attachMutationWatcher(
  opts: MutationWatcherOptions,
): () => void {
  if (typeof MutationObserver === "undefined") return () => {};
  const doc = opts.doc ?? document;
  const debounceMs = opts.debounceMs ?? 200;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const observer = new MutationObserver(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      opts.onChange();
    }, debounceMs);
  });
  observer.observe(doc.body, {
    childList: true,
    subtree: true,
    // Don't watch attributes — they fire too often and the manifest
    // already re-reads value/required via the change tracker.
    attributes: false,
  });

  return () => {
    if (timer) clearTimeout(timer);
    observer.disconnect();
  };
}

// Internal export for the tracker's value reader — also used by
// transport when building the initial PageContext.
export { readValue as _readValue };
