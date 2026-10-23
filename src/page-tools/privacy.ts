// ─── privacy ─────────────────────────────────────────────────────────
// Single source of truth for "may the agent see / touch this element?"
// Used by the page-context walker, the routes walker, fill_form,
// focus_field and submit_form, and (PRIVATE_SUBTREE / agentText only) by
// handle-agent-command.ts (click, the task_field_updated painter) and
// the form manifest (manifest/discover.ts).
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
// Two deliberate differences from React: React's page-context walker
// skips only `[data-ll-private="true"]` subtrees for visible text,
// regions and links, so the text of a bare `data-ll-private` or a
// `data-ll-skip` subtree still reaches the agent there. Here every
// walker uses the same subtree rule as the form helpers. And React
// checks only the element it reads (and its ancestors), then sends its
// whole textContent, so a private element nested inside an ordinary
// paragraph, heading, link, label or region is sent with it. Here all
// text goes through agentText, which cuts nested private subtrees out.

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

/** Never text: private subtrees, plus elements that do not render text. */
const SKIP_IN_TEXT = `${PRIVATE_SUBTREE}, script, style, noscript, template, [hidden]`;

/**
 * An element's text as the agent may read it: "" when the element sits
 * in a private subtree, otherwise its text with every private subtree
 * inside it cut out. Checking the element alone is not enough: a
 * `<span data-ll-private>` inside an ordinary <p>, heading, link, label
 * or region would otherwise come along with its parent's textContent.
 *
 * Without a private descendant this is the usual textContent (or
 * innerText when `rendered`), so ordinary text reads exactly as before.
 * With one, the text nodes are walked, skipping private and non-text
 * subtrees, and whitespace is collapsed.
 */
export function agentText(el: Element, rendered = false): string {
  if (hasPrivateAncestor(el)) return "";
  if (!el.querySelector(PRIVATE_SUBTREE)) {
    return (rendered && (el as HTMLElement).innerText) || el.textContent || "";
  }
  let text = "";
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.nodeType === Node.ELEMENT_NODE && (node as Element).matches(SKIP_IN_TEXT)
        ? NodeFilter.FILTER_REJECT // skips the whole subtree
        : NodeFilter.FILTER_ACCEPT,
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) text += (node as Text).data;
  }
  return text.replace(/\s+/g, " ");
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
