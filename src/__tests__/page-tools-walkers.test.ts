// ─── page-tools walkers: page context, routes, form lookup ───────────
// Shape and privacy of what the agent can see. Cases follow
// @livelayer/react 0.26.0's extractPageContext / extractRoutes /
// findFormByLooseId / findFieldInForm / fillField tests, plus the
// subtree rules this port applies to every walker.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPageContextCache,
  extractPageContext,
  getCachedPageContext,
} from "../page-tools/page-context";
import { clearRoutesCache, extractRoutes } from "../page-tools/routes";
import {
  fillField,
  findFieldInForm,
  findFillableFieldInForm,
  findFormByLooseId,
} from "../page-tools/forms";

// jsdom's getBoundingClientRect returns zeros, which reads as "not
// visible". Give every element an on-screen rect.
function mockVisible() {
  const orig = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, top: 100, bottom: 200, left: 0, right: 100, width: 100, height: 100, toJSON() {} } as DOMRect;
  };
  return () => {
    Element.prototype.getBoundingClientRect = orig;
  };
}

let restoreVisible: () => void;
beforeEach(() => {
  document.body.innerHTML = "";
  document.title = "Test page";
  restoreVisible = mockVisible();
  clearPageContextCache();
  clearRoutesCache();
});
afterEach(() => {
  restoreVisible();
});

describe("extractPageContext", () => {
  it("reports url, title, pathname, regions, text, links and fields", () => {
    document.body.innerHTML = `
      <div data-ll-region="pricing" data-ll-intent="show pricing tiers">Free $0/mo · Pro $20/mo</div>
      <h1>Welcome</h1>
      <p>This is a longer paragraph describing the product.</p>
      <a href="/contact">Contact us</a>
      <label for="q">Search</label><input id="q" type="search" />
    `;
    const ctx = extractPageContext();
    expect(ctx.url).toBe(window.location.href);
    expect(ctx.title).toBe("Test page");
    expect(ctx.pathname).toBe(window.location.pathname);
    expect(ctx.regions).toEqual([{ id: "pricing", intent: "show pricing tiers", text: "Free $0/mo · Pro $20/mo" }]);
    expect(ctx.visibleText).toContain("H1: Welcome");
    expect(ctx.visibleText).toContain("This is a longer paragraph");
    expect(ctx.visibleLinks).toEqual([{ href: "/contact", text: "Contact us" }]);
    expect(ctx.visibleFields).toEqual([{ label: "Search", type: "search" }]);
    // No multi-step `flow` and no host `extras` in the script-tag widget.
    expect(ctx).not.toHaveProperty("flow");
    expect(ctx).not.toHaveProperty("extras");
  });

  it("discovers every form, with ids from id → name → intent slug → form_<n>", () => {
    document.body.innerHTML = `
      <form id="by-id"><input name="a" /></form>
      <form name="by-name"><input name="b" /></form>
      <form data-ll-intent="Request a demo"><input name="c" /></form>
      <form><input name="d" /></form>
      <form><input name="e" /></form>
    `;
    expect(extractPageContext().forms.map((f) => f.id)).toEqual([
      "by-id",
      "by-name",
      "request-a-demo",
      "form_0",
      "form_1",
    ]);
  });

  it("describes fields with labels, constraints and select options, never values", () => {
    document.body.innerHTML = `
      <form id="contact">
        <label>Your email <input name="email" type="email" required placeholder="you@company.com" value="user@example.com" autocomplete="email" maxlength="80" /></label>
        <input id="phone" type="tel" pattern="\\d{3}-\\d{3}-\\d{4}" aria-label="Phone" value="212-555-0000" />
        <input type="number" min="1" max="10" step="1" />
        <select name="topic"><option value="" disabled selected>Select a subject</option><option value="sales">Sales</option><option value="press">Press</option></select>
        <textarea name="msg" minlength="10">typed secret text</textarea>
        <input type="hidden" name="csrf" value="tok" />
        <button type="submit">Send message</button>
      </form>
    `;
    const ctx = extractPageContext();
    const json = JSON.stringify(ctx);
    for (const v of ["user@example.com", "212-555-0000", "typed secret text", "tok"]) {
      expect(json).not.toContain(v);
    }
    const [form] = ctx.forms;
    expect(form.intent).toBe("Send message");
    expect(form.fields).toEqual([
      {
        name: "email",
        label: "Your email",
        type: "email",
        required: true,
        placeholder: "you@company.com",
        maxLength: 80,
        autocomplete: "email",
      },
      { name: "phone", label: "Phone", type: "tel", pattern: "\\d{3}-\\d{3}-\\d{4}" },
      { name: "field_2", label: "field_2", type: "number", min: "1", max: "10", step: "1" },
      {
        name: "topic",
        label: "topic",
        type: "select",
        placeholderOption: "Select a subject",
        hasEmptyOption: true,
        options: [
          { value: "sales", label: "Sales" },
          { value: "press", label: "Press" },
        ],
      },
      { name: "msg", label: "msg", type: "textarea", minLength: 10 },
    ]);
  });

  it("reports a live validationMessage", () => {
    document.body.innerHTML = `<form id="f"><input name="email" required /></form>`;
    const field = extractPageContext().forms[0].fields[0];
    expect(field.validationMessage).toBeTruthy();
  });

  it("excludes password, autocomplete=off and cc-* fields everywhere", () => {
    document.body.innerHTML = `
      <form id="pay">
        <label for="pw">Password</label><input id="pw" type="password" />
        <label for="otp">Code</label><input id="otp" autocomplete="off" />
        <label for="cc">Card</label><input id="cc" autocomplete="cc-number" />
        <label for="ok">Name</label><input id="ok" name="name" />
      </form>
    `;
    const ctx = extractPageContext();
    expect(ctx.forms[0].fields.map((f) => f.name)).toEqual(["name"]);
    expect(ctx.visibleFields).toEqual([{ label: "Name", type: "text" }]);
  });

  it.each([
    ["bare data-ll-private", "data-ll-private"],
    ['data-ll-private="true"', 'data-ll-private="true"'],
    ["data-ll-skip", "data-ll-skip"],
  ])("skips everything inside a %s subtree", (_label, attr) => {
    document.body.innerHTML = `
      <p>Public paragraph that is long enough.</p>
      <section ${attr}>
        <h2>Hidden heading</h2>
        <p>Private paragraph with account details.</p>
        <a href="/account">Account</a>
        <div data-ll-region="secret">Secret region text</div>
        <label for="s">Secret field</label><input id="s" name="s" />
        <form id="private-form"><input name="x" /></form>
      </section>
    `;
    const ctx = extractPageContext();
    const json = JSON.stringify(ctx);
    expect(ctx.visibleText).toContain("Public paragraph");
    for (const leak of ["Hidden heading", "Private paragraph", "/account", "Secret region", "Secret field", "private-form"]) {
      expect(json).not.toContain(leak);
    }
    expect(ctx.forms).toEqual([]);
    expect(ctx.regions).toEqual([]);
  });

  it("skips hidden / aria-hidden elements and the widget's own .ll-widget DOM", () => {
    document.body.innerHTML = `
      <p hidden>Hidden paragraph is not visible.</p>
      <p aria-hidden="true">Aria hidden paragraph text.</p>
      <div class="ll-widget"><p>Widget chrome paragraph.</p><form id="composer"><input name="m" /></form></div>
    `;
    const ctx = extractPageContext();
    expect(ctx.visibleText).toBe("");
    expect(ctx.forms).toEqual([]);
  });

  it("leaves off-screen text and links out but still lists off-screen forms", () => {
    restoreVisible();
    // jsdom default rect (all zeros) = not in the viewport.
    document.body.innerHTML = `
      <p>Below the fold paragraph text.</p>
      <a href="/x">Link</a>
      <form id="later"><input name="email" /></form>
    `;
    const ctx = extractPageContext();
    expect(ctx.visibleText).toBe("");
    expect(ctx.visibleLinks).toEqual([]);
    expect(ctx.forms.map((f) => f.id)).toEqual(["later"]);
    restoreVisible = mockVisible();
  });

  it("caches for a second but notices a form that mounts late", () => {
    document.body.innerHTML = `<p>First paragraph of the page.</p>`;
    const first = getCachedPageContext();
    expect(getCachedPageContext()).toBe(first);
    document.body.insertAdjacentHTML("beforeend", `<form id="late"><input name="a" /></form>`);
    const second = getCachedPageContext();
    expect(second).not.toBe(first);
    expect(second.forms.map((f) => f.id)).toEqual(["late"]);
  });
});

describe("extractRoutes", () => {
  it("returns a deduped list, internal vs external, with non-navigable hrefs skipped", () => {
    const origin = window.location.origin;
    document.body.innerHTML = `
      <a href="/pricing">Pricing</a>
      <a href="/pricing">Pricing again</a>
      <a href="${origin}/about?x=1#team">About</a>
      <a href="https://other.example.com/docs">Docs</a>
      <a href="#top">Top</a>
      <a href="javascript:void(0)">JS</a>
      <a href="mailto:a@b.co">Mail</a>
      <a href="tel:123">Call</a>
    `;
    expect(extractRoutes()).toEqual([
      { href: "/pricing", text: "Pricing", internal: true },
      { href: "/about?x=1#team", text: "About", internal: true },
      { href: "https://other.example.com/docs", text: "Docs", internal: false },
    ]);
  });

  it("excludes private, data-ll-skip and .ll-widget subtrees", () => {
    document.body.innerHTML = `
      <a href="/public">Public</a>
      <nav data-ll-private><a href="/admin">Admin</a></nav>
      <nav data-ll-skip><a href="/skipped">Skipped</a></nav>
      <div class="ll-widget"><a href="/widget">Widget</a></div>
    `;
    expect(extractRoutes().map((r) => r.href)).toEqual(["/public"]);
  });
});

describe("findFormByLooseId", () => {
  it("resolves id, name, raw and slugged intent, and form_<n>", () => {
    document.body.innerHTML = `
      <form id="a"></form>
      <form name="b"></form>
      <form data-ll-intent="Request a demo"></form>
      <form class="anon0"></form>
      <form class="anon1"></form>
    `;
    const forms = document.querySelectorAll("form");
    expect(findFormByLooseId(document, "a")).toBe(forms[0]);
    expect(findFormByLooseId(document, "b")).toBe(forms[1]);
    expect(findFormByLooseId(document, "Request a demo")).toBe(forms[2]);
    expect(findFormByLooseId(document, "request-a-demo")).toBe(forms[2]);
    expect(findFormByLooseId(document, "form_1")).toBe(forms[4]);
    expect(findFormByLooseId(document, "nope")).toBeNull();
  });

  it("falls back to the only eligible form for an id that matches nothing", () => {
    document.body.innerHTML = `<form id="contact"></form><div data-ll-skip><form id="login"></form></div>`;
    expect(findFormByLooseId(document, "form_0")).toBe(document.getElementById("contact"));
  });

  it("never returns an off-limits form, and never redirects an id that names one", () => {
    document.body.innerHTML = `
      <form id="contact"></form>
      <div data-ll-private><form id="login"></form></div>
      <div data-ll-skip><form name="billing"></form></div>
    `;
    expect(findFormByLooseId(document, "login")).toBeNull();
    expect(findFormByLooseId(document, "billing")).toBeNull();
  });
});

describe("findFieldInForm / findFillableFieldInForm", () => {
  it("resolves name, id, positional and de-duplicated keys exactly as the page context emits them", () => {
    document.body.innerHTML = `
      <form id="f">
        <input name="email" />
        <input id="phone" />
        <input />
        <input type="submit" />
        <textarea></textarea>
        <input id="dup" /><input id="dup" />
      </form>
    `;
    const form = document.getElementById("f") as HTMLFormElement;
    const keys = extractPageContext().forms[0].fields.map((f) => f.name);
    expect(keys).toEqual(["email", "phone", "field_2", "field_3", "dup", "dup__5"]);
    const els = Array.from(form.querySelectorAll("input:not([type=submit]), textarea"));
    keys.forEach((key, i) => expect(findFieldInForm(form, key)).toBe(els[i]));
  });

  it("keeps positional keys aligned when a private field comes first", () => {
    document.body.innerHTML = `
      <form id="f"><input type="password" /><input /><input /></form>
    `;
    const form = document.getElementById("f") as HTMLFormElement;
    const [, first, second] = Array.from(form.querySelectorAll("input"));
    expect(extractPageContext().forms[0].fields.map((f) => f.name)).toEqual(["field_0", "field_1"]);
    expect(findFieldInForm(form, "field_0")).toBe(first);
    expect(findFieldInForm(form, "field_1")).toBe(second);
  });

  it("matches the agent's concept key to a namespaced or labelled field", () => {
    document.body.innerHTML = `
      <form id="f">
        <input name="opening.preferred_name" />
        <label>Work email <input name="q7" /></label>
      </form>
    `;
    const form = document.getElementById("f") as HTMLFormElement;
    expect(findFieldInForm(form, "preferred_name")).toBe(form.querySelector('[name="opening.preferred_name"]'));
    expect(findFieldInForm(form, "email")).toBe(form.querySelector('[name="q7"]'));
    expect(findFieldInForm(form, "zz")).toBeNull();
  });

  it("reports private for password / cc-* / off / data-ll-private fields even when the key matches", () => {
    document.body.innerHTML = `
      <form id="f">
        <input name="pw" type="password" />
        <input name="card" autocomplete="cc-number" />
        <input name="otp" autocomplete="off" />
        <div data-ll-private><input name="ssn" /></div>
        <input name="ok" />
      </form>
    `;
    const form = document.getElementById("f") as HTMLFormElement;
    for (const key of ["pw", "card", "otp", "ssn"]) {
      expect(findFillableFieldInForm(form, key)).toEqual({ el: null, reason: "private" });
    }
    expect(findFillableFieldInForm(form, "missing")).toEqual({ el: null, reason: "not_found" });
    expect(findFillableFieldInForm(form, "ok").el).toBe(form.querySelector('[name="ok"]'));
  });
});

describe("fillField", () => {
  it("uses the prototype's value setter and dispatches input + change", () => {
    document.body.innerHTML = `<input id="i" />`;
    const el = document.getElementById("i") as HTMLInputElement;
    const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!;
    // An own `value` property, like React's value tracker installs,
    // must be bypassed.
    let ownSets = 0;
    Object.defineProperty(el, "value", {
      configurable: true,
      get() {
        return proto.get!.call(this);
      },
      set(v) {
        ownSets++;
        proto.set!.call(this, v);
      },
    });
    const events: string[] = [];
    el.addEventListener("input", () => events.push("input"));
    el.addEventListener("change", () => events.push("change"));
    fillField(el, "hello");
    expect(proto.get!.call(el)).toBe("hello");
    expect(ownSets).toBe(0);
    expect(events).toEqual(["input", "change"]);
  });

  it("checks a checkbox from 'true' and sets a select", () => {
    document.body.innerHTML = `<input id="c" type="checkbox" /><select id="s"><option value="a">A</option><option value="b">B</option></select>`;
    const box = document.getElementById("c") as HTMLInputElement;
    const sel = document.getElementById("s") as HTMLSelectElement;
    fillField(box, "true");
    fillField(sel, "b");
    expect(box.checked).toBe(true);
    expect(sel.value).toBe("b");
  });
});

// Silence the "[LiveLayer]" warnings some lookups print.
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});
