// ─── page-context ────────────────────────────────────────────────────
// Walk the host's DOM and produce the structured snapshot the agent's
// get_page_context tool asks for (`request_page_context` →
// `page_context`).
//
// Ported from @livelayer/react 0.26.0, src/utils/extractPageContext.ts
// (github.com/Fusion-Studios-Code/live-layer-react @ a0ac539). Same
// output shape, caps, label rules, form-id and field-key synthesis, so
// fill_form / focus_field / submit_form keys round-trip identically on
// both widgets. Left out:
//   - `flow` (multi-step wizard detection, detectFlow.ts). The script-tag
//     widget does not act on advance_step / go_back, so it does not tell
//     the agent about Continue / Back controls it cannot press.
//   - `extras` (the script-tag widget has no host extras).
// Privacy: see ./privacy.ts (one subtree rule for every walker).
//
// Privacy guarantees (hard-coded, do not relax):
//   - Form values are NEVER read. Only labels, types and constraints.
//   - password / autocomplete="off" / autocomplete="cc-*" inputs are
//     excluded entirely.
//   - [data-ll-private], [data-ll-skip] and .ll-widget subtrees are
//     skipped, for text and links as well as for fields, including when
//     they are nested inside an ordinary paragraph, heading, link, label
//     or region (all text is read through agentText).

import { agentText, cssEscape, hasPrivateAncestor, isFieldFillable, isHiddenFromAgent } from "./privacy";

export interface PageContextField {
  /**
   * Agent-callable identifier: the input's `name`, else its `id`, else
   * `field_<n>` (position among the form's data inputs).
   */
  name: string;
  label: string;
  type: string;
  required?: boolean;
  placeholder?: string;
  minLength?: number;
  maxLength?: number;
  min?: string;
  max?: string;
  step?: string;
  pattern?: string;
  autocomplete?: string;
  options?: Array<{ value: string; label: string }>;
  placeholderOption?: string;
  hasEmptyOption?: boolean;
  validationMessage?: string;
}

export interface PageContext {
  url: string;
  title: string;
  pathname: string;
  regions: Array<{ id: string; intent?: string; text: string }>;
  visibleText: string;
  visibleLinks: Array<{ href: string; text: string }>;
  visibleFields: Array<{ label: string; type: string }>;
  forms: Array<{ id: string; intent?: string; fields: PageContextField[] }>;
  /** Set by the size guard when the reply had to be cut (see data-payload.ts). */
  truncated?: string[];
}

const MAX_OUTPUT_BYTES = 4096;
const MAX_LINKS = 20;
const MAX_FIELDS = 20;
const MAX_REGIONS = 10;
const MAX_FORMS = 10;
const MAX_FIELDS_PER_FORM = 30;
const MAX_OPTIONS_PER_FIELD = 20;
const MAX_PARAGRAPH_CHARS = 500;

function isVisibleInViewport(el: Element): boolean {
  if (typeof window === "undefined") return true;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const vpHeight = window.innerHeight || document.documentElement.clientHeight;
  const vpWidth = window.innerWidth || document.documentElement.clientWidth;
  return rect.bottom > 0 && rect.right > 0 && rect.top < vpHeight && rect.left < vpWidth;
}

function fieldLabel(el: HTMLElement): string {
  // Semantic labels (<label for>, aria-label, wrapping <label>) beat the
  // placeholder, which is an example value, not a label.
  const id = el.getAttribute("id");
  if (id) {
    const lbl = el.ownerDocument.querySelector(`label[for="${cssEscape(id)}"]`);
    const text = lbl ? agentText(lbl) : "";
    if (text) return text.trim();
  }
  const aria = el.getAttribute("aria-label");
  if (aria) return aria.trim();
  const wrapping = el.closest("label");
  if (wrapping) {
    // The wrapping label's own text, without the control's (a wrapped
    // <select>'s option labels must not bleed into the label).
    const parts: string[] = [];
    for (const node of Array.from(wrapping.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = (node.textContent || "").trim();
        if (t) parts.push(t);
      } else if (node instanceof HTMLElement) {
        if (
          node instanceof HTMLInputElement ||
          node instanceof HTMLTextAreaElement ||
          node instanceof HTMLSelectElement ||
          node instanceof HTMLButtonElement
        ) {
          continue;
        }
        const t = agentText(node).trim();
        if (t) parts.push(t);
      }
    }
    const direct = parts.join(" ").trim();
    if (direct) return direct;
  }
  const placeholder = el.getAttribute("placeholder");
  if (placeholder) return placeholder.trim();
  return "";
}

function clampString(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/** "request a demo" → "request-a-demo". Mirrored in forms.ts. */
export function intentToSlug(intent: string | null): string | null {
  if (!intent) return null;
  const slug = intent
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || null;
}

/** First match of `selector` under `root` outside any private subtree. */
function firstNotPrivate<T extends Element>(root: ParentNode, selector: string): T | null {
  for (const el of Array.from(root.querySelectorAll<T>(selector))) {
    if (!hasPrivateAncestor(el)) return el;
  }
  return null;
}

/**
 * Best-effort intent when the author gave no `data-ll-intent`: the
 * form's aria-label / aria-labelledby, then its submit button text, then
 * the nearest heading among its first four ancestors. A target, button
 * or heading in a private subtree is passed over, as if it were not on
 * the page.
 */
function inferFormIntent(form: HTMLFormElement): string | null {
  const aria = form.getAttribute("aria-label");
  if (aria) return aria.trim().slice(0, 80);

  const ariaBy = form.getAttribute("aria-labelledby");
  if (ariaBy) {
    const target = form.ownerDocument.getElementById(ariaBy);
    const text = target ? agentText(target).trim() : "";
    if (text) return text.slice(0, 80);
  }

  const submit = firstNotPrivate<HTMLButtonElement | HTMLInputElement>(
    form,
    'button[type="submit"], input[type="submit"], button:not([type])',
  );
  if (submit) {
    const text = submit instanceof HTMLInputElement ? submit.value : agentText(submit).trim();
    if (text && text.length < 60 && !/^(submit|ok|continue)$/i.test(text)) {
      return text;
    }
  }

  let cur: Element | null = form.parentElement;
  for (let depth = 0; cur && depth < 4; depth++, cur = cur.parentElement) {
    const heading = firstNotPrivate(cur, "h1, h2, h3, h4");
    if (heading) {
      const text = agentText(heading).trim();
      if (text && text.length < 80) return text;
    }
  }
  return null;
}

/** Input types that are not data fields. Mirrored in forms.ts (positional keys must agree). */
export const NON_DATA_INPUT_TYPES = ["submit", "button", "reset", "hidden", "image", "file"];

function describeField(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  name: string,
): PageContextField {
  const label = fieldLabel(el) || name;
  const type = el instanceof HTMLInputElement ? el.type : el.tagName.toLowerCase();
  const entry: PageContextField = { name, label: clampString(label, 100), type };
  if ((el as HTMLInputElement).required === true) entry.required = true;
  const placeholder = el.getAttribute("placeholder");
  if (placeholder) entry.placeholder = clampString(placeholder.trim(), 100);
  // HTML5 constraints, surfaced up front so the agent formats values
  // correctly the first time. Only emitted when the attribute is set.
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const minLenAttr = el.getAttribute("minlength");
    if (minLenAttr !== null) {
      const n = parseInt(minLenAttr, 10);
      if (!Number.isNaN(n) && n >= 0) entry.minLength = n;
    }
    const maxLenAttr = el.getAttribute("maxlength");
    if (maxLenAttr !== null) {
      const n = parseInt(maxLenAttr, 10);
      if (!Number.isNaN(n) && n >= 0) entry.maxLength = n;
    }
  }
  if (el instanceof HTMLInputElement) {
    const minAttr = el.getAttribute("min");
    if (minAttr !== null) entry.min = clampString(minAttr, 50);
    const maxAttr = el.getAttribute("max");
    if (maxAttr !== null) entry.max = clampString(maxAttr, 50);
    const stepAttr = el.getAttribute("step");
    if (stepAttr !== null) entry.step = clampString(stepAttr, 20);
    const patternAttr = el.getAttribute("pattern");
    if (patternAttr !== null) entry.pattern = clampString(patternAttr, 200);
    const acAttr = (el.getAttribute("autocomplete") || "").toLowerCase();
    if (acAttr && acAttr !== "off" && !acAttr.startsWith("cc-")) {
      entry.autocomplete = clampString(acAttr, 50);
    }
  }
  if (el instanceof HTMLSelectElement) {
    const opts: Array<{ value: string; label: string }> = [];
    for (let i = 0; i < el.options.length; i++) {
      const o = el.options[i];
      if (!o || hasPrivateAncestor(o)) continue;
      // A placeholder option (empty value and/or disabled, e.g. "Select a
      // subject…") marks the select as a required choice even without the
      // HTML5 `required` attribute. The select's current value is never
      // read, so this is the only signal.
      if (o.value === "" || o.disabled) {
        const ph = (o.textContent || "").trim();
        if (ph && !entry.placeholderOption) {
          entry.placeholderOption = clampString(ph, 60);
        }
        entry.hasEmptyOption = true;
        if (o.disabled) continue;
      }
      if (opts.length >= MAX_OPTIONS_PER_FIELD) break;
      const value = o.value || "";
      const optLabel = (o.textContent || "").trim() || value;
      if (!value && !optLabel) continue;
      opts.push({ value, label: clampString(optLabel, 60) });
    }
    if (opts.length > 0) entry.options = opts;
  }
  // Live HTML5 validation message (empty when valid), so the agent can
  // name the field a submit was blocked on.
  const vm =
    typeof (el as HTMLInputElement).validationMessage === "string"
      ? (el as HTMLInputElement).validationMessage
      : "";
  if (vm) entry.validationMessage = clampString(vm, 200);
  return entry;
}

export function extractPageContext(doc: Document = document): PageContext {
  const url = (typeof window !== "undefined" && window.location.href) || "";
  const pathname = (typeof window !== "undefined" && window.location.pathname) || "/";
  const title = doc.title || "";

  // ── Regions (author-curated) ───────────────────────────────────────
  const regions: PageContext["regions"] = [];
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>("[data-ll-region]"))) {
    if (regions.length >= MAX_REGIONS) break;
    if (isHiddenFromAgent(el)) continue;
    if (!isVisibleInViewport(el)) continue;
    const id = el.getAttribute("data-ll-region") ?? "";
    const intent = el.getAttribute("data-ll-intent") ?? undefined;
    const text = clampString(agentText(el, true).trim(), MAX_PARAGRAPH_CHARS * 2);
    if (!id || !text) continue;
    regions.push({ id, intent, text });
  }

  // ── Headings + paragraphs (visible text) ───────────────────────────
  const textNodes: string[] = [];
  for (const h of Array.from(doc.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"))) {
    if (isHiddenFromAgent(h)) continue;
    if (!isVisibleInViewport(h)) continue;
    const text = agentText(h).trim();
    if (text) textNodes.push(`${h.tagName}: ${clampString(text, 200)}`);
  }
  for (const p of Array.from(doc.querySelectorAll<HTMLElement>("p, li"))) {
    if (isHiddenFromAgent(p)) continue;
    if (!isVisibleInViewport(p)) continue;
    const text = agentText(p).trim();
    if (text.length > 10) textNodes.push(clampString(text, MAX_PARAGRAPH_CHARS));
  }
  const visibleText = textNodes.join("\n");

  // ── Links ──────────────────────────────────────────────────────────
  const visibleLinks: PageContext["visibleLinks"] = [];
  for (const a of Array.from(doc.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
    if (visibleLinks.length >= MAX_LINKS) break;
    if (isHiddenFromAgent(a)) continue;
    if (!isVisibleInViewport(a)) continue;
    const href = a.getAttribute("href") || "";
    const text = agentText(a).trim();
    if (!href || !text) continue;
    visibleLinks.push({ href, text: clampString(text, 100) });
  }

  // ── Visible fields (labels + types only; values NEVER) ─────────────
  const visibleFields: PageContext["visibleFields"] = [];
  for (const f of Array.from(
    doc.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      "input, textarea, select",
    ),
  )) {
    if (visibleFields.length >= MAX_FIELDS) break;
    if (isHiddenFromAgent(f)) continue;
    if (!isFieldFillable(f)) continue;
    if (!isVisibleInViewport(f)) continue;
    const label = fieldLabel(f);
    const type = f instanceof HTMLInputElement ? f.type : f.tagName.toLowerCase();
    if (!label) continue;
    visibleFields.push({ label: clampString(label, 100), type });
  }

  // ── Auto-discovered forms ──────────────────────────────────────────
  // Every <form> is agent-visible unless it sits in a private subtree.
  // Form id: `id` → `name` → `data-ll-intent` slug → `form_<n>`. Fields
  // are not filtered on visibility (a form below the fold is still
  // fillable; the agent can scroll first).
  const forms: PageContext["forms"] = [];
  let synthFormIdx = 0;
  for (const form of Array.from(doc.querySelectorAll<HTMLFormElement>("form"))) {
    if (forms.length >= MAX_FORMS) break;
    if (hasPrivateAncestor(form)) continue;

    const id =
      form.getAttribute("id") ||
      form.getAttribute("name") ||
      intentToSlug(form.getAttribute("data-ll-intent")) ||
      `form_${synthFormIdx++}`;
    const intent = form.getAttribute("data-ll-intent") || inferFormIntent(form) || undefined;

    const fields: PageContextField[] = [];
    let positionalIdx = 0;
    const usedKeys = new Set<string>();
    for (const el of Array.from(
      form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
        "input, textarea, select",
      ),
    )) {
      if (fields.length >= MAX_FIELDS_PER_FORM) break;
      if (!isFieldFillable(el)) continue;
      // positionalIdx counts data inputs only, exactly like the fill-side
      // resolver in forms.ts.
      if (el instanceof HTMLInputElement && NON_DATA_INPUT_TYPES.includes(el.type)) continue;
      let name = el.getAttribute("name") || el.getAttribute("id") || `field_${positionalIdx}`;
      if (usedKeys.has(name)) name = `${name}__${positionalIdx}`;
      usedKeys.add(name);
      positionalIdx++;
      fields.push(describeField(el, name));
    }
    forms.push({ id, intent, fields });
  }

  const ctx: PageContext = {
    url,
    title,
    pathname,
    regions,
    visibleText,
    visibleLinks,
    visibleFields,
    forms,
  };

  // ── 4 KB text budget: drop fields, then links, then cut the text ───
  // (Same loose budget as React; the hard packet limit is enforced by
  // encodePageContextReply.)
  let total =
    JSON.stringify(ctx.regions).length +
    ctx.visibleText.length +
    JSON.stringify(ctx.visibleLinks).length +
    JSON.stringify(ctx.visibleFields).length;
  while (total > MAX_OUTPUT_BYTES && ctx.visibleFields.length > 0) {
    ctx.visibleFields.pop();
    total = JSON.stringify(ctx.visibleFields).length;
  }
  while (total > MAX_OUTPUT_BYTES && ctx.visibleLinks.length > 0) {
    ctx.visibleLinks.pop();
    total -= 80;
  }
  if (ctx.visibleText.length > MAX_OUTPUT_BYTES) {
    ctx.visibleText = clampString(ctx.visibleText, MAX_OUTPUT_BYTES - 100);
  }

  return ctx;
}

// ── 1 s cache ─────────────────────────────────────────────────────────
// Keyed by pathname + scrollY + a cheap form signature, so a form that
// mounts after an empty read (late SPA render) is seen at once instead
// of after the TTL.
let cached: { key: string; at: number; ctx: PageContext } | null = null;

function formSignature(doc: Document): string {
  const forms = doc.querySelectorAll("form");
  let sig = `f${forms.length}`;
  forms.forEach((f) => {
    sig += `|${f.id || f.getAttribute("name") || ""}:${f.querySelectorAll("input,select,textarea").length}`;
  });
  return sig;
}

export function getCachedPageContext(doc: Document = document): PageContext {
  const now = Date.now();
  const path = (typeof window !== "undefined" && window.location.pathname) || "/";
  const scroll = typeof window !== "undefined" ? window.scrollY : 0;
  const key = `${path}::${scroll}::${formSignature(doc)}`;
  if (cached && cached.key === key && now - cached.at < 1000) return cached.ctx;
  const ctx = extractPageContext(doc);
  cached = { key, at: now, ctx };
  return ctx;
}

export function clearPageContextCache(): void {
  cached = null;
}
