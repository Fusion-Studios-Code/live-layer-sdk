// ─── Manifest manager ────────────────────────────────────────────────
//
// Owns the full manifest lifecycle:
//
//   discover.ts → finds DOM fields, attaches event delegation
//          ↓
//   registry.ts → programmatic overrides + merges
//          ↓
//   transport.ts → publishes PageContext via setAttributes (debounced)
//
// One instance per LiveKitSession. Started on connect, stopped on
// disconnect. Re-scans on DOM mutations (SPA route changes).

import {
  discover,
  attachChangeTracker,
  attachMutationWatcher,
  type DiscoveryEntry,
} from "./discover";
import {
  getRegisteredFields,
  subscribe as subscribeRegistry,
} from "./registry";
import { ManifestTransport, buildPageContext, type RoomLike } from "./transport";
import type { FieldManifest } from "./types";

export interface ManifestManagerOptions {
  room: RoomLike;
  doc?: Document;
  /** Skip the DOM scan entirely. Useful when the host is supplying
   * the manifest purely via registerFields(). Default false. */
  skipAutoDiscover?: boolean;
  /** Debounce window for transport publishes. Default 200ms. */
  publishDebounceMs?: number;
  /** Debounce window for mutation-driven re-scans. Default 200ms. */
  rescanDebounceMs?: number;
}

export class ManifestManager {
  private opts: ManifestManagerOptions;
  private transport: ManifestTransport;
  private entries = new Map<string, DiscoveryEntry>();
  private detachChangeTracker: (() => void) | null = null;
  private detachMutationWatcher: (() => void) | null = null;
  private unsubscribeRegistry: (() => void) | null = null;
  private started = false;

  constructor(opts: ManifestManagerOptions) {
    this.opts = opts;
    this.transport = new ManifestTransport({
      room: opts.room,
      debounceMs: opts.publishDebounceMs,
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    if (!this.opts.skipAutoDiscover) {
      this.rescan();
      this.detachMutationWatcher = attachMutationWatcher({
        doc: this.opts.doc,
        onChange: () => this.rescan(),
        debounceMs: this.opts.rescanDebounceMs,
      });
    }

    this.detachChangeTracker = attachChangeTracker({
      doc: this.opts.doc,
      resolve: (target) => {
        const id = target.getAttribute("name") || target.id;
        if (!id) return null;
        return this.entries.get(id) ?? null;
      },
      onChange: () => this.publish(),
    });

    this.unsubscribeRegistry = subscribeRegistry(() => this.publish());

    // Initial publish so the agent has the full manifest immediately
    // after connect. Bypasses the change-tracker's "value differed"
    // gate because there's no prior published state.
    this.publish();
  }

  /** Re-run DOM discovery and rebuild the entries map. */
  private rescan(): void {
    const discovered = discover({ root: this.opts.doc });
    const next = new Map<string, DiscoveryEntry>();
    for (const entry of discovered) {
      next.set(entry.field.id, entry);
    }
    this.entries = next;
    this.publish();
  }

  /** Build the current manifest and hand it to the transport. */
  private publish(): void {
    if (!this.started) return;
    const merged = this.mergedFields();
    const context = buildPageContext(merged, this.opts.doc);
    this.transport.publish(context);
  }

  /** Merge DOM-discovered fields with programmatic registrations. */
  private mergedFields(): FieldManifest[] {
    // Programmatic registrations WIN on id conflict — they're the
    // consumer's explicit override.
    const programmatic = new Map(
      getRegisteredFields().map((f) => [f.id, f] as const),
    );
    const out: FieldManifest[] = [];
    const seen = new Set<string>();
    for (const entry of this.entries.values()) {
      const id = entry.field.id;
      seen.add(id);
      out.push(programmatic.get(id) ?? entry.field);
    }
    for (const [id, field] of programmatic) {
      if (!seen.has(id)) out.push(field);
    }
    return out;
  }

  /** Stop tracking + tear down listeners. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.detachChangeTracker?.();
    this.detachChangeTracker = null;
    this.detachMutationWatcher?.();
    this.detachMutationWatcher = null;
    this.unsubscribeRegistry?.();
    this.unsubscribeRegistry = null;
    this.transport.flush().catch(() => {
      // best-effort final flush
    });
    this.transport.destroy();
    this.entries.clear();
  }
}
