// ─── vitest setup ────────────────────────────────────────────────────
// Polyfill `localStorage` for the jsdom environment.
//
// vitest 4 + jsdom 29 stopped exposing `window.localStorage` as a real
// Storage instance — accessing `localStorage.clear()` throws. Tests
// (notably `session-persistence.test.ts`) rely on the Storage API.
// Install a minimal in-memory shim before any test runs.

if (typeof globalThis.localStorage === "undefined" || typeof globalThis.localStorage.clear !== "function") {
  const store: Record<string, string> = {};
  const shim: Storage = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); },
    removeItem(k) { delete store[k]; },
    clear() { for (const k of Object.keys(store)) delete store[k]; },
    key(i) { return Object.keys(store)[i] ?? null; },
    get length() { return Object.keys(store).length; },
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: shim,
    configurable: true,
    writable: true,
  });
  if (typeof globalThis.window !== "undefined") {
    Object.defineProperty(globalThis.window, "localStorage", {
      value: shim,
      configurable: true,
      writable: true,
    });
  }
}

export {};
