// ─── forms ───────────────────────────────────────────────────────────
// Resolve the agent's `formId` / field keys back to DOM nodes, and set
// field values the way framework-controlled inputs notice.
//
// Ported from @livelayer/react 0.26.0 (github.com/Fusion-Studios-Code/
// live-layer-react @ a0ac539):
//   - findFormByLooseId      ← src/utils/findFormByLooseId.ts
//   - findFieldInForm,
//     findFillableFieldInForm ← src/utils/findFieldInForm.ts
//   - fillField              ← src/utils/fillField.ts
//
// The form and field identifiers are the ones page-context.ts
// synthesizes; both sides must iterate the DOM the same way.
//
// Three deliberate differences, all on the strict side:
//   - A form counts as off-limits inside ANY [data-ll-private] (React
//     checks only data-ll-private="true" here, while its own privacy
//     helper and docs treat the bare attribute as private too).
//   - An id that names an off-limits form resolves to nothing; React
//     falls through to its single-form fallback and can act on another
//     form.
//   - Positional field keys skip private fields, as the page context
//     does (see findFieldInForm).

import { intentToSlug, NON_DATA_INPUT_TYPES } from "./page-context";
import { cssEscape, hasPrivateAncestor, isFieldFillable, type FillableEl } from "./privacy";

/**
 * Find the <form> the agent means. Accepts every identifier
 * page-context.ts can emit: `id`, `name`, raw or slugged
 * `data-ll-intent`, or the positional `form_<n>`. Never returns a form
 * in a private / opted-out subtree. When nothing matches and the page
 * has exactly one eligible form, that form is used (single-form pages
 * are the common case and the intent is unambiguous).
 */
export function findFormByLooseId(doc: Document, formId: string): HTMLFormElement | null {
  if (!formId) return null;
  const safe = formId.replace(/"/g, '\\"');
  // An id that names an off-limits form is refused outright, never
  // redirected to the single-form fallback below (React would fall back
  // and act on a different form).
  let namedOffLimits = false;
  const eligible = (form: HTMLFormElement | null): form is HTMLFormElement => {
    if (!form) return false;
    if (hasPrivateAncestor(form)) {
      namedOffLimits = true;
      return false;
    }
    return true;
  };

  try {
    const byId = doc.querySelector<HTMLFormElement>(`form#${cssEscape(formId)}`);
    if (eligible(byId)) return byId;
  } catch {
    /* invalid selector, fall through */
  }

  try {
    const byName = doc.querySelector<HTMLFormElement>(`form[name="${safe}"]`);
    if (eligible(byName)) return byName;
    const byIntentRaw = doc.querySelector<HTMLFormElement>(`form[data-ll-intent="${safe}"]`);
    if (eligible(byIntentRaw)) return byIntentRaw;
  } catch {
    /* invalid selector, fall through */
  }

  const all = Array.from(doc.querySelectorAll<HTMLFormElement>("form"));
  const forms = all.filter((form) => !hasPrivateAncestor(form));
  for (const form of all) {
    const intent = form.getAttribute("data-ll-intent");
    if (intent && intentToSlug(intent) === formId && eligible(form)) return form;
  }
  if (namedOffLimits) return null;

  // form_<n>: count from 0 over forms without an id / name / intent, in
  // the same DOM order page-context.ts walks.
  if (/^form_\d+$/.test(formId)) {
    const wantedIdx = parseInt(formId.slice("form_".length), 10);
    let synthIdx = 0;
    for (const form of forms) {
      if (form.id || form.getAttribute("name") || form.getAttribute("data-ll-intent")) continue;
      if (synthIdx === wantedIdx) return form;
      synthIdx++;
    }
  }

  if (forms.length === 1) return forms[0];
  return null;
}

function isDataInput(el: FillableEl): boolean {
  return !(el instanceof HTMLInputElement && NON_DATA_INPUT_TYPES.includes(el.type));
}

function normalizeToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Segment after the last dot ("opening.preferred_name" → "preferred_name"). */
function afterLastDot(s: string): string {
  const i = s.lastIndexOf(".");
  return i >= 0 ? s.slice(i + 1) : s;
}

function fieldLabelText(el: FillableEl): string {
  const id = el.getAttribute("id");
  if (id) {
    try {
      const lbl = el.ownerDocument.querySelector(`label[for="${id.replace(/"/g, '\\"')}"]`);
      if (lbl?.textContent) return lbl.textContent;
    } catch {
      /* invalid selector */
    }
  }
  const wrap = el.closest("label");
  if (wrap?.textContent) return wrap.textContent;
  return el.getAttribute("aria-label") || el.getAttribute("placeholder") || "";
}

/**
 * Fallback when no exact key matched: the agent often fills by concept
 * ("name", "email") rather than the exact synthesized key. An exact
 * normalized match on name / id / last-dot segment (score 4) beats a
 * substring match on those or on the label (score 2).
 */
function tolerantMatch(form: HTMLFormElement, key: string): FillableEl | null {
  const nk = normalizeToken(key);
  if (nk.length < 2) return null;
  let best: FillableEl | null = null;
  let bestScore = 0;
  for (const el of Array.from(form.querySelectorAll<FillableEl>("input, textarea, select"))) {
    if (!isDataInput(el)) continue;
    const name = el.getAttribute("name") || "";
    const id = el.getAttribute("id") || "";
    const exact = [
      normalizeToken(afterLastDot(name)),
      normalizeToken(afterLastDot(id)),
      normalizeToken(name),
      normalizeToken(id),
    ];
    let score = 0;
    if (exact.some((c) => c.length >= 2 && c === nk)) {
      score = 4;
    } else {
      const fuzzy = [
        normalizeToken(name),
        normalizeToken(afterLastDot(name)),
        normalizeToken(fieldLabelText(el)),
      ];
      if (fuzzy.some((c) => c.length >= 3 && (c.includes(nk) || nk.includes(c)))) score = 2;
    }
    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return bestScore >= 2 ? best : null;
}

/**
 * Resolve the agent's field key (PageContext.forms[].fields[].name) to a
 * DOM element: a real `name=` first, then the `name` → `id` →
 * `field_<n>` synthesis (with the `__<n>` de-dup suffix), then the
 * tolerant match.
 */
export function findFieldInForm(form: HTMLFormElement, key: string): FillableEl | null {
  if (!key) return null;
  try {
    const direct = form.querySelector<FillableEl>(`[name="${key.replace(/"/g, '\\"')}"]`);
    if (direct && isDataInput(direct)) return direct;
  } catch {
    /* invalid selector, fall through to the scan */
  }

  // Same walk as page-context.ts: private fields are skipped BEFORE they
  // are counted, so `field_<n>` and the `__<n>` suffix name the same
  // element on both sides. (React counts private fields here but not in
  // its page context, so a password input ahead of an anonymous field
  // shifts every positional key by one.)
  let positionalIdx = 0;
  const seen = new Set<string>();
  for (const el of Array.from(form.querySelectorAll<FillableEl>("input, textarea, select"))) {
    if (!isFieldFillable(el) || !isDataInput(el)) continue;
    const baseKey = el.getAttribute("name") || el.getAttribute("id") || `field_${positionalIdx}`;
    const resolvedKey = seen.has(baseKey) ? `${baseKey}__${positionalIdx}` : baseKey;
    if (resolvedKey === key) return el;
    seen.add(baseKey);
    positionalIdx++;
  }

  return tolerantMatch(form, key);
}

/** Resolve + privacy check: `{ el }`, or `{ el: null, reason: "not_found" | "private" }`. */
export function findFillableFieldInForm(
  form: HTMLFormElement,
  key: string,
): { el: FillableEl } | { el: null; reason: "not_found" | "private" } {
  const el = findFieldInForm(form, key);
  if (!el) return { el: null, reason: "not_found" };
  if (!isFieldFillable(el)) return { el: null, reason: "private" };
  return { el };
}

/**
 * Set a field's value so framework-controlled inputs see it: call the
 * prototype's native value setter (React's value tracker ignores a
 * plain `el.value = x`), then dispatch bubbling input + change events.
 * Checkboxes and radios take "true" / "1" / "on" as checked.
 */
export function fillField(el: FillableEl, value: string): void {
  if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")?.set;
    const next = value === "true" || value === "1" || value === "on";
    if (setter) setter.call(el, next);
    else el.checked = next;
  } else {
    const proto =
      el instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLSelectElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else (el as { value: string }).value = value;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}
