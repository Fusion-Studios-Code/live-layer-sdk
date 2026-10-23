// ─── routes ──────────────────────────────────────────────────────────
// DOM-walks every <a href> on the page and returns a deduped list of
// routes the agent could navigate to, for the agent's get_routes tool
// (`request_routes` → `routes`). Cached for 5 s per pathname.
//
// Ported from @livelayer/react 0.26.0, src/utils/extractRoutes.ts
// (github.com/Fusion-Studios-Code/live-layer-react @ a0ac539). Left out:
// the host `getRoutes` callback and its input normalizer; the script-tag
// widget always walks the DOM.
//
// Skip rules:
//   - [data-ll-private] / [data-ll-skip] / .ll-widget subtrees, and the
//     same subtrees nested inside a link's text (agentText)
//   - href that is empty, "#…", "javascript:", "mailto:" or "tel:"

import { agentText, hasPrivateAncestor } from "./privacy";

const MAX_ROUTES = 200;

export interface ExtractedRoute {
  href: string;
  /** Visible link text. */
  text: string;
  /** Same origin as `window.location.origin`. External links are listed but flagged. */
  internal: boolean;
}

function isNavigableHref(href: string): boolean {
  if (!href) return false;
  if (href.startsWith("#")) return false;
  if (href.startsWith("javascript:")) return false;
  if (href.startsWith("mailto:")) return false;
  if (href.startsWith("tel:")) return false;
  return true;
}

export function extractRoutes(doc: Document = document): ExtractedRoute[] {
  const origin = (typeof window !== "undefined" && window.location.origin) || "";
  const seen = new Set<string>();
  const out: ExtractedRoute[] = [];

  for (const a of Array.from(doc.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
    if (out.length >= MAX_ROUTES) break;
    if (hasPrivateAncestor(a)) continue;
    const rawHref = a.getAttribute("href") || "";
    if (!isNavigableHref(rawHref)) continue;

    // Relative hrefs stay as they are (in-app routing); internal absolute
    // URLs become path + search + hash.
    let href = rawHref;
    let internal = true;
    try {
      const url = new URL(rawHref, origin);
      internal = url.origin === origin;
      if (internal && rawHref.startsWith("http")) {
        href = url.pathname + url.search + url.hash;
      }
    } catch {
      continue; // unparseable href
    }

    if (seen.has(href)) continue;
    seen.add(href);
    out.push({ href, text: agentText(a).trim().slice(0, 120), internal });
  }

  return out;
}

let cached: { at: number; pathname: string; routes: ExtractedRoute[] } | null = null;
const CACHE_MS = 5000;

export function getCachedRoutes(doc: Document = document): ExtractedRoute[] {
  const now = Date.now();
  const pathname = (typeof window !== "undefined" && window.location.pathname) || "/";
  if (cached && cached.pathname === pathname && now - cached.at < CACHE_MS) {
    return cached.routes;
  }
  const routes = extractRoutes(doc);
  cached = { at: now, pathname, routes };
  return routes;
}

export function clearRoutesCache(): void {
  cached = null;
}
