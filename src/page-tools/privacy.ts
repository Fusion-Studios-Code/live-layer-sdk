// ─── privacy ─────────────────────────────────────────────────────────
// Single source of truth for "may the agent see / touch this element?"
// Used by the page-context walker, the routes walker, fill_form,
// focus_field and submit_form.
//
// Ported from @livelayer/react 0.26.0, src/utils/fieldPrivacy.ts
// (github.com/Fusion-Studios-Code/live-layer-react @ a0ac539).
//
// Rules (hard-coded, do not relax):
//   - type="password"           → never
//   - autocomplete="off"        → never
//   - autocomplete starts cc-   → never (card data goes through the payment provider)
//   - inside [data-ll-private]  → never, whatever the attribute's value
//   - inside [data-ll-skip]     → never (subtree-wide opt-out, same meaning)
//   - .ll-widget                → never (the widget's own DOM)
//
// One deliberate difference from React: React's page-context walker
// skips only `[data-ll-private="true"]` subtrees for visible text,
// regions and links, so the text of a bare `data-ll-private` or a
// `data-ll-skip` subtree still reaches the agent there. Here every
// walker uses the same subtree rule as the form helpers.

/** Subtrees the agent never reads from or acts in. */
export const PRIVATE_SUBTREE = "[data-ll-private], [data-ll-skip], .ll-widget";

/** Subtrees that never contribute visible text (private, plus non-content elements). */
const NON_TEXT_SUBTREE = `${PRIVATE_SUBTREE}, script, style, noscript, iframe`;

export function hasPrivateAncestor(el: Element): boolean {
  return el.closest(PRIVATE_SUBTREE) !== null;
}

/** True when the element must not contribute text, links or regions to a page snapshot. */
export function isHiddenFromAgent(el: Element): boolean {
  if (el.getAttribute("aria-hidden") === "true") return true;
  if (el.hasAttribute("hidden")) return true;
  return el.closest(NON_TEXT_SUBTREE) !== null;
}

export type FillableEl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

export function isFieldFillable(el: FillableEl): boolean {
  if (hasPrivateAncestor(el)) return false;
  // password / cc-* / off are only meaningful on <input>
  if (el instanceof HTMLInputElement) {
    if (el.type === "password") return false;
    const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
    if (ac === "off") return false;
    if (ac.startsWith("cc-")) return false;
  }
  return true;
}

/** CSS.escape with a fallback for environments that lack it. */
export function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/(["\\])/g, "\\$1");
}
