// ─── <livelayer-widget> page tools, through a (fake) LiveKit room ────
// The whole path the script-tag widget takes: a packet from the agent
// participant arrives on the room, the widget acts on it, and the reply
// goes back out on the same room's local participant. Packets from
// anyone else are never acted on (the 0.9 trust boundary).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoomEvent } from "livekit-client";
import { clearPageContextCache } from "../page-tools/page-context";
import { clearRoutesCache } from "../page-tools/routes";

type Listener = (...args: unknown[]) => void;

const fake = vi.hoisted(() => {
  class FakeRoom {
    static instances: FakeRoom[] = [];
    private listeners = new Map<string, Listener[]>();
    remoteParticipants = new Map<string, unknown>();
    connect = vi.fn(async (_url: string, _token: string) => {});
    disconnect = vi.fn(async () => {
      this.emit("disconnected");
    });
    localParticipant = {
      identity: "visitor",
      isLocal: true,
      setMicrophoneEnabled: vi.fn(async () => undefined),
      setAttributes: vi.fn(async () => undefined),
      publishData: vi.fn(async (_data: Uint8Array, _opts: unknown) => undefined),
    };
    constructor() {
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
  return { FakeRoom };
});

vi.mock("livekit-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("livekit-client")>();
  return { ...actual, Room: fake.FakeRoom };
});

const AGENT = { identity: "agent-AJ_1", isLocal: false, isAgent: true, attributes: {} };
const AVATAR = {
  identity: "lemonslice-avatar",
  isLocal: false,
  isAgent: true,
  attributes: { "lk.publish_on_behalf": "agent-AJ_1" },
};

type FakeRoomT = InstanceType<typeof fake.FakeRoom>;

function send(room: FakeRoomT, from: typeof AGENT, msg: Record<string, unknown>) {
  room.emit(RoomEvent.DataReceived, new TextEncoder().encode(JSON.stringify(msg)), from, undefined, undefined);
}

function replies(room: FakeRoomT): Array<{ msg: Record<string, any>; opts: unknown }> {
  return room.localParticipant.publishData.mock.calls.map(([data, opts]) => ({
    msg: JSON.parse(new TextDecoder().decode(data as Uint8Array)),
    opts,
  }));
}

async function connectedWidget(attrs: Record<string, string> = {}) {
  await import("../widget");
  const el = document.createElement("livelayer-widget");
  el.setAttribute("agent-id", "agent_pt");
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  const btn = await vi.waitFor(() => {
    const b = el.shadowRoot!.querySelector<HTMLButtonElement>(".ll-connect-btn");
    if (!b) throw new Error("not rendered yet");
    return b;
  });
  btn.click();
  const room = await vi.waitFor(() => {
    const r = fake.FakeRoom.instances[fake.FakeRoom.instances.length - 1];
    if (!r || r.localParticipant.setMicrophoneEnabled.mock.calls.length === 0) throw new Error("not connected yet");
    return r;
  });
  room.remoteParticipants.set(AGENT.identity, AGENT);
  room.remoteParticipants.set(AVATAR.identity, AVATAR);
  return { el, room };
}

let widgets: HTMLElement[] = [];

beforeEach(() => {
  fake.FakeRoom.instances.length = 0;
  document.body.innerHTML = "";
  clearPageContextCache();
  clearRoutesCache();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("/config")) {
      return new Response(
        JSON.stringify({ experienceMode: "WIDGET", widgetConfig: { mediaType: "audio", position: "bottom-right", colors: {} } }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ token: "tok", url: "wss://example.livekit.cloud", roomName: "room-1" }), {
      status: 200,
    });
  });
});

afterEach(() => {
  for (const el of widgets) el.remove();
  widgets = [];
  vi.restoreAllMocks();
});

async function setup(attrs: Record<string, string> = {}) {
  const w = await connectedWidget(attrs);
  widgets.push(w.el);
  return w;
}

describe("<livelayer-widget> page tools", () => {
  it("answers the agent's request_page_context on the room it came from", async () => {
    document.body.insertAdjacentHTML("afterbegin", `<form id="contact"><input name="email" /></form>`);
    const { room } = await setup();
    send(room, AGENT, { type: "request_page_context", requestId: "r-1" });
    const [reply] = replies(room);
    expect(reply.opts).toEqual({ reliable: true });
    expect(reply.msg).toMatchObject({ type: "page_context", requestId: "r-1" });
    expect(reply.msg.context.forms.map((f: { id: string }) => f.id)).toEqual(["contact"]);
  });

  it("answers request_routes and submit_form too", async () => {
    document.body.insertAdjacentHTML(
      "afterbegin",
      `<a href="/pricing">Pricing</a><form id="contact"><input name="email" value="a@b.co" /></form>`,
    );
    document.getElementById("contact")!.addEventListener("submit", (e) => {
      e.preventDefault();
      setTimeout(() => (e.target as HTMLFormElement).remove(), 50);
    });
    const { room } = await setup();
    send(room, AGENT, { type: "request_routes", requestId: "r-2" });
    send(room, AGENT, { type: "submit_form", formId: "contact", requestId: "r-3" });
    await vi.waitFor(() => expect(replies(room)).toHaveLength(2));
    const [routes, submitted] = replies(room).map((r) => r.msg);
    expect(routes).toEqual({ type: "routes", requestId: "r-2", routes: [{ href: "/pricing", text: "Pricing", internal: true }] });
    expect(submitted).toEqual({ type: "form_submitted", formId: "contact", reason: "form_removed", requestId: "r-3" });
  });

  it("never acts on a request from a participant that is not the agent", async () => {
    document.body.insertAdjacentHTML("afterbegin", `<form id="f"><input name="email" /></form>`);
    const { room } = await setup();
    send(room, AVATAR, { type: "request_page_context", requestId: "evil" });
    send(room, AVATAR, { type: "fill_form", formId: "f", values: { email: "x@evil.co" } });
    expect(room.localParticipant.publishData).not.toHaveBeenCalled();
    expect((document.querySelector('[name="email"]') as HTMLInputElement).value).toBe("");
  });

  it("refuses page reads when the capabilities attribute leaves out read_page", async () => {
    const { room } = await setup({ capabilities: "navigate,scroll" });
    send(room, AGENT, { type: "request_page_context", requestId: "r-4" });
    send(room, AGENT, { type: "request_routes", requestId: "r-5" });
    const [ctx, routes] = replies(room).map((r) => r.msg);
    expect(ctx).toMatchObject({ type: "page_context", requestId: "r-4", error: "capability_blocked", capability: "read_page" });
    expect(ctx.context).toMatchObject({ error: "capability_blocked", capability: "read_page" });
    expect(routes).toMatchObject({ type: "routes", requestId: "r-5", error: "capability_blocked", routes: [] });
  });

  it("dispatches emit_event as one sanitized ll-emit-event on the element", async () => {
    const { el, room } = await setup();
    const seen: CustomEvent[] = [];
    document.addEventListener("ll-emit-event", (e) => seen.push(e as CustomEvent));
    send(room, AGENT, { type: "emit_event", eventName: "openModal", data: { title: "<img src=x onerror=alert(1)>Plans" } });
    expect(seen).toHaveLength(1);
    expect(seen[0].target).toBe(el);
    expect(seen[0].composed).toBe(true);
    expect(seen[0].detail).toEqual({ eventName: "openModal", data: { title: "Plans" } });
    // An event without a name dispatches nothing.
    send(room, AGENT, { type: "emit_event" });
    expect(seen).toHaveLength(1);
  });

  it("keeps the generic ll-* event for the new commands", async () => {
    document.body.insertAdjacentHTML("afterbegin", `<form id="f"><input name="email" /></form>`);
    const { el, room } = await setup();
    const fill = vi.fn();
    el.addEventListener("ll-fill-form", fill);
    send(room, AGENT, { type: "fill_form", formId: "f", values: { email: "dean@fssn.co" } });
    expect((document.querySelector('[name="email"]') as HTMLInputElement).value).toBe("dean@fssn.co");
    expect(fill).toHaveBeenCalledTimes(1);
  });

  it("accepts collect_data in the capabilities attribute", async () => {
    document.body.insertAdjacentHTML("afterbegin", `<form id="f"><input name="email" /></form>`);
    const { room } = await setup({ capabilities: "collect_data" });
    send(room, AGENT, { type: "task_field_updated", fieldId: "email", fieldName: "email", value: "a@b.co", source: "agent" });
    expect((document.querySelector('[name="email"]') as HTMLInputElement).value).toBe("a@b.co");
  });
});
