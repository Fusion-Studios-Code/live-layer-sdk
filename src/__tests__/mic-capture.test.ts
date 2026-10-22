import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Real livekit-client throughout, except Room.connect, which needs a
// server. This pins what the browser is asked for when the SDK turns
// the mic on, so a livekit-client upgrade or a change to the Room
// options cannot quietly change the capture the agent's STT hears.
vi.mock("livekit-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("livekit-client")>();
  class OfflineRoom extends actual.Room {
    constructor(...args: ConstructorParameters<typeof actual.Room>) {
      super(...args);
      this.connect = async () => {};
    }
  }
  return { ...actual, Room: OfflineRoom };
});

import { createLocalAudioTrack } from "livekit-client";
import { LiveKitSession } from "../livekit-session";

let requested: MediaStreamConstraints[] = [];
let originalMediaDevices: PropertyDescriptor | undefined;

beforeEach(() => {
  requested = [];
  originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      // Record the constraints, then refuse, so no track has to exist.
      getUserMedia: vi.fn(async (constraints: MediaStreamConstraints) => {
        requested.push(structuredClone(constraints));
        const err = new Error("Permission denied");
        err.name = "NotAllowedError";
        throw err;
      }),
      enumerateDevices: vi.fn(async () => []),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  if (originalMediaDevices) {
    Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
  } else {
    delete (navigator as { mediaDevices?: unknown }).mediaDevices;
  }
  vi.restoreAllMocks();
});

async function sessionMicConstraints(): Promise<MediaTrackConstraints> {
  const onError = vi.fn();
  const session = new LiveKitSession(
    { agentId: "agent_1", baseUrl: "", automanifest: false },
    {
      onConnectionStateChange: vi.fn(),
      onAgentStateChange: vi.fn(),
      onTranscript: vi.fn(),
      onAgentConfig: vi.fn(),
      onAudioTrack: vi.fn(),
      onVideoTrack: vi.fn(),
      onVideoTrackRemoved: vi.fn(),
      onError,
    },
  );
  await session.connectWithToken("wss://example.livekit.cloud", "token");
  expect(onError).toHaveBeenCalledWith("MIC_PERMISSION_DENIED");
  expect(requested).toHaveLength(1);
  return requested[0].audio as MediaTrackConstraints;
}

describe("LiveKitSession — mic capture constraints", () => {
  it("asks for echo cancellation, noise suppression, AGC and voice isolation", async () => {
    const audio = await sessionMicConstraints();

    expect(audio).toEqual({
      deviceId: { ideal: "default" },
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      voiceIsolation: true,
    });
  });

  it("matches what 0.8.1's createLocalAudioTrack call asked for", async () => {
    const audio = await sessionMicConstraints();
    // 0.8.1 published a hand-made track from this exact call.
    // createLocalTracks merges livekit-client's audio defaults (AGC and
    // voice isolation on) under it, the same as setMicrophoneEnabled.
    await createLocalAudioTrack({ echoCancellation: true, noiseSuppression: true }).catch(() => {});
    const old = requested[1].audio as MediaTrackConstraints;

    // A bare "default" deviceId is the same request as { ideal: "default" }.
    expect(old.deviceId).toBe("default");
    expect({ ...audio, deviceId: undefined }).toEqual({ ...old, deviceId: undefined });
  });
});
