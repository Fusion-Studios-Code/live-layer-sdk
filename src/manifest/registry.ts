// ─── Programmatic field registry ─────────────────────────────────────
//
// Escape hatch for SPAs whose forms aren't in the initial DOM (or
// whose React-controlled inputs don't fire the events the discovery
// layer listens for). Consumers call `registerFields([...])` to push
// fields into the manifest directly; auto-discovery still runs, but
// programmatic entries WIN on id conflict.
//
// Lives at module scope so script-tag consumers can call
// `LiveLayer.registerFields([...])` from anywhere on the page. The
// active session listens for changes via the subscribe() API.

import type { FieldManifest } from "./types";

type Listener = () => void;

const _state: {
  fields: Map<string, FieldManifest>;
  listeners: Set<Listener>;
} = {
  fields: new Map(),
  listeners: new Set(),
};

/**
 * Register an array of fields programmatically. Replaces any existing
 * entries with matching ids; preserves entries for unrelated ids.
 *
 * Returns a deregister function that removes the registered fields.
 */
export function registerFields(fields: FieldManifest[]): () => void {
  const registered: string[] = [];
  for (const field of fields) {
    if (!field || typeof field.id !== "string" || !field.id) continue;
    _state.fields.set(field.id, { ...field });
    registered.push(field.id);
  }
  notify();
  return () => {
    for (const id of registered) _state.fields.delete(id);
    notify();
  };
}

/** Snapshot of every registered field. */
export function getRegisteredFields(): FieldManifest[] {
  return Array.from(_state.fields.values()).map((f) => ({ ...f }));
}

/** Update a single field's value (e.g. from a host-app callback). */
export function setFieldValue(
  id: string,
  value: FieldManifest["value"],
): boolean {
  const existing = _state.fields.get(id);
  if (!existing) return false;
  if (existing.value === value) return false;
  _state.fields.set(id, { ...existing, value });
  notify();
  return true;
}

/** Clear all programmatic registrations (test/teardown). */
export function clearRegistry(): void {
  _state.fields.clear();
  notify();
}

/** Subscribe to registry changes. Returns unsubscribe. */
export function subscribe(listener: Listener): () => void {
  _state.listeners.add(listener);
  return () => {
    _state.listeners.delete(listener);
  };
}

function notify(): void {
  for (const l of _state.listeners) {
    try {
      l();
    } catch (err) {
      // A bad listener shouldn't take the registry down
      // eslint-disable-next-line no-console
      console.warn("[LiveLayer] registry listener threw:", err);
    }
  }
}
