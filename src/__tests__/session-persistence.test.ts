import { describe, it, expect, beforeEach, vi } from "vitest";
import { saveSession, loadSession, clearSession, type StoredSession } from "../session-persistence";

describe("session-persistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  const makeSession = (overrides?: Partial<StoredSession>): StoredSession => ({
    sessionToken: "tok_abc",
    roomName: "room_xyz",
    agentId: "agent_123",
    timestamp: Date.now(),
    ...overrides,
  });

  it("saves and loads a session", () => {
    const session = makeSession();
    saveSession(session);

    const loaded = loadSession("agent_123");
    expect(loaded).not.toBeNull();
    expect(loaded!.sessionToken).toBe("tok_abc");
    expect(loaded!.roomName).toBe("room_xyz");
    expect(loaded!.agentId).toBe("agent_123");
  });

  it("uses __livelayer_session_{agentId} as the storage key", () => {
    const session = makeSession({ agentId: "agent_foo" });
    saveSession(session);

    const raw = localStorage.getItem("__livelayer_session_agent_foo");
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!).agentId).toBe("agent_foo");
  });

  it("returns null for expired sessions (> 30s)", () => {
    const session = makeSession({ timestamp: Date.now() - 31_000 });
    saveSession(session);

    const loaded = loadSession("agent_123");
    expect(loaded).toBeNull();
  });

  it("returns session within 30s grace period", () => {
    const session = makeSession({ timestamp: Date.now() - 25_000 });
    saveSession(session);

    const loaded = loadSession("agent_123");
    expect(loaded).not.toBeNull();
  });

  it("clears expired sessions from localStorage", () => {
    const session = makeSession({ timestamp: Date.now() - 31_000 });
    saveSession(session);

    loadSession("agent_123"); // triggers cleanup
    expect(localStorage.getItem("__livelayer_session_agent_123")).toBeNull();
  });

  it("clearSession removes the entry", () => {
    const session = makeSession();
    saveSession(session);
    expect(localStorage.getItem("__livelayer_session_agent_123")).not.toBeNull();

    clearSession("agent_123");
    expect(localStorage.getItem("__livelayer_session_agent_123")).toBeNull();
  });

  it("returns null for non-existent agent", () => {
    expect(loadSession("agent_nonexistent")).toBeNull();
  });

  it("handles localStorage errors gracefully", () => {
    // Spy on the live `localStorage.setItem` rather than
    // `Storage.prototype.setItem` — the vitest.setup shim installs a
    // plain object (not a Storage subclass) when jsdom doesn't
    // expose a real Storage instance, so prototype-based spies
    // don't intercept calls. Direct instance spy works against
    // both real-jsdom and the shim.
    const spy = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Should not throw
    expect(() => saveSession(makeSession())).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();

    spy.mockRestore();
    warnSpy.mockRestore();
  });
});
