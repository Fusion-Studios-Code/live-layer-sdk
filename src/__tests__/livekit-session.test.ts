import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DisconnectReason, RoomEvent } from "livekit-client";

// ─── Fake livekit-client Room ─────────────────────────────────────────
// A minimal event-emitter stand-in for `Room`, so the tests can drive
// RoomEvents (participant leaves, data packets) the way the SDK sees
// them, without WebRTC. Everything else in livekit-client (RoomEvent,
// Track, DisconnectReason, ...) is the real module.

type Listener = (...args: unknown[]) => void;

interface FakeParticipant {
  identity: string;
  isLocal: boolean;
  isAgent: boolean;
  attributes: Record<string, string>;
}

const fake = vi.hoisted(() => {
  class FakeRoom {
    static instances: FakeRoom[] = [];
    /** When set, the next setMicrophoneEnabled(true) rejects with it. */
    static micError: Error | null = null;
    private listeners = new Map<string, Listener[]>();
    remoteParticipants = new Map<string, unknown>();
    connect = vi.fn(async (_url: string, _token: string) => {});
    disconnect = vi.fn(async () => {
      this.emit("disconnected");
    });
    localParticipant = {
      identity: "visitor",
      isLocal: true,
      setMicrophoneEnabled: vi.fn(async (enabled: boolean) => {
        if (enabled && FakeRoom.micError) throw FakeRoom.micError;
        return undefined;
      }),
      publishTrack: vi.fn(async () => undefined),
      setAttributes: vi.fn(async () => undefined),
    };
    options: unknown;
    constructor(options?: unknown) {
      this.options = options;
      FakeRoom.instances.push(this);
    }
    on(event: string, fn: Listener) {
      const list = this.listeners.get(event) ?? [];
      list.push(fn);
      this.listeners.set(event, list);
      return this;
    }
    emit(event: string, ...args: unknown[]) {
      for (const fn of this.listeners.get(event) ?? []) fn(...args);
    }
  }
  return { FakeRoom, createLocalAudioTrack: vi.fn(async () => ({ kind: "audio" })) };
});

vi.mock("livekit-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("livekit-client")>();
  return {
    ...actual,
    Room: fake.FakeRoom,
    createLocalAudioTrack: fake.createLocalAudioTrack,
  };
});

import { LiveKitSession, type SessionCallbacks, type SessionOptions } from "../livekit-session";

// ─── Helpers ──────────────────────────────────────────────────────────

const AGENT: FakeParticipant = {
  identity: "agent-AJ_123",
  isLocal: false,
  isAgent: true,
  attributes: { "lk.agent.state": "listening" },
};
const AVATAR: FakeParticipant = {
  identity: "lemonslice-avatar-agent-AJ_123",
  isLocal: false,
  isAgent: true,
  attributes: { "lk.publish_on_behalf": "agent-AJ_123" },
};
const OTHER_USER: FakeParticipant = {
  identity: "someone-else",
  isLocal: false,
  isAgent: false,
  attributes: {},
};

function makeCallbacks() {
  return {
    onConnectionStateChange: vi.fn(),
    onAgentStateChange: vi.fn(),
    onTranscript: vi.fn(),
    onAgentConfig: vi.fn(),
    onAudioTrack: vi.fn(),
    onVideoTrack: vi.fn(),
    onVideoTrackRemoved: vi.fn(),
    onError: vi.fn(),
    onDataMessage: vi.fn(),
    onAvatarEvent: vi.fn(),
    onAvatarDisconnected: vi.fn(),
  } satisfies SessionCallbacks;
}

async function connectSession(
  opts: Partial<SessionOptions> = {},
  callbackOverrides: Partial<SessionCallbacks> = {},
) {
  const callbacks = makeCallbacks();
  const session = new LiveKitSession(
    { agentId: "agent_1", baseUrl: "", automanifest: false, ...opts },
    { ...callbacks, ...callbackOverrides },
  );
  await session.connectWithToken("wss://example.livekit.cloud", "token");
  const room = fake.FakeRoom.instances[fake.FakeRoom.instances.length - 1];
  return { session, callbacks, room };
}

function join(room: InstanceType<typeof fake.FakeRoom>, ...ps: FakeParticipant[]) {
  for (const p of ps) room.remoteParticipants.set(p.identity, p);
}

/** livekit-client order: add to remoteParticipants, then emit. */
function arrive(room: InstanceType<typeof fake.FakeRoom>, p: FakeParticipant) {
  room.remoteParticipants.set(p.identity, p);
  room.emit(RoomEvent.ParticipantConnected, p);
}

function leave(
  room: InstanceType<typeof fake.FakeRoom>,
  p: FakeParticipant,
  reason?: DisconnectReason,
) {
  room.remoteParticipants.delete(p.identity);
  room.emit(RoomEvent.ParticipantDisconnected, p, reason);
}

beforeEach(() => {
  fake.FakeRoom.instances.length = 0;
  fake.FakeRoom.micError = null;
  fake.createLocalAudioTrack.mockClear();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ─── ParticipantDisconnected ─────────────────────────────────────────

describe("LiveKitSession — participant leaves", () => {
  it("ends the session when the agent leaves, and logs the reason", async () => {
    const { session, callbacks, room } = await connectSession();
    join(room, AGENT, AVATAR);

    leave(room, AGENT, DisconnectReason.PARTICIPANT_REMOVED);

    expect(room.disconnect).toHaveBeenCalledTimes(1);
    expect(callbacks.onConnectionStateChange).toHaveBeenLastCalledWith("disconnected");
    expect(callbacks.onAgentStateChange).toHaveBeenLastCalledWith("idle");
    expect(session.getRoom()).toBeNull();
    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining("Agent left"),
      expect.objectContaining({ identity: AGENT.identity, reason: "PARTICIPANT_REMOVED" }),
    );
  });

  it("ends the session when the agent leaves even if the avatar is still in the room", async () => {
    const { room } = await connectSession();
    join(room, AGENT, AVATAR);

    leave(room, AGENT);

    expect(room.remoteParticipants.has(AVATAR.identity)).toBe(true);
    expect(room.disconnect).toHaveBeenCalledTimes(1);
  });

  it("keeps the session when the avatar leaves and reports it to the host", async () => {
    const { session, callbacks, room } = await connectSession();
    join(room, AGENT, AVATAR);

    leave(room, AVATAR, DisconnectReason.CLIENT_INITIATED);

    expect(room.disconnect).not.toHaveBeenCalled();
    expect(session.getRoom()).toBe(room);
    expect(callbacks.onConnectionStateChange).not.toHaveBeenCalledWith("disconnected");
    expect(callbacks.onAvatarDisconnected).toHaveBeenCalledWith({
      identity: AVATAR.identity,
      reason: "CLIENT_INITIATED",
    });
    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining("Avatar left"),
      expect.objectContaining({ identity: AVATAR.identity, reason: "CLIENT_INITIATED" }),
    );
  });

  it("reports an avatar leave without a reason as reason undefined", async () => {
    const { callbacks, room } = await connectSession();
    join(room, AGENT, AVATAR);

    leave(room, AVATAR);

    expect(callbacks.onAvatarDisconnected).toHaveBeenCalledWith({
      identity: AVATAR.identity,
      reason: undefined,
    });
  });

  it("keeps the session when a non-agent participant leaves", async () => {
    const { session, callbacks, room } = await connectSession();
    join(room, AGENT, OTHER_USER);

    leave(room, OTHER_USER);

    expect(room.disconnect).not.toHaveBeenCalled();
    expect(session.getRoom()).toBe(room);
    expect(callbacks.onAvatarDisconnected).not.toHaveBeenCalled();
  });

  it("does not require the host to handle avatar leaves", async () => {
    const { room } = await connectSession({}, { onAvatarDisconnected: undefined });
    join(room, AGENT, AVATAR);

    expect(() => leave(room, AVATAR)).not.toThrow();
    expect(room.disconnect).not.toHaveBeenCalled();
  });
});

// ─── Agent timeout ───────────────────────────────────────────────────

describe("LiveKitSession — agent timeout", () => {
  it("errors with AGENT_TIMEOUT when nobody joins within 30s", async () => {
    vi.useFakeTimers();
    const { session, callbacks, room } = await connectSession();

    vi.advanceTimersByTime(30_000);

    expect(room.disconnect).toHaveBeenCalled();
    expect(callbacks.onError).toHaveBeenCalledWith("AGENT_TIMEOUT");
    expect(callbacks.onConnectionStateChange).toHaveBeenLastCalledWith("error");
    expect(session.getRoom()).toBeNull();
  });

  it("does not time out once a participant has joined", async () => {
    vi.useFakeTimers();
    const { callbacks, room } = await connectSession();
    join(room, AGENT);

    vi.advanceTimersByTime(30_000);

    expect(room.disconnect).not.toHaveBeenCalled();
    expect(callbacks.onError).not.toHaveBeenCalled();
  });
});

// ─── DataReceived: topic and sender ──────────────────────────────────

function packet(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

function receive(
  room: InstanceType<typeof fake.FakeRoom>,
  payload: Uint8Array,
  from: FakeParticipant | undefined,
  topic?: string,
  participantIdentity?: string,
) {
  // Same argument order as livekit-client's RoomEvent.DataReceived:
  // (payload, participant, kind, topic, encryptionType, participantIdentity)
  room.emit(RoomEvent.DataReceived, payload, from, undefined, topic, undefined, participantIdentity);
}

describe("LiveKitSession — data messages", () => {
  it("handles agent_state and forwards it when the agent sends it without a topic", async () => {
    const { callbacks, room } = await connectSession();
    join(room, AGENT);
    callbacks.onAgentStateChange.mockClear();

    receive(room, packet({ type: "agent_state", state: "thinking" }), AGENT);

    expect(callbacks.onAgentStateChange).toHaveBeenCalledWith("thinking");
    expect(callbacks.onDataMessage).toHaveBeenCalledWith({ type: "agent_state", state: "thinking" });
  });

  it("adds agent_caption from the agent to the transcript", async () => {
    const { callbacks, room } = await connectSession();
    join(room, AGENT);

    receive(room, packet({ type: "agent_caption", id: "turn-1", text: "Hello", final: false }), AGENT);

    expect(callbacks.onTranscript).toHaveBeenLastCalledWith([
      { id: "turn-1", role: "agent", text: "Hello", final: false },
    ]);
  });

  it("forwards agent commands to onDataMessage", async () => {
    const { callbacks, room } = await connectSession();
    join(room, AGENT);
    const cmd = { type: "navigate", href: "/pricing" };

    receive(room, packet(cmd), AGENT);

    expect(callbacks.onDataMessage).toHaveBeenCalledWith(cmd);
  });

  it("routes lemonslice-topic packets to onAvatarEvent, not to the agent path", async () => {
    const { session, callbacks, room } = await connectSession();
    join(room, AGENT, AVATAR);
    callbacks.onAgentStateChange.mockClear();

    receive(room, packet({ type: "idle_timeout" }), AVATAR, "lemonslice");
    receive(room, packet({ type: "agent_state", state: "speaking" }), AVATAR, "lemonslice");

    expect(callbacks.onAvatarEvent).toHaveBeenNthCalledWith(1, { type: "idle_timeout" }, {
      topic: "lemonslice",
      participantIdentity: AVATAR.identity,
    });
    expect(callbacks.onAvatarEvent).toHaveBeenCalledTimes(2);
    expect(callbacks.onDataMessage).not.toHaveBeenCalled();
    expect(callbacks.onAgentStateChange).not.toHaveBeenCalled();
    expect(room.disconnect).not.toHaveBeenCalled();
    expect(session.getRoom()).toBe(room);
  });

  it("drops lemonslice-topic packets quietly when the host has no onAvatarEvent", async () => {
    const { callbacks, room } = await connectSession({}, { onAvatarEvent: undefined });
    join(room, AGENT, AVATAR);

    expect(() => receive(room, packet({ type: "bot_ready" }), AVATAR, "lemonslice")).not.toThrow();
    expect(callbacks.onDataMessage).not.toHaveBeenCalled();
  });

  it("ignores command-like messages from the avatar participant", async () => {
    const { callbacks, room } = await connectSession();
    join(room, AGENT, AVATAR);

    receive(room, packet({ type: "navigate", href: "https://evil.example" }), AVATAR);
    receive(room, packet({ type: "agent_caption", text: "injected" }), AVATAR);

    expect(callbacks.onDataMessage).not.toHaveBeenCalled();
    expect(callbacks.onTranscript).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("did not come from the agent"),
      expect.objectContaining({ from: AVATAR.identity, type: "navigate" }),
    );
  });

  it("ignores command-like messages from a standard participant", async () => {
    const { callbacks, room } = await connectSession();
    join(room, AGENT, OTHER_USER);

    receive(room, packet({ type: "fill_form", fields: {} }), OTHER_USER);

    expect(callbacks.onDataMessage).not.toHaveBeenCalled();
  });

  it("drops a packet that names no sender at all", async () => {
    const { callbacks, room } = await connectSession();
    join(room, AGENT);

    receive(room, packet({ type: "click", selector: "#buy" }), undefined);

    expect(callbacks.onDataMessage).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("without a sender"),
      expect.objectContaining({ type: "click" }),
    );
  });

  it("ignores lemonslice-topic packets that do not come from the avatar", async () => {
    const { callbacks, room } = await connectSession();
    join(room, AGENT, OTHER_USER);

    receive(room, packet({ type: "idle_timeout" }), OTHER_USER, "lemonslice");
    receive(room, packet({ type: "error", message: "spoofed" }), AGENT, "lemonslice");

    expect(callbacks.onAvatarEvent).not.toHaveBeenCalled();
    expect(callbacks.onDataMessage).not.toHaveBeenCalled();
    expect(room.disconnect).not.toHaveBeenCalled();
  });

  it("warns once per ignored sender, not once per packet", async () => {
    const { room } = await connectSession();
    join(room, AGENT, AVATAR, OTHER_USER);

    for (let i = 0; i < 5; i++) receive(room, packet({ type: "metric", i }), AVATAR);
    for (let i = 0; i < 3; i++) receive(room, packet({ type: "hello", i }), OTHER_USER);

    expect(console.warn).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ from: AVATAR.identity }),
    );
    expect(console.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ from: OTHER_USER.identity }),
    );
  });

  it("ignores the agent's packets on other topics", async () => {
    const { callbacks, room } = await connectSession();
    join(room, AGENT);

    receive(room, packet({ type: "navigate", href: "/x" }), AGENT, "agent.action");

    expect(callbacks.onDataMessage).not.toHaveBeenCalled();
    expect(callbacks.onAvatarEvent).not.toHaveBeenCalled();
  });

  it("ignores payloads that are not a JSON object", async () => {
    const { callbacks, room } = await connectSession();
    join(room, AGENT);

    expect(() => receive(room, new TextEncoder().encode("not json"), AGENT)).not.toThrow();
    receive(room, packet([1, 2, 3]), AGENT);
    receive(room, packet("agent_state"), AGENT);

    expect(callbacks.onDataMessage).not.toHaveBeenCalled();
  });

  it("keeps a throwing host callback from escaping into livekit-client", async () => {
    const { callbacks, room } = await connectSession();
    join(room, AGENT);
    callbacks.onDataMessage.mockImplementation(() => {
      throw new Error("host bug");
    });

    expect(() => receive(room, packet({ type: "navigate", href: "/x" }), AGENT)).not.toThrow();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("handler failed"),
      expect.any(Error),
    );
  });
});

// ─── DataReceived before the sender's ParticipantInfo ────────────────
// livekit-client looks the sender up in remoteParticipants and emits
// DataReceived synchronously, so a packet that beats the participant
// update arrives with participant === undefined and only the identity.

describe("LiveKitSession — packets that arrive before their sender is known", () => {
  it("holds an agent packet and replays it when the agent's ParticipantConnected arrives", async () => {
    const { callbacks, room } = await connectSession();
    const cmd = { type: "agent_state", state: "speaking" };

    receive(room, packet(cmd), undefined, undefined, AGENT.identity);
    expect(callbacks.onDataMessage).not.toHaveBeenCalled();

    arrive(room, AGENT);

    expect(callbacks.onDataMessage).toHaveBeenCalledWith(cmd);
    expect(callbacks.onAgentStateChange).toHaveBeenLastCalledWith("speaking");
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("replays held packets before a later packet from the same sender", async () => {
    const { callbacks, room } = await connectSession();

    receive(room, packet({ type: "step", n: 1 }), undefined, undefined, AGENT.identity);
    receive(room, packet({ type: "step", n: 2 }), undefined, undefined, AGENT.identity);
    // Known now, but no ParticipantConnected (e.g. learned while connecting).
    join(room, AGENT);
    receive(room, packet({ type: "step", n: 3 }), AGENT);

    expect(callbacks.onDataMessage.mock.calls.map(([m]) => m.n)).toEqual([1, 2, 3]);
  });

  it("drops held packets when the early sender turns out not to be the agent", async () => {
    const { callbacks, room } = await connectSession();

    receive(room, packet({ type: "navigate", href: "https://evil.example" }), undefined, undefined, AVATAR.identity);
    receive(room, packet({ type: "fill_form", fields: {} }), undefined, undefined, OTHER_USER.identity);
    arrive(room, AVATAR);
    arrive(room, OTHER_USER);

    expect(callbacks.onDataMessage).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("did not come from the agent"),
      expect.objectContaining({ from: AVATAR.identity, type: "navigate" }),
    );
  });

  it("replays a held lemonslice-topic packet to onAvatarEvent once the avatar is known", async () => {
    const { callbacks, room } = await connectSession();

    receive(room, packet({ type: "bot_ready" }), undefined, "lemonslice", AVATAR.identity);
    arrive(room, AVATAR);

    expect(callbacks.onAvatarEvent).toHaveBeenCalledWith(
      { type: "bot_ready" },
      { topic: "lemonslice", participantIdentity: AVATAR.identity },
    );
    expect(callbacks.onDataMessage).not.toHaveBeenCalled();
  });

  it("replays held packets once the room finishes connecting", async () => {
    const { callbacks, room } = await connectSession();

    receive(room, packet({ type: "navigate", href: "/a" }), undefined, undefined, AGENT.identity);
    join(room, AGENT); // learned during connect: no ParticipantConnected
    room.emit(RoomEvent.Connected);

    expect(callbacks.onDataMessage).toHaveBeenCalledWith({ type: "navigate", href: "/a" });
  });

  it("does not hold packets on other topics", async () => {
    const { callbacks, room } = await connectSession();

    receive(room, packet({ type: "navigate", href: "/x" }), undefined, "agent.action", AGENT.identity);
    arrive(room, AGENT);

    expect(callbacks.onDataMessage).not.toHaveBeenCalled();
  });

  it("gives up after 5 s on a sender that never joins", async () => {
    vi.useFakeTimers();
    const { callbacks, room } = await connectSession();

    receive(room, packet({ type: "click", selector: "#buy" }), undefined, undefined, "ghost");
    vi.advanceTimersByTime(4_999);
    expect(console.warn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("never joined"),
      expect.objectContaining({ from: "ghost", type: "click" }),
    );
    // Too late: a participant with that identity joining later gets nothing replayed.
    arrive(room, { ...AGENT, identity: "ghost" });
    expect(callbacks.onDataMessage).not.toHaveBeenCalled();
  });

  it("replays at the 5 s mark if the sender became known without an event", async () => {
    vi.useFakeTimers();
    const { callbacks, room } = await connectSession();

    receive(room, packet({ type: "scroll_page", direction: "down" }), undefined, undefined, AGENT.identity);
    join(room, AGENT);
    vi.advanceTimersByTime(5_000);

    expect(callbacks.onDataMessage).toHaveBeenCalledWith({ type: "scroll_page", direction: "down" });
  });

  it("holds at most 64 packets", async () => {
    const { callbacks, room } = await connectSession();

    for (let n = 0; n < 70; n++) receive(room, packet({ type: "step", n }), undefined, undefined, AGENT.identity);
    arrive(room, AGENT);

    expect(callbacks.onDataMessage).toHaveBeenCalledTimes(64);
    expect(callbacks.onDataMessage).toHaveBeenLastCalledWith({ type: "step", n: 63 });
  });

  it("drops held packets when the room disconnects", async () => {
    vi.useFakeTimers();
    const { session, callbacks, room } = await connectSession();

    receive(room, packet({ type: "navigate", href: "/x" }), undefined, undefined, AGENT.identity);
    session.disconnect();
    arrive(room, AGENT);
    vi.advanceTimersByTime(10_000);

    expect(callbacks.onDataMessage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ─── Microphone ownership ────────────────────────────────────────────

function domError(name: string): Error {
  const err = new Error(name);
  err.name = name;
  return err;
}

describe("LiveKitSession — microphone", () => {
  it("publishes the mic through setMicrophoneEnabled by default", async () => {
    const { callbacks, room } = await connectSession();

    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledTimes(1);
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
    expect(room.localParticipant.publishTrack).not.toHaveBeenCalled();
    expect(fake.createLocalAudioTrack).not.toHaveBeenCalled();
    expect(callbacks.onConnectionStateChange).toHaveBeenLastCalledWith("connected");
  });

  it("captures with echo cancellation and noise suppression (room defaults)", async () => {
    const { room } = await connectSession();

    expect(room.options).toMatchObject({
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true },
    });
  });

  it("does not touch the mic when publishMicrophone is false", async () => {
    const { callbacks, room } = await connectSession({ publishMicrophone: false });

    expect(room.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
    expect(room.localParticipant.publishTrack).not.toHaveBeenCalled();
    expect(fake.createLocalAudioTrack).not.toHaveBeenCalled();
    expect(callbacks.onConnectionStateChange).toHaveBeenLastCalledWith("connected");
    expect(callbacks.onAgentStateChange).toHaveBeenLastCalledWith("listening");
  });

  it("does not report mic errors when the host owns the mic", async () => {
    fake.FakeRoom.micError = domError("NotAllowedError");
    const { callbacks, room } = await connectSession({ publishMicrophone: false });

    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(room.disconnect).not.toHaveBeenCalled();
  });

  it.each([
    ["NotAllowedError", "MIC_PERMISSION_DENIED"],
    ["SecurityError", "MIC_PERMISSION_DENIED"],
    ["NotFoundError", "MIC_NOT_FOUND"],
    ["NotReadableError", "MIC_UNAVAILABLE"],
  ])("maps a %s from the mic to %s and closes the room", async (name, code) => {
    fake.FakeRoom.micError = domError(name);
    const { session, callbacks, room } = await connectSession();

    expect(callbacks.onError).toHaveBeenCalledWith(code);
    expect(callbacks.onConnectionStateChange).toHaveBeenLastCalledWith("error");
    expect(room.disconnect).toHaveBeenCalled();
    expect(session.getRoom()).toBeNull();
  });
});
