// ─── Manifest types ───────────────────────────────────────────────────
//
// Single source of truth for the field-manifest shape that the SDK
// publishes to the agent worker. Kept aligned with the agent-side
// types in `lib/agent-context/types.ts` (PageContext + PageElement) in
// the live-layer monorepo — the SDK serializes its manifest into the
// same `agent.context` participant attribute, so the agent worker's
// existing v0.2.4.2 `[user_edit]` sync block consumes it without
// changes.

/** What kind of input the field maps to. */
export type FieldKind =
  | "text"
  | "long_text"
  | "email"
  | "phone"
  | "url"
  | "select"
  | "multi_select"
  | "number"
  | "currency"
  | "date"
  | "time"
  | "boolean";

/** A single option for `select` / `multi_select` kinds. */
export interface FieldOption {
  id: string;
  label: string;
}

/**
 * A field the agent should know about. Matches the PageElement shape
 * the agent worker already understands, so we can ship the manifest
 * directly as PageContext.elements.
 */
export interface FieldManifest {
  /** Stable identifier — becomes the agent's tool parameter name. */
  id: string;
  /** Human-readable label, shown to the LLM. */
  label: string;
  /** Field kind, drives schema generation + validation hints. */
  kind: FieldKind;
  /** Current value (always serializable). */
  value: string | number | boolean | string[] | null;
  /** Whether the field is required. */
  required: boolean;
  /** Optional normalization / context hint for the LLM. */
  description?: string;
  /** Available options for select kinds. */
  options?: FieldOption[];
  /**
   * Optional CSS selector for the painter — if absent the SDK uses
   * `[name=<id>]` (scoped by formId when present).
   */
  selector?: string;
  /** Scope filling to a specific <form> when the page has multiple. */
  formId?: string;
}

/**
 * PageContext envelope — what the SDK publishes via the
 * `agent.context` participant attribute. This is intentionally a
 * subset of the live-layer monorepo's PageContext type so the agent
 * worker's existing receiver (`lib/agent-context/agent-receiver.ts`)
 * can parse it as-is.
 */
export interface ManifestPageContext {
  /** Current route (window.location.pathname). */
  route: string;
  /** Stepper position — defaults to 0 for arbitrary consumer pages. */
  step: number;
  /** Step label — defaults to the document title. */
  stepLabel: string;
  /** All known fields. */
  elements: FieldManifest[];
  /** Tools the agent can call on this page. Empty by default. */
  availableActions: string[];
  /** Page title (document.title). */
  title: string;
}
