// ─── page tools: the worker protocol, through handlePageCommand ───────
// Every request the worker waits on (live-layer agent/lib/tools/
// navigation-tools.ts) gets exactly one reply in the shape the worker
// reads, with the requestId echoed, on the reliable channel, with no
// topic, inside one data packet. Blocked capabilities are answered with
// a refusal instead of silence.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blockedWarn, isAllowed, type AgentCapability } from "../handle-agent-command";
import { MAX_DATA_PAYLOAD_BYTES } from "../page-tools/data-payload";
import { clearPageContextCache } from "../page-tools/page-context";
import { clearRoutesCache } from "../page-tools/routes";
import {
  CAPABILITY_BLOCKED,
  READ_PAGE_BLOCKED_MESSAGE,
  ROUTES_BLOCKED_MESSAGE,
  SUBMIT_BLOCKED_MESSAGE,
  handlePageCommand,
  type DataPublisher,
} from "../page-tools";

type Reply = Record<string, any>;

function fakePublisher() {
  const replies: Reply[] = [];
  const sizes: number[] = [];
  const publishData = vi.fn(async (data: Uint8Array, _opts: unknown) => {
    sizes.push(data.byteLength);
    replies.push(JSON.parse(new TextDecoder().decode(data)));
  });
  return { publisher: { publishData }, publishData, replies, sizes };
}

/** Same call the widget makes for every agent command. */
function dispatch(cmd: Record<string, unknown>, capabilities: AgentCapability[] | undefined, publisher: DataPublisher | null) {
  return handlePageCommand(cmd, {
    isAllowed: (cap) => isAllowed(capabilities, cap),
    publisher,
    warnBlocked: blockedWarn,
  });
}

function run(
  cmd: Record<string, unknown>,
  opts: { capabilities?: AgentCapability[]; publisher?: ReturnType<typeof fakePublisher> } = {},
) {
  const pub = opts.publisher ?? fakePublisher();
  const handled = dispatch(cmd, opts.capabilities, pub.publisher);
  return { ...pub, handled };
}

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
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  document.body.innerHTML = "";
  restoreVisible = mockVisible();
  clearPageContextCache();
  clearRoutesCache();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  restoreVisible();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─── request_page_context ─────────────────────────────────────────────

describe("request_page_context → page_context", () => {
  it("answers with the page snapshot and the echoed requestId, reliable and with no topic", () => {
    document.body.innerHTML = `
      <h1>Pricing</h1>
      <form id="contact"><label>Email <input name="email" type="email" value="me@x.co" /></label></form>
    `;
    const { handled, replies, publishData } = run({ type: "request_page_context", requestId: "req-1" });
    expect(handled).toBe(true);
    expect(publishData).toHaveBeenCalledTimes(1);
    // Exactly { reliable: true }: no topic, no destination filter.
    expect(publishData.mock.calls[0][1]).toEqual({ reliable: true });
    const [reply] = replies;
    expect(reply.type).toBe("page_context");
    expect(reply.requestId).toBe("req-1");
    expect(reply.context.visibleText).toContain("H1: Pricing");
    expect(reply.context.forms).toEqual([
      { id: "contact", intent: "Pricing", fields: [{ name: "email", label: "Email", type: "email" }] },
    ]);
    expect(JSON.stringify(reply)).not.toContain("me@x.co");
  });

  it("omits requestId when the request had none", () => {
    const { replies } = run({ type: "request_page_context" });
    expect(replies[0].type).toBe("page_context");
    expect(replies[0]).not.toHaveProperty("requestId");
  });

  it("trims an oversized snapshot to fit one data packet and says what it cut", () => {
    // Ten forms × 30 selects × 20 options with long values: far over 60 KB.
    const option = (j: number) => `<option value="${"v".repeat(200)}${j}">Option label ${j}</option>`;
    const select = (i: number) => `<select name="s${i}">${Array.from({ length: 20 }, (_, j) => option(j)).join("")}</select>`;
    document.body.innerHTML = Array.from(
      { length: 10 },
      (_, f) => `<form id="f${f}">${Array.from({ length: 30 }, (_, i) => select(i)).join("")}</form>`,
    ).join("");
    const { replies, sizes } = run({ type: "request_page_context", requestId: "big" });
    expect(sizes[0]).toBeLessThanOrEqual(MAX_DATA_PAYLOAD_BYTES);
    const ctx = replies[0].context;
    expect(replies[0].requestId).toBe("big");
    expect(ctx.truncated).toContain("formOptions");
    expect(ctx.forms).toHaveLength(10);
    expect(ctx.forms[0].fields[0]).not.toHaveProperty("options");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("reply trimmed to fit"));
  });

  it("refuses with a reason the worker passes to the LLM when read_page is blocked", () => {
    document.body.innerHTML = `<h1>Secret dashboard</h1><form id="f"><input name="a" /></form>`;
    const { handled, replies } = run(
      { type: "request_page_context", requestId: "req-2" },
      { capabilities: ["navigate", "fill_forms"] },
    );
    expect(handled).toBe(true);
    expect(replies).toHaveLength(1);
    const refusal = { error: CAPABILITY_BLOCKED, capability: "read_page", message: READ_PAGE_BLOCKED_MESSAGE };
    // The worker returns JSON.stringify(resp.context) to the LLM, so the
    // refusal is inside `context` too.
    expect(replies[0]).toEqual({ type: "page_context", requestId: "req-2", ...refusal, context: refusal });
    expect(JSON.stringify(replies[0])).not.toContain("Secret dashboard");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('capability "read_page" not in allowlist'));
  });

  it("does not throw when there is no room to answer on", () => {
    expect(dispatch({ type: "request_page_context", requestId: "r" }, undefined, null)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not connected"));
  });
});

// ─── request_routes ───────────────────────────────────────────────────

describe("request_routes → routes", () => {
  it("answers with the page's links and the echoed requestId", () => {
    document.body.innerHTML = `
      <a href="/pricing">Pricing</a>
      <a href="https://elsewhere.example/x">Elsewhere</a>
      <footer data-ll-private><a href="/admin">Admin</a></footer>
    `;
    const { replies, publishData } = run({ type: "request_routes", requestId: "req-3" });
    expect(publishData.mock.calls[0][1]).toEqual({ reliable: true });
    expect(replies).toEqual([
      {
        type: "routes",
        requestId: "req-3",
        routes: [
          { href: "/pricing", text: "Pricing", internal: true },
          { href: "https://elsewhere.example/x", text: "Elsewhere", internal: false },
        ],
      },
    ]);
  });

  it("sends the routes that fit one data packet", () => {
    document.body.innerHTML = Array.from(
      { length: 200 },
      (_, i) => `<a href="/p/${i}/${"x".repeat(300)}">${"Link text ".repeat(12)}${i}</a>`,
    ).join("");
    const { replies, sizes } = run({ type: "request_routes", requestId: "req-4" });
    expect(sizes[0]).toBeLessThanOrEqual(MAX_DATA_PAYLOAD_BYTES);
    expect(replies[0].routes.length).toBeGreaterThan(0);
    expect(replies[0].routes.length).toBeLessThan(200);
    expect(replies[0].routes[0].href).toBe(`/p/0/${"x".repeat(300)}`);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/sent \d+ of 200 routes/));
  });

  it("refuses with an empty list and a reason when read_page is blocked", () => {
    document.body.innerHTML = `<a href="/pricing">Pricing</a>`;
    const { replies } = run({ type: "request_routes", requestId: "req-5" }, { capabilities: ["navigate"] });
    expect(replies).toEqual([
      {
        type: "routes",
        requestId: "req-5",
        error: CAPABILITY_BLOCKED,
        capability: "read_page",
        message: ROUTES_BLOCKED_MESSAGE,
        routes: [],
      },
    ]);
  });
});

// ─── submit_form ──────────────────────────────────────────────────────

describe("submit_form → form_submitted / form_submit_blocked / form_submit_uncertain", () => {
  const contactForm = `
    <div id="wrap">
      <form id="contact">
        <label for="email">Email</label><input id="email" name="email" type="email" required />
        <textarea name="message"></textarea>
        <button type="submit">Send</button>
      </form>
    </div>
  `;
  const fill = () => {
    (document.querySelector('[name="email"]') as HTMLInputElement).value = "dean@fssn.co";
    (document.querySelector('[name="message"]') as HTMLTextAreaElement).value = "Hello there";
  };
  const form = () => document.getElementById("contact") as HTMLFormElement;

  it("reports form_submitted for a native submit nothing prevents", async () => {
    document.body.innerHTML = contactForm;
    fill();
    let submits = 0;
    form().addEventListener("submit", () => submits++);
    // jsdom cannot navigate, so fire the submit event the way
    // requestSubmit does, without jsdom's "not implemented" default action.
    form().requestSubmit = function (this: HTMLFormElement) {
      this.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    };
    const { replies } = run({ type: "submit_form", formId: "contact", requestId: "s1" });
    await Promise.resolve();
    expect(submits).toBe(1);
    expect(replies).toEqual([{ type: "form_submitted", formId: "contact", requestId: "s1" }]);
  });

  it("blocks on unmet HTML5 constraints, names the field, and does not submit", () => {
    document.body.innerHTML = contactForm;
    let submits = 0;
    form().addEventListener("submit", () => submits++);
    const { replies } = run({ type: "submit_form", formId: "contact", requestId: "s2" });
    expect(submits).toBe(0);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      type: "form_submit_blocked",
      formId: "contact",
      reason: "validation",
      requestId: "s2",
    });
    expect(replies[0].invalidFields).toEqual([expect.stringMatching(/^Email: .+/)]);
  });

  describe("SPA-handled submit (preventDefault): watches the form for about 2 s", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      document.body.innerHTML = contactForm;
      fill();
    });

    const spa = (after?: () => void, delay = 100) =>
      form().addEventListener("submit", (e) => {
        e.preventDefault();
        if (after) setTimeout(after, delay);
      });

    it("form cleared after send → form_submitted (form_reset), even though its required field is now empty", async () => {
      spa(() => form().reset());
      const { replies } = run({ type: "submit_form", formId: "contact", requestId: "s3" });
      await vi.advanceTimersByTimeAsync(250);
      expect(replies).toEqual([{ type: "form_submitted", formId: "contact", reason: "form_reset", requestId: "s3" }]);
    });

    it("a required field the page empties is not a validation failure", async () => {
      // Only the (required) email is cleared; the message stays. React
      // reports this as blocked ("validation"); the outcome is unknown.
      spa(() => ((document.querySelector('[name="email"]') as HTMLInputElement).value = ""));
      const { replies } = run({ type: "submit_form", formId: "contact", requestId: "s3b" });
      await vi.advanceTimersByTimeAsync(2300);
      expect(replies).toEqual([
        { type: "form_submit_uncertain", formId: "contact", reason: "spa_prevented", requestId: "s3b" },
      ]);
    });

    it("success message appears → form_submitted (success_text)", async () => {
      spa(() => document.getElementById("wrap")!.insertAdjacentHTML("beforeend", "<p>Thanks! We'll be in touch.</p>"));
      const { replies } = run({ type: "submit_form", formId: "contact", requestId: "s4" });
      await vi.advanceTimersByTimeAsync(250);
      expect(replies).toEqual([{ type: "form_submitted", formId: "contact", reason: "success_text", requestId: "s4" }]);
    });

    it("form removed → form_submitted (form_removed)", async () => {
      spa(() => form().remove());
      const { replies } = run({ type: "submit_form", formId: "contact", requestId: "s5" });
      await vi.advanceTimersByTimeAsync(250);
      expect(replies).toEqual([{ type: "form_submitted", formId: "contact", reason: "form_removed", requestId: "s5" }]);
    });

    it("validation error appears → form_submit_blocked (validation) with the field", async () => {
      spa(() => (document.querySelector('[name="email"]') as HTMLInputElement).setCustomValidity("Email already registered"));
      const { replies } = run({ type: "submit_form", formId: "contact", requestId: "s6" });
      await vi.advanceTimersByTimeAsync(250);
      expect(replies).toEqual([
        {
          type: "form_submit_blocked",
          formId: "contact",
          reason: "validation",
          invalidFields: ["Email: Email already registered"],
          requestId: "s6",
        },
      ]);
    });

    it("nothing decisive → form_submit_uncertain (spa_prevented) after ~2.2 s, well inside the worker's 6 s", async () => {
      spa();
      const { replies } = run({ type: "submit_form", formId: "contact", requestId: "s7" });
      await vi.advanceTimersByTimeAsync(2100);
      expect(replies).toEqual([]);
      await vi.advanceTimersByTimeAsync(150);
      expect(replies).toEqual([
        { type: "form_submit_uncertain", formId: "contact", reason: "spa_prevented", requestId: "s7" },
      ]);
      // Exactly one reply, ever.
      await vi.advanceTimersByTimeAsync(5000);
      expect(replies).toHaveLength(1);
    });

    it("a slow handler that clears the form late still counts", async () => {
      spa(() => form().reset(), 1500);
      const { replies } = run({ type: "submit_form", formId: "contact", requestId: "s8" });
      await vi.advanceTimersByTimeAsync(1400);
      expect(replies).toEqual([]);
      await vi.advanceTimersByTimeAsync(400);
      expect(replies[0]).toMatchObject({ type: "form_submitted", reason: "form_reset" });
    });
  });

  it("blocks with reason exception when requestSubmit throws", () => {
    document.body.innerHTML = contactForm;
    fill();
    form().requestSubmit = () => {
      throw new Error("boom");
    };
    const { replies } = run({ type: "submit_form", formId: "contact", requestId: "s9" });
    expect(replies).toEqual([
      { type: "form_submit_blocked", formId: "contact", reason: "exception", invalidFields: [], requestId: "s9" },
    ]);
  });

  it("blocks when the submit event never fires", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = contactForm;
    fill();
    form().requestSubmit = () => {};
    const { replies } = run({ type: "submit_form", formId: "contact", requestId: "s10" });
    await vi.advanceTimersByTimeAsync(499);
    expect(replies).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(replies).toEqual([
      { type: "form_submit_blocked", formId: "contact", reason: "validation", invalidFields: [], requestId: "s10" },
    ]);
  });

  it("answers at once when the form id matches no form the agent may use", () => {
    document.body.innerHTML = `<form id="a"></form><form id="b"></form><div data-ll-private><form id="login"><input name="u" /></form></div>`;
    let submits = 0;
    document.addEventListener("submit", () => submits++);
    const notFound = run({ type: "submit_form", formId: "nope", requestId: "s11" });
    const privateForm = run({ type: "submit_form", formId: "login", requestId: "s12" });
    const missing = run({ type: "submit_form", requestId: "s13" });
    expect(submits).toBe(0);
    expect(notFound.replies).toEqual([
      { type: "form_submit_blocked", formId: "nope", reason: "form_not_found", invalidFields: [], requestId: "s11" },
    ]);
    expect(privateForm.replies).toEqual([
      { type: "form_submit_blocked", formId: "login", reason: "form_not_found", invalidFields: [], requestId: "s12" },
    ]);
    expect(missing.replies).toEqual([
      { type: "form_submit_blocked", formId: "", reason: "missing_form_id", invalidFields: [], requestId: "s13" },
    ]);
  });

  it("refuses, without submitting, when submit_forms is blocked", () => {
    document.body.innerHTML = contactForm;
    fill();
    let submits = 0;
    form().addEventListener("submit", (e) => {
      submits++;
      e.preventDefault();
    });
    const { replies } = run(
      { type: "submit_form", formId: "contact", requestId: "s14" },
      { capabilities: ["read_page", "fill_forms"] },
    );
    expect(submits).toBe(0);
    expect(replies).toEqual([
      {
        type: "form_submit_blocked",
        formId: "contact",
        reason: CAPABILITY_BLOCKED,
        invalidFields: [],
        error: CAPABILITY_BLOCKED,
        capability: "submit_forms",
        message: SUBMIT_BLOCKED_MESSAGE,
        requestId: "s14",
      },
    ]);
  });
});

// ─── fill_form / focus_field ──────────────────────────────────────────

describe("fill_form / focus_field (fire-and-forget)", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <form id="signup">
        <input name="email" />
        <input id="full-name" />
        <input />
        <input name="pw" type="password" />
        <select name="plan"><option value="">Pick one</option><option value="pro">Pro</option></select>
        <input name="terms" type="checkbox" />
      </form>
      <div data-ll-private><form id="vault"><input name="secret" /></form></div>
    `;
  });
  const val = (sel: string) => (document.querySelector(sel) as HTMLInputElement).value;

  it("fills fields by the keys the page context gave the agent, and sends nothing back", () => {
    const events: string[] = [];
    document.addEventListener("input", (e) => events.push(`input:${(e.target as HTMLInputElement).name || (e.target as HTMLInputElement).id}`));
    const { handled, publishData } = run({
      type: "fill_form",
      formId: "signup",
      values: { email: "dean@fssn.co", "full-name": "Dean", field_2: "anon", plan: "pro", terms: "true" },
    });
    expect(handled).toBe(true);
    expect(publishData).not.toHaveBeenCalled();
    expect(val('[name="email"]')).toBe("dean@fssn.co");
    expect(val("#full-name")).toBe("Dean");
    expect((document.querySelectorAll("#signup input")[2] as HTMLInputElement).value).toBe("anon");
    expect(val('[name="plan"]')).toBe("pro");
    expect((document.querySelector('[name="terms"]') as HTMLInputElement).checked).toBe(true);
    expect(events).toContain("input:email");
  });

  it("never fills a private field or a form in a private subtree", () => {
    run({ type: "fill_form", formId: "signup", values: { pw: "hunter2" } });
    run({ type: "fill_form", formId: "vault", values: { secret: "x" } });
    expect(val('[name="pw"]')).toBe("");
    expect(val('[name="secret"]')).toBe("");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('field "pw" is privacy-protected'));
  });

  it("does nothing when fill_forms is blocked", () => {
    const { publishData } = run(
      { type: "fill_form", formId: "signup", values: { email: "a@b.co" } },
      { capabilities: ["read_page"] },
    );
    run({ type: "focus_field", formId: "signup", fieldName: "email" }, { capabilities: ["read_page"] });
    expect(val('[name="email"]')).toBe("");
    expect(document.activeElement).not.toBe(document.querySelector('[name="email"]'));
    expect(publishData).not.toHaveBeenCalled();
  });

  it("focus_field focuses the named field, but never a private one", () => {
    run({ type: "focus_field", formId: "signup", fieldName: "full-name" });
    expect(document.activeElement).toBe(document.getElementById("full-name"));
    run({ type: "focus_field", formId: "signup", fieldName: "pw" });
    expect(document.activeElement).toBe(document.getElementById("full-name"));
  });
});

describe("handlePageCommand scope", () => {
  it("leaves every other command type to handleAgentCommand", () => {
    for (const type of ["navigate", "click", "emit_event", "advance_step", "task_completed", "unknown"]) {
      expect(dispatch({ type }, undefined, fakePublisher().publisher)).toBe(false);
    }
  });
});
