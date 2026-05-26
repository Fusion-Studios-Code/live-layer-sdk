// Public manifest API. Consumers import from "@livelayer/sdk".

export type {
  FieldKind,
  FieldOption,
  FieldManifest,
  ManifestPageContext,
} from "./types";

export {
  discover,
  attachChangeTracker,
  attachMutationWatcher,
  type DiscoveryEntry,
  type DiscoverOptions,
  type ChangeTrackerOptions,
  type MutationWatcherOptions,
} from "./discover";

export {
  registerFields,
  getRegisteredFields,
  setFieldValue,
  clearRegistry,
  subscribe as subscribeRegistry,
} from "./registry";

export {
  ManifestTransport,
  buildPageContext,
  type RoomLike,
  type TransportOptions,
} from "./transport";

export { ManifestManager, type ManifestManagerOptions } from "./manager";
