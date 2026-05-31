import { describe, it, expect, vi, beforeEach } from "vitest";
import { ManifestTransport, buildPageContext } from "../manifest/transport";
import type { FieldManifest } from "../manifest";

function makeRoom() {
  return {
    localParticipant: {
      setAttributes: vi.fn().mockResolvedValue(undefined),
    },
  };
}

const FIELDS: FieldManifest[] = [
  { id: "email", label: "Email", kind: "email", value: "", required: true },
];

describe("buildPageContext", () => {
  beforeEach(() => {
    document.title = "Test Page";
  });

  it("builds a PageContext from a manifest", () => {
    const ctx = buildPageContext(FIELDS);
    expect(ctx.elements).toEqual(FIELDS);
    expect(ctx.title).toBe("Test Page");
    expect(ctx.route).toBe("/");
    expect(ctx.step).toBe(0);
    expect(ctx.availableActions).toEqual([]);
  });

  it("uses window.location.pathname for route", () => {
    // jsdom default location.pathname is "/"
    const ctx = buildPageContext([]);
    expect(ctx.route).toBe(window.location.pathname);
  });
});

describe("ManifestTransport", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("publishes via room.localParticipant.setAttributes after the debounce window", async () => {
    const room = makeRoom();
    const t = new ManifestTransport({ room, debounceMs: 50 });
    t.publish(buildPageContext(FIELDS));
    expect(room.localParticipant.setAttributes).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    // flush() is async — drain microtasks
    await vi.runAllTimersAsync();
    expect(room.localParticipant.setAttributes).toHaveBeenCalledTimes(1);
    const call = room.localParticipant.setAttributes.mock.calls[0][0];
    expect(call).toHaveProperty("agent.context");
    const parsed = JSON.parse(call["agent.context"]);
    expect(parsed.elements).toEqual(FIELDS);
  });

  it("coalesces multiple publishes inside the debounce window", async () => {
    const room = makeRoom();
    const t = new ManifestTransport({ room, debounceMs: 50 });
    t.publish(buildPageContext([{ ...FIELDS[0], value: "a" }]));
    t.publish(buildPageContext([{ ...FIELDS[0], value: "b" }]));
    t.publish(buildPageContext([{ ...FIELDS[0], value: "c" }]));
    vi.advanceTimersByTime(100);
    await vi.runAllTimersAsync();
    expect(room.localParticipant.setAttributes).toHaveBeenCalledTimes(1);
    const call = room.localParticipant.setAttributes.mock.calls[0][0];
    const parsed = JSON.parse(call["agent.context"]);
    expect(parsed.elements[0].value).toBe("c");
  });

  it("flush() forces an immediate publish of the pending context", async () => {
    const room = makeRoom();
    const t = new ManifestTransport({ room, debounceMs: 5000 });
    t.publish(buildPageContext(FIELDS));
    expect(room.localParticipant.setAttributes).not.toHaveBeenCalled();
    await t.flush();
    expect(room.localParticipant.setAttributes).toHaveBeenCalledTimes(1);
  });

  it("destroy() drops the pending publish and ignores subsequent calls", async () => {
    const room = makeRoom();
    const t = new ManifestTransport({ room, debounceMs: 50 });
    t.publish(buildPageContext(FIELDS));
    t.destroy();
    vi.advanceTimersByTime(200);
    await vi.runAllTimersAsync();
    expect(room.localParticipant.setAttributes).not.toHaveBeenCalled();
    t.publish(buildPageContext(FIELDS));
    vi.advanceTimersByTime(200);
    await vi.runAllTimersAsync();
    expect(room.localParticipant.setAttributes).not.toHaveBeenCalled();
  });

  it("warns when the serialized payload exceeds 12KB", async () => {
    const room = makeRoom();
    const onOverflow = vi.fn();
    const t = new ManifestTransport({ room, debounceMs: 0, onOverflow });
    // Build a payload large enough to trip the 12KB warning
    const big: FieldManifest[] = Array.from({ length: 300 }, (_, i) => ({
      id: `field_${i}`,
      label: "A".repeat(60),
      kind: "text" as const,
      value: "B".repeat(60),
      required: false,
    }));
    t.publish(buildPageContext(big));
    vi.advanceTimersByTime(10);
    await vi.runAllTimersAsync();
    expect(onOverflow).toHaveBeenCalled();
    expect(onOverflow.mock.calls[0][0]).toBeGreaterThan(12 * 1024);
  });

  it("swallows setAttributes errors so publish failure doesn't crash the session", async () => {
    const room = {
      localParticipant: {
        setAttributes: vi.fn().mockRejectedValue(new Error("room closed")),
      },
    };
    const t = new ManifestTransport({ room, debounceMs: 0 });
    t.publish(buildPageContext(FIELDS));
    // The transport awaits setAttributes internally and catches.
    // Verify by NOT having an unhandled rejection bubble up here.
    await expect(t.flush()).resolves.toBeUndefined();
    expect(room.localParticipant.setAttributes).toHaveBeenCalled();
  });

  it("skips setAttributes when the serialized context is unchanged", async () => {
    const room = makeRoom();
    const t = new ManifestTransport({ room, debounceMs: 0 });
    t.publish(buildPageContext(FIELDS));
    await vi.runAllTimersAsync();
    expect(room.localParticipant.setAttributes).toHaveBeenCalledTimes(1);
    // A DOM mutation from the agent's own streaming UI re-triggers
    // publish() with identical content — it must NOT hit the wire again.
    t.publish(buildPageContext(FIELDS));
    await vi.runAllTimersAsync();
    expect(room.localParticipant.setAttributes).toHaveBeenCalledTimes(1);
  });

  it("re-publishes when the manifest content actually changes", async () => {
    const room = makeRoom();
    const t = new ManifestTransport({ room, debounceMs: 0 });
    t.publish(buildPageContext([{ ...FIELDS[0], value: "a" }]));
    await vi.runAllTimersAsync();
    t.publish(buildPageContext([{ ...FIELDS[0], value: "b" }]));
    await vi.runAllTimersAsync();
    expect(room.localParticipant.setAttributes).toHaveBeenCalledTimes(2);
  });

  it("retries an unchanged publish after a failed setAttributes", async () => {
    const setAttributes = vi
      .fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue(undefined);
    const room = { localParticipant: { setAttributes } };
    const t = new ManifestTransport({ room, debounceMs: 0 });
    t.publish(buildPageContext(FIELDS));
    await vi.runAllTimersAsync(); // 1st attempt rejects
    // Same content again: because the first publish failed, we must
    // retry rather than treat it as already-published.
    t.publish(buildPageContext(FIELDS));
    await vi.runAllTimersAsync();
    expect(setAttributes).toHaveBeenCalledTimes(2);
  });
});
