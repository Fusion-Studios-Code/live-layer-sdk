/**
 * LiveKit Session Manager
 *
 * Handles LiveKit room connection, track management, transcription,
 * and agent state for the SDK web component. Extracted from
 * app/widget/[agentId]/page.tsx to share between the SDK and iframe.
 *
 * Data flow:
 *   POST /api/widget/session → { token, url, agentConfig }
 *   → Room.connect(url, token)
 *   → publish local mic track
 *   → subscribe to remote audio/video tracks
 *   → listen for transcription + agent state changes
 */

import {
  Room,
  RoomEvent,
  Track,
  RemoteTrack,
  RemoteTrackPublication,
  RemoteParticipant,
  createLocalAudioTrack,
} from "livekit-client";
import { ManifestManager } from "./manifest/manager";

// ─── Types ──────────────────────────────────────────────────────────

export type ConnectionState = "idle" | "connecting" | "connected" | "error" | "disconnected";
export type AgentState = "idle" | "listening" | "thinking" | "speaking";

export interface TranscriptEntry {
  id: string;
  role: "agent" | "user";
  text: string;
  final: boolean;
}

export interface AgentConfig {
  name: string;
  avatarImageUrl: string;
  idleLoopUrl?: string;
}

export interface SessionCallbacks {
  onConnectionStateChange: (state: ConnectionState) => void;
  onAgentStateChange: (state: AgentState) => void;
  onTranscript: (entries: TranscriptEntry[]) => void;
  onAgentConfig: (config: AgentConfig) => void;
  onAudioTrack: (element: HTMLAudioElement) => void;
  onVideoTrack: (element: HTMLVideoElement) => void;
  onVideoTrackRemoved: () => void;
  /**
   * Called when something fails during connect or mid-session. `message`
   * is the human-readable display; `code` is the machine-readable contract
   * (e.g. "key_wrong_org", "key_expired", "agent_has_no_org") — consumers
   * branch on this to show tailored CTAs. Absent when the error was
   * generated client-side (non-HTTP failure).
   */
  onError: (message: string, code?: string) => void;
  /**
   * Raw data channel messages. Called for ALL messages, including those
   * already handled by onAgentStateChange (agent_state). Use for custom
   * message types like avatar_active/avatar_idle, agent_action, etc.
   */
  onDataMessage?: (msg: Record<string, unknown>) => void;
  /**
   * Fires whenever the session's resume eligibility changes — e.g. after
   * a successful connect (eligible), after the 5-min window expires, or
   * after a manual resume reset. Lets the widget toggle its "Restart
   * session" vs "Click to start" copy.
   */
  onResumabilityChange?: (canResume: boolean) => void;
}

export interface SessionOptions {
  agentId: string;
  baseUrl: string;
  apiKey?: string;
  /**
   * Custom session endpoint path (default: "/api/widget/session").
   * Use this when the caller manages its own session creation
   * (e.g. preview-session for dashboard, onboarding session, etc.)
   */
  sessionEndpoint?: string;
  /**
   * Extra body fields to send with the session creation request.
   */
  sessionBody?: Record<string, unknown>;
  /**
   * v0.8.0 — automatic form-field manifest publishing. When `true`
   * (default), the SDK scans the host page for `<input>` / `<select>` /
   * `<textarea>` elements, builds a manifest, and publishes it to the
   * agent via the `agent.context` participant attribute. The agent
   * worker reads PageContext from that attribute, so the agent knows
   * what's on the screen AND what the visitor has typed — no
   * per-field `onChange` wiring required on the consumer side.
   *
   * Privacy guards are always on: password fields, credit-card
   * autocomplete inputs, anything inside `.ll-widget`, and anything
   * tagged `data-ll-private` are never published.
   *
   * Set to `false` for sites that want zero DOM observation
   * (consumers who pass `data-ll-field` tags explicitly will still
   * see those picked up — the attribute itself opts in even when
   * automanifest is off).
   */
  automanifest?: boolean;
}

// ─── Constants ──────────────────────────────────────────────────────

const AGENT_TIMEOUT_MS = 30_000;

/**
 * How long after a successful connect we'll still ask the server to
 * replay the prior transcript on reconnect. Must match RESUME_WINDOW_MS
 * in lib/agent/session-resume.ts on the server. Older sessions get a
 * cold start instead.
 */
export const RESUME_WINDOW_MS = 5 * 60 * 1000;

// ─── Session Class ──────────────────────────────────────────────────

export class LiveKitSession {
  private room: Room | null = null;
  private agentTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private transcript: TranscriptEntry[] = [];
  private callbacks: SessionCallbacks;
  private options: SessionOptions;
  /** Room name of the most recent successful connect. Null until the first connect succeeds. */
  private priorRoomName: string | null = null;
  /** Timestamp (ms since epoch) of the most recent successful connect. */
  private priorRoomConnectedAt = 0;
  /**
   * Manifest manager — populated on connect when automanifest is on.
   * Scans the host DOM for form fields, attaches event-delegated
   * change tracking, and publishes a PageContext to the agent via
   * the `agent.context` participant attribute.
   */
  private manifestManager: ManifestManager | null = null;

  constructor(options: SessionOptions, callbacks: SessionCallbacks) {
    this.options = options;
    this.callbacks = callbacks;
  }

  /**
   * Whether the next {@link connect} call will ask the server to replay
   * the prior session's transcript. True when a previous connect
   * succeeded AND we're still within {@link RESUME_WINDOW_MS}.
   */
  canResume(): boolean {
    return (
      !!this.priorRoomName &&
      Date.now() - this.priorRoomConnectedAt < RESUME_WINDOW_MS
    );
  }

  /**
   * Access the underlying LiveKit Room for advanced operations
   * (e.g. setAttributes, publishData, camera/screen tracks).
   * Returns null if not connected.
   */
  getRoom(): Room | null {
    return this.room;
  }

  /**
   * Connect by fetching a session token from the API.
   * Uses sessionEndpoint from options (default: /api/widget/session).
   */
  async connect(): Promise<void> {
    if (this.room) return;
    this.callbacks.onConnectionStateChange("connecting");

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.options.apiKey) {
        headers["x-api-key"] = this.options.apiKey;
      }

      const endpoint = this.options.sessionEndpoint || "/api/widget/session";
      // If the session was previously connected within the resume window,
      // ask the server to load the tail of that session's transcript so
      // the agent can continue instead of re-greeting. Outside the window
      // we omit the field and let the server cold-start.
      const resumeRoomName = this.canResume() ? this.priorRoomName : null;
      const body = {
        agentId: this.options.agentId,
        ...(resumeRoomName ? { priorRoomName: resumeRoomName } : {}),
        ...this.options.sessionBody,
      };

      const res = await fetch(`${this.options.baseUrl}${endpoint}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const msg = data.error || `Session error: ${res.status}`;
        const code = typeof data.errorCode === "string" ? data.errorCode : undefined;
        this.callbacks.onError(msg, code);
        this.callbacks.onConnectionStateChange("error");
        return;
      }

      const { token, url, agentConfig, roomName } = await res.json();
      if (agentConfig) {
        this.callbacks.onAgentConfig(agentConfig);
      }

      // Remember the active room so the NEXT connect (after a disconnect)
      // can replay this session's context.
      if (typeof roomName === "string" && roomName.length > 0) {
        this.priorRoomName = roomName;
        this.priorRoomConnectedAt = Date.now();
        this.callbacks.onResumabilityChange?.(true);
      }

      await this.connectWithToken(url, token);
    } catch (err) {
      console.error("[LiveLayer] Connection failed:", err);
      this.callbacks.onError("Failed to connect");
      this.callbacks.onConnectionStateChange("error");
    }
  }

  /**
   * Connect with a pre-fetched token and URL. Use this when the caller
   * manages session creation externally (e.g. preview-session endpoint,
   * onboarding session with custom metadata).
   */
  async connectWithToken(url: string, token: string): Promise<void> {
    if (this.room) return;
    this.callbacks.onConnectionStateChange("connecting");

    try {
      const room = new Room({
        audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true },
        adaptiveStream: true,
      });
      this.room = room;

      this._bindRoomEvents(room);

      await room.connect(url, token);

      // Publishing the mic will prompt the browser for permission. If the
      // user denies, we treat it as a mic-permission error (not a generic
      // connection failure) so the UI can show the right copy + a retry
      // button that re-prompts. The LiveKit room is still open at this
      // point — disconnect explicitly so we don't leak an unused session.
      try {
        const micTrack = await createLocalAudioTrack({
          echoCancellation: true,
          noiseSuppression: true,
        });
        await room.localParticipant.publishTrack(micTrack);
      } catch (micErr) {
        const name = micErr instanceof Error ? micErr.name : "";
        room.disconnect();
        this.room = null;
        if (name === "NotAllowedError" || name === "SecurityError") {
          this.callbacks.onError("MIC_PERMISSION_DENIED");
        } else if (name === "NotFoundError") {
          this.callbacks.onError("MIC_NOT_FOUND");
        } else {
          this.callbacks.onError("MIC_UNAVAILABLE");
        }
        this.callbacks.onConnectionStateChange("error");
        return;
      }

      this.callbacks.onConnectionStateChange("connected");
      this.callbacks.onAgentStateChange("listening");

      // Manifest sync — discover the host page's form fields and
      // publish them to the agent. Default-on; consumers can opt out
      // via `automanifest: false`. Privacy guards (passwords, CC
      // fields, .ll-widget descendants, data-ll-private) are always
      // applied inside the discovery layer regardless.
      if (this.options.automanifest !== false && typeof document !== "undefined") {
        try {
          this.manifestManager = new ManifestManager({
            room: room as unknown as { localParticipant: { setAttributes(a: Record<string, string>): Promise<void> } },
          });
          this.manifestManager.start();
        } catch (err) {
          // Manifest is best-effort — a failure here must not break
          // the session. Log and continue.
          // eslint-disable-next-line no-console
          console.warn("[LiveLayer] manifest manager failed to start:", err);
          this.manifestManager = null;
        }
      }

      // Timeout: if no agent joins within 30s, disconnect
      this.agentTimeoutHandle = setTimeout(() => {
        if (room.remoteParticipants.size === 0) {
          room.disconnect();
          this.room = null;
          this.callbacks.onError("AGENT_TIMEOUT");
          this.callbacks.onConnectionStateChange("error");
          this.callbacks.onAgentStateChange("idle");
        }
      }, AGENT_TIMEOUT_MS);
    } catch (err) {
      console.error("[LiveLayer] Connection failed:", err);
      this.callbacks.onError("CONNECT_FAILED");
      this.callbacks.onConnectionStateChange("error");
    }
  }

  disconnect(): void {
    if (this.agentTimeoutHandle) {
      clearTimeout(this.agentTimeoutHandle);
      this.agentTimeoutHandle = null;
    }
    if (this.manifestManager) {
      this.manifestManager.stop();
      this.manifestManager = null;
    }
    if (this.room) {
      this.room.disconnect();
      this.room = null;
    }
    this.transcript = [];
    this.callbacks.onConnectionStateChange("disconnected");
    this.callbacks.onAgentStateChange("idle");
  }

  destroy(): void {
    this.disconnect();
  }

  private _bindRoomEvents(room: Room): void {
    // Remote tracks (audio + video)
    room.on(
      RoomEvent.TrackSubscribed,
      (track: RemoteTrack, _pub: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (track.kind === Track.Kind.Audio) {
          if (this.agentTimeoutHandle) {
            clearTimeout(this.agentTimeoutHandle);
            this.agentTimeoutHandle = null;
          }
          const el = track.attach();
          if (el instanceof HTMLAudioElement) {
            el.play().catch(() => {});
            this.callbacks.onAudioTrack(el);
          }
        } else if (track.kind === Track.Kind.Video) {
          const videoEl = track.attach();
          if (videoEl instanceof HTMLVideoElement) {
            videoEl.playsInline = true;
            this.callbacks.onVideoTrack(videoEl);
          }
        }
      }
    );

    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
      if (track.kind === Track.Kind.Video) {
        track.detach().forEach((el) => el.remove());
        this.callbacks.onVideoTrackRemoved();
      } else {
        track.detach().forEach((el) => el.remove());
      }
    });

    // Transcription
    room.on(RoomEvent.TranscriptionReceived, (segments, participant) => {
      for (const segment of segments) {
        const text = segment.text.trim();
        if (!text) continue;
        const role = participant?.isLocal ? "user" : "agent";
        const isFinal = !!segment.final;
        const segId = segment.id;
        const idx = this.transcript.findIndex((t) => t.id === segId);
        if (idx >= 0) {
          this.transcript[idx] = { id: segId, role, text, final: isFinal };
        } else {
          this.transcript.push({ id: segId, role, text, final: isFinal });
        }
      }
      this.callbacks.onTranscript([...this.transcript]);
    });

    // Agent state via participant attributes
    room.on(RoomEvent.ParticipantAttributesChanged, (changed, participant) => {
      if (!participant.isLocal && changed["lk.agent.state"]) {
        const state = changed["lk.agent.state"];
        if (["speaking", "listening", "thinking"].includes(state)) {
          this.callbacks.onAgentStateChange(state as AgentState);
        }
      }
    });

    // Data messages from agent
    room.on(RoomEvent.DataReceived, (payload: Uint8Array) => {
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload));
        // Forward all parsed messages to generic handler
        this.callbacks.onDataMessage?.(msg);
        // Handle agent_state internally
        if (msg.type === "agent_state") {
          const state = msg.state;
          if (["speaking", "listening", "thinking", "idle"].includes(state)) {
            this.callbacks.onAgentStateChange(state as AgentState);
          }
        }
        // Handle agent_caption — the agent worker streams these on
        // each text chunk from the LLM via a custom TextOutput sink.
        // Same `id` across chunks of one turn so the entry updates in
        // place; `final: false` while streaming, `final: true` when
        // the segment closes. Bypasses LiveKit's built-in
        // publishTranscription path because LemonSlice's audio
        // interception leaves the agent without a track sid (which
        // rtc-node requires).
        if (
          msg.type === "agent_caption" &&
          typeof msg.text === "string" &&
          msg.text.length > 0
        ) {
          const id =
            typeof msg.id === "string" && msg.id
              ? msg.id
              : `LL_AGENT_${Date.now()}`;
          // `final` defaults to true for backward compatibility with
          // pre-streaming agent builds that emitted one caption per turn.
          const isFinal = msg.final !== false;
          const idx = this.transcript.findIndex((t) => t.id === id);
          const entry: TranscriptEntry = {
            id,
            role: "agent",
            text: msg.text,
            final: isFinal,
          };
          if (idx >= 0) {
            this.transcript[idx] = entry;
          } else {
            this.transcript.push(entry);
          }
          this.callbacks.onTranscript([...this.transcript]);
        }
      } catch {
        // Ignore non-JSON
      }
    });

    // Disconnected
    room.on(RoomEvent.Disconnected, () => {
      this.callbacks.onConnectionStateChange("disconnected");
      this.callbacks.onAgentStateChange("idle");
      this.room = null;
    });

    // Agent left the room without taking the whole room down with
    // them. Happens on idle_timeout (the agent calls room.disconnect
    // on its side, but the propagation to our side can race), agent
    // crashes, or any clean agent shutdown that doesn't fire
    // RoomEvent.Disconnected here. Without this handler the user is
    // stuck looking at a frozen "speaking" avatar with no way to
    // end the session — agentState/connectionState never advance,
    // so ExpandedLayout never shows the "Resume session" CTA.
    //
    // Surface the same end-state as a clean disconnect: tear the
    // room down on our side too. RoomEvent.Disconnected then fires
    // and runs the cleanup above. canResume stays true (set on
    // connect, never reset) so the user sees the resume CTA.
    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      if (participant.isLocal) return;
      this.room?.disconnect();
    });
  }
}
