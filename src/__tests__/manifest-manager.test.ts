import { describe, it, expect, vi, beforeEach } from "vitest";
import { ManifestManager } from "../manifest/manager";
import { clearRegistry, registerFields } from "../manifest/registry";

function makeRoom() {
  return {
    localParticipant: {
      setAttributes: vi.fn().mockResolvedValue(undefined),
    },
  };
}

async function flushPublish(ms = 250) {
  vi.advanceTimersByTime(ms);
  await vi.runAllTimersAsync();
}

beforeEach(() => {
  document.body.innerHTML = "";
  clearRegistry();
  vi.useFakeTimers();
});

describe("ManifestManager — initial publish on start", () => {
  it("scans the DOM and publishes the manifest on start()", async () => {
    document.body.innerHTML = `<form><input name="email" type="email" value="a@b.com" /></form>`;
    const room = makeRoom();
    const m = new ManifestManager({ room, publishDebounceMs: 50, rescanDebounceMs: 50 });
    m.start();
    await flushPublish();
    expect(room.localParticipant.setAttributes).toHaveBeenCalled();
    const parsed = JSON.parse(
      room.localParticipant.setAttributes.mock.calls[0][0]["agent.context"],
    );
    expect(parsed.elements).toEqual([
      expect.objectContaining({ id: "email", kind: "email", value: "a@b.com" }),
    ]);
    m.stop();
  });

  it("publishes again when a tracked input fires `input`", async () => {
    document.body.innerHTML = `<form><input name="bn" /></form>`;
    const room = makeRoom();
    const m = new ManifestManager({ room, publishDebounceMs: 20, rescanDebounceMs: 20 });
    m.start();
    await flushPublish(50);
    const initialCalls = room.localParticipant.setAttributes.mock.calls.length;

    const input = document.querySelector("input")!;
    input.value = "Acme";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    await flushPublish(100);
    expect(
      room.localParticipant.setAttributes.mock.calls.length,
    ).toBeGreaterThan(initialCalls);
    const lastCall = room.localParticipant.setAttributes.mock.calls.at(-1)![0];
    const parsed = JSON.parse(lastCall["agent.context"]);
    expect(parsed.elements[0].value).toBe("Acme");
    m.stop();
  });

  it("does NOT republish on identical input events", async () => {
    document.body.innerHTML = `<form><input name="bn" value="Acme" /></form>`;
    const room = makeRoom();
    const m = new ManifestManager({ room, publishDebounceMs: 20, rescanDebounceMs: 20 });
    m.start();
    await flushPublish();
    const callsAfterInitial = room.localParticipant.setAttributes.mock.calls.length;

    const input = document.querySelector("input")!;
    // Same value as already in the manifest
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flushPublish(100);
    expect(room.localParticipant.setAttributes.mock.calls.length).toBe(
      callsAfterInitial,
    );
    m.stop();
  });

  it("merges programmatic registerFields entries with auto-discovered ones", async () => {
    document.body.innerHTML = `<form><input name="auto" value="from-dom" /></form>`;
    registerFields([
      {
        id: "from-spa",
        label: "From SPA",
        kind: "text",
        value: "spa-value",
        required: true,
      },
    ]);
    const room = makeRoom();
    const m = new ManifestManager({ room, publishDebounceMs: 10, rescanDebounceMs: 10 });
    m.start();
    await flushPublish();
    const parsed = JSON.parse(
      room.localParticipant.setAttributes.mock.calls.at(-1)![0]["agent.context"],
    );
    const ids = parsed.elements.map((e: { id: string }) => e.id);
    expect(ids).toContain("auto");
    expect(ids).toContain("from-spa");
    m.stop();
  });

  it("programmatic registrations win on id conflict", async () => {
    document.body.innerHTML = `<form><input name="email" value="dom-value" /></form>`;
    registerFields([
      {
        id: "email",
        label: "Email (override)",
        kind: "email",
        value: "spa-override",
        required: true,
      },
    ]);
    const room = makeRoom();
    const m = new ManifestManager({ room, publishDebounceMs: 10, rescanDebounceMs: 10 });
    m.start();
    await flushPublish();
    const parsed = JSON.parse(
      room.localParticipant.setAttributes.mock.calls.at(-1)![0]["agent.context"],
    );
    const email = parsed.elements.find((e: { id: string }) => e.id === "email");
    expect(email.label).toBe("Email (override)");
    expect(email.value).toBe("spa-override");
    m.stop();
  });

  it("re-scans the DOM when new <input> elements are mounted (SPA navigation)", async () => {
    document.body.innerHTML = `<form><input name="first" /></form>`;
    const room = makeRoom();
    const m = new ManifestManager({ room, publishDebounceMs: 10, rescanDebounceMs: 10 });
    m.start();
    await flushPublish();
    const initialCount = JSON.parse(
      room.localParticipant.setAttributes.mock.calls.at(-1)![0]["agent.context"],
    ).elements.length;

    // Simulate React mounting a new field
    const form = document.querySelector("form")!;
    const added = document.createElement("input");
    added.name = "added";
    form.appendChild(added);

    // MutationObserver fires asynchronously — give it a tick
    await flushPublish(100);
    const lastCall = room.localParticipant.setAttributes.mock.calls.at(-1)![0];
    const parsed = JSON.parse(lastCall["agent.context"]);
    expect(parsed.elements.length).toBeGreaterThan(initialCount);
    expect(parsed.elements.map((e: { id: string }) => e.id)).toContain("added");
    m.stop();
  });

  it("stop() detaches listeners — subsequent input events do not publish", async () => {
    document.body.innerHTML = `<form><input name="bn" /></form>`;
    const room = makeRoom();
    const m = new ManifestManager({ room, publishDebounceMs: 10, rescanDebounceMs: 10 });
    m.start();
    await flushPublish();
    m.stop();
    const callsBeforeChange = room.localParticipant.setAttributes.mock.calls.length;

    const input = document.querySelector("input")!;
    input.value = "Acme";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flushPublish(200);
    expect(room.localParticipant.setAttributes.mock.calls.length).toBe(
      callsBeforeChange,
    );
  });

  it("skipAutoDiscover=true still surfaces programmatic registrations", async () => {
    document.body.innerHTML = `<form><input name="auto" value="ignored" /></form>`;
    registerFields([
      { id: "manual", label: "M", kind: "text", value: "v", required: false },
    ]);
    const room = makeRoom();
    const m = new ManifestManager({
      room,
      skipAutoDiscover: true,
      publishDebounceMs: 10,
    });
    m.start();
    await flushPublish();
    const parsed = JSON.parse(
      room.localParticipant.setAttributes.mock.calls.at(-1)![0]["agent.context"],
    );
    expect(parsed.elements.map((e: { id: string }) => e.id)).toEqual(["manual"]);
    m.stop();
  });
});
