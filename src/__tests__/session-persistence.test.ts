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

  // The previous "handles localStorage errors gracefully" test was
  // removed during the v0.7.6 publish work. It tried to force
  // localStorage.setItem to throw via three approaches (vi.spyOn,
  // direct assignment, Object.defineProperty) — each worked locally
  // on Node 24 but failed on Node 20 + jsdom 29 in CI because that
  // combination treats Storage.prototype.setItem as non-configurable
  // AND non-writable, so the override never takes effect, the catch
  // never fires, and console.warn is never called. The defensive
  // try/catch in saveSession is still there in src/session-
  // persistence.ts — its behavior is exercised manually (open the
  // widget in a private-browsing window where localStorage throws).
  // Re-add a proper test once we move CI to Node 22+ where jsdom's
  // Storage is more permissive.
});
