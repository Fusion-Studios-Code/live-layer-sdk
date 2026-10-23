// ─── handle-agent-command: private subtrees for click and the task painter ──
// `click` and the `task_field_updated` painter use the same subtree rule
// as the page tools (page-tools/privacy.ts PRIVATE_SUBTREE): nothing
// inside [data-ll-private] (any value), [data-ll-skip] or .ll-widget is
// clicked or written to.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleAgentCommand } from "../handle-agent-command";

beforeEach(() => {
  document.body.innerHTML = "";
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

const OFF_LIMITS = [
  ["bare data-ll-private", "data-ll-private"],
  ['data-ll-private="true"', 'data-ll-private="true"'],
  ["data-ll-skip", "data-ll-skip"],
  [".ll-widget", 'class="ll-widget"'],
] as const;

describe("click", () => {
  it.each(OFF_LIMITS)("never clicks inside a %s subtree", (_label, attr) => {
    document.body.innerHTML = `<div ${attr}><button id="b">Delete account</button></div>`;
    let clicks = 0;
    document.getElementById("b")!.addEventListener("click", () => clicks++);
    expect(handleAgentCommand({ type: "click", selector: "#b" }, {})).toBe(true);
    expect(clicks).toBe(0);
  });

  it("clicks an ordinary element", () => {
    document.body.innerHTML = `<button id="b">Show pricing</button>`;
    let clicks = 0;
    document.getElementById("b")!.addEventListener("click", () => clicks++);
    handleAgentCommand({ type: "click", selector: "#b" }, {});
    expect(clicks).toBe(1);
  });
});

describe("task_field_updated painter", () => {
  const paint = () =>
    handleAgentCommand(
      {
        type: "task_field_updated",
        fieldId: "email",
        value: "dean@fssn.co",
        kind: "email",
        source: "agent",
      } as unknown as Record<string, unknown>,
      {},
    );

  it.each(OFF_LIMITS)("never writes into a field inside a %s subtree", (_label, attr) => {
    document.body.innerHTML = `<div ${attr}><input name="email" /></div>`;
    paint();
    expect((document.querySelector('[name="email"]') as HTMLInputElement).value).toBe("");
  });

  it("never writes into a field that carries a bare data-ll-private itself", () => {
    document.body.innerHTML = `<input name="email" data-ll-private />`;
    paint();
    expect((document.querySelector('[name="email"]') as HTMLInputElement).value).toBe("");
  });

  it("writes into an ordinary field", () => {
    document.body.innerHTML = `<input name="email" />`;
    paint();
    expect((document.querySelector('[name="email"]') as HTMLInputElement).value).toBe("dean@fssn.co");
  });
});
