# @livelayer/sdk

Drop-in web component and visitor tracker for embedding LiveLayer agents on any website.

## Installation

```bash
npm install @livelayer/sdk
```

## Usage

### Script Tag (no bundler)

Add the widget to any HTML page:

```html
<script type="module" src="https://unpkg.com/@livelayer/sdk"></script>
<livelayer-widget agent-id="your_agent_id"></livelayer-widget>
```

### NPM Import

```ts
import "@livelayer/sdk";

// The <livelayer-widget> custom element is now registered.
// Use it in your HTML or create it programmatically:
const widget = document.createElement("livelayer-widget");
widget.setAttribute("agent-id", "your_agent_id");
document.body.appendChild(widget);
```

### Module formats

| Entry | File | livekit-client |
| --- | --- | --- |
| `<script src>`, unpkg / jsDelivr default, `v1.js` | `dist/widget.js` (UMD) | bundled |
| `import "@livelayer/sdk"` | `dist/widget.mjs` (ES) | imported from the `livekit-client` package |
| `require("@livelayer/sdk")` | `dist/widget.cjs` (CommonJS) | required from the `livekit-client` package |

Since 0.9.0 the ES and CommonJS builds no longer bundle livekit-client. It is a regular dependency, so npm, bundlers and Node resolve it for you, and an app that also imports livekit-client ships one copy instead of two. If your app depends on livekit-client directly, use `^2.23.0` so it resolves to the same copy as the SDK.

Loading `dist/widget.mjs` straight from a CDN URL in the browser, with no bundler, now needs an import map entry for `livekit-client` (or a CDN that rewrites bare imports). Without a bundler, use the script tag above, which is unchanged.

### Headless session (`LiveKitSession`)

`LiveKitSession` is the connection layer under `<livelayer-widget>`, for hosts that render their own UI (e.g. `@livelayer/react`).

```ts
import { LiveKitSession } from "@livelayer/sdk";

const session = new LiveKitSession(
  {
    agentId: "your_agent_id",
    baseUrl: "https://app.livelayer.studio",
    apiKey: "ll_abc...",
    publishMicrophone: true, // default; see below
  },
  {
    onConnectionStateChange: (state) => {},
    onAgentStateChange: (state) => {},
    onTranscript: (entries) => {},
    onAgentConfig: (config) => {},
    onAudioTrack: (audioEl) => {},
    onVideoTrack: (videoEl) => {},
    onVideoTrackRemoved: () => {},
    onError: (message, code) => {},
    onDataMessage: (msg) => {},            // agent commands and state
    onAvatarEvent: (msg, meta) => {},      // optional, 0.9.0
    onAvatarDisconnected: (info) => {},    // optional, 0.9.0
  },
);
await session.connect();
```

Options and callbacks added in 0.9.0, all optional:

- **`publishMicrophone`** (option, default `true`). Whether the session turns on the visitor's mic after connecting, through `localParticipant.setMicrophoneEnabled(true)`. Set `false` when the host publishes and gates the mic itself; otherwise the room carries two microphone tracks and `setMicrophoneEnabled(false)` mutes only one of them. With `false`, mic permission errors (`MIC_PERMISSION_DENIED`, `MIC_NOT_FOUND`, `MIC_UNAVAILABLE`) are the host's to report.
- **`onAvatarEvent(msg, { topic, participantIdentity })`**. Events the avatar worker (LemonSlice) publishes on the `lemonslice` data topic, such as `bot_ready`, `idle_timeout` or `error`. Only packets from the avatar participant arrive here, and none of them reach `onDataMessage`: the avatar's own `idle_timeout` does not end the session.
- **`onAvatarDisconnected({ identity, reason })`**. The avatar left the room while the agent is still connected. The session stays up (voice only), and `onVideoTrackRemoved` has already fired, so this is the cue to show the still image. `reason` is the LiveKit `DisconnectReason` name when the server sends one.

Which data messages reach `onDataMessage`: JSON objects published **without a topic** by **the agent participant** (an agent-kind participant without the `lk.publish_on_behalf` attribute). Everything else is dropped, because whatever reaches `onDataMessage` can navigate, scroll, click and fill forms. A packet that arrives before livekit-client knows its sender is held for up to 5 seconds and checked once the sender is known. The session ends when the agent leaves, not when the avatar or another participant leaves.

### Structured data collection (0.7.0 — unified API)

**Just write regular HTML forms.** The widget auto-discovers every `<form>` on the page, paints values into the matching `[name="..."]` inputs as the agent records them, and fires one `ll-collected` event when the run is done:

```html
<script src="https://unpkg.com/@livelayer/sdk" type="module"></script>
<livelayer-widget agent-id="agent_abc"></livelayer-widget>

<!-- Plain HTML — the agent finds this. -->
<form>
  <label>Email <input name="email" type="email" required /></label>
  <label>Company <input name="company" /></label>
  <button type="submit">Subscribe</button>
</form>

<script>
  document.querySelector("livelayer-widget").addEventListener(
    "ll-collected",
    (e) => {
      // Two phases: "field" (mid-flow update) and "complete" (final).
      if (e.detail.phase !== "complete") return;
      fetch("/api/leads", {
        method: "POST",
        body: JSON.stringify(e.detail.result),
      });
    },
  );
</script>
```

**Opt out** when you don't want a form / input visible to the agent:

```html
<form data-ll-skip>...</form>           <!-- exclude the whole form -->
<input data-ll-private />               <!-- exclude one input -->
<form data-ll-intent="request a demo">  <!-- disambiguation hint -->
```

`type="password"`, `autocomplete="cc-*"`, and `autocomplete="off"` are ALWAYS excluded by the SDK — even if you accidentally named one of those inputs, the agent still can't fill it. See [docs.livelayer.studio/develop/data-collection](https://docs.livelayer.studio/develop/data-collection) for the full result shape, dashboard-declared field lists, slide-level data collection, capability gating, and webhook delivery.

### Visitor Tracker

Track page views, clicks, and custom events with automatic fingerprinting:

```ts
import { LiveLayerTracker } from "@livelayer/sdk";

const tracker = new LiveLayerTracker({
  agentId: "your_agent_id",
  autoTrack: true,        // auto-track page views (default: true)
  autoTrackClicks: true,  // auto-track interactive clicks (default: true)
});

await tracker.init();

// Identify a known visitor
tracker.identify({ name: "Jane", email: "jane@example.com" });

// Track a custom event
tracker.track("demo_requested", { plan: "pro" });
```

Standalone script tag for the tracker:

```html
<script
  src="https://unpkg.com/@livelayer/sdk/dist/tracker.js"
  data-agent-id="your_agent_id"
></script>
<script>
  // Available globally after init:
  LiveLayer.identify({ name: "Jane" });
  LiveLayer.track("signup");
</script>
```

## Configuration

The `<livelayer-widget>` element accepts these attributes:

| Attribute   | Description                                                                    |
| ----------- | ------------------------------------------------------------------------------ |
| `agent-id`  | **Required.** The published agent ID to connect to                             |
| `api-key`   | API key for cross-origin auth. Generate one at `app.livelayer.studio/settings/api-keys`. |
| `base-url`  | Override the API base URL (default auto-detects from script src)               |
| `mode`      | Override experience mode: `WIDGET` or `EMBEDDED`                               |

## Getting an API key

Cross-origin embedding (e.g., your marketing site embedding the widget) requires either a key or a configured domain allowlist. For a key:

1. Go to `app.livelayer.studio/settings/api-keys`
2. Click **Create key**, name it (e.g. `Production`), optionally set an expiry
3. Copy the raw key from the one-time reveal banner — you can't retrieve it later
4. Pass it to the widget as the `api-key` attribute

```html
<livelayer-widget
  agent-id="agent_xxx"
  api-key="ll_abc..."
  base-url="https://app.livelayer.studio"
></livelayer-widget>
```

If the key is compromised or you rotate credentials, revoke it from the same dashboard — the server rejects it within ~30 seconds.

## API

### Classes

- **`LiveLayerWidget`** -- The `<livelayer-widget>` custom element class.
- **`LiveKitSession`** -- Headless connection layer (see [Headless session](#headless-session-livekitsession)).
- **`LiveLayerTracker`** -- Visitor tracking with fingerprinting and event batching.

### Functions

- **`initFromScriptTag()`** -- Self-initializing entry point that reads config from `data-*` attributes on the current script tag.
- **`saveSession(agentId, session)`** / **`loadSession(agentId)`** / **`clearSession(agentId)`** -- Session persistence helpers.
- **`dispatchAgentEvent(detail)`** / **`parseDataChannelMessage(msg)`** / **`sanitize(html)`** -- Event bridge utilities.

### Types

- **`TrackerConfig`** -- Configuration for `LiveLayerTracker` (`agentId`, `apiBase`, `autoTrack`, `autoTrackClicks`).
- **`VisitorInfo`** -- Resolved visitor info (`id`, `isReturning`, `sessionCount`).

## License

MIT
