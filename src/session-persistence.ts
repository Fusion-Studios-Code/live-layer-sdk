// ─── Session Persistence ─────────────────────────────────────────────
// Stores LiveKit session info in localStorage so the widget can rejoin
// a room after page reloads within a 30-second grace period.

export interface StoredSession {
  sessionToken: string;
  roomName: string;
  agentId: string;
  timestamp: number;
}

const STORAGE_PREFIX = "__livelayer_session_";
const GRACE_PERIOD_MS = 30_000;

function storageKey(agentId: string): string {
  return `${STORAGE_PREFIX}${agentId}`;
}

/**
 * Persist session info after a successful LiveKit room connection.
 */
export function saveSession(session: StoredSession): void {
  try {
    localStorage.setItem(
      storageKey(session.agentId),
      JSON.stringify(session),
    );
  } catch {
    // localStorage may be unavailable (private browsing, SSR, etc.)
    console.warn("[LiveLayer] Unable to persist session to localStorage");
  }
}

/**
 * Retrieve a still-valid session for the given agent, or null if expired / missing.
 */
export function loadSession(agentId: string): StoredSession | null {
  try {
    const raw = localStorage.getItem(storageKey(agentId));
    if (!raw) return null;

    const session: StoredSession = JSON.parse(raw);
    const age = Date.now() - session.timestamp;

    if (age > GRACE_PERIOD_MS) {
      clearSession(agentId);
      return null;
    }

    return session;
  } catch {
    return null;
  }
}

/**
 * Clear persisted session (called on explicit widget close).
 */
export function clearSession(agentId: string): void {
  try {
    localStorage.removeItem(storageKey(agentId));
  } catch {
    // noop
  }
}
