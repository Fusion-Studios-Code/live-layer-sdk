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
    // Replace setItem directly rather than using vi.spyOn — the
    // vitest.setup shim installs an own-property setItem (rather
    // than one on Storage.prototype) when running on Node 20 +
    // jsdom 29, and vi.spyOn's prototype-based interception
    // doesn't always wrap it. Direct assignment + manual restore
    // works against real jsdom AND the shim, on both Node 20 and 24.
    const originalSetItem = localStorage.setItem;
    let warnCount = 0;
    const originalWarn = console.warn;
    console.warn = () => { warnCount++; };
    localStorage.setItem = () => {
      throw new DOMException("QuotaExceededError");
    };

    try {
      // Should not throw — saveSession's try/catch must swallow.
      expect(() => saveSession(makeSession())).not.toThrow();
      // And it must have logged the failure.
      expect(warnCount).toBeGreaterThan(0);
    } finally {
      localStorage.setItem = originalSetItem;
      console.warn = originalWarn;
    }
  });
});
