import { describe, it, expect, vi } from "vitest";
import { sanitize, dispatchAgentEvent, parseDataChannelMessage } from "../event-bridge";

describe("event-bridge", () => {
  describe("sanitize", () => {
    it("strips HTML tags from strings", () => {
      expect(sanitize("<script>alert('xss')</script>")).toBe("alert('xss')");
      expect(sanitize("Hello <b>world</b>")).toBe("Hello world");
    });

    it("passes through non-strings unchanged", () => {
      expect(sanitize(42)).toBe(42);
      expect(sanitize(true)).toBe(true);
      expect(sanitize(null)).toBe(null);
    });

    it("recursively sanitizes objects", () => {
      const result = sanitize({
        name: "<img onerror=alert(1)>",
        count: 5,
        nested: { html: "<div>test</div>" },
      }) as Record<string, unknown>;

      expect(result.name).toBe("");
      expect(result.count).toBe(5);
      expect((result.nested as Record<string, unknown>).html).toBe("test");
    });

    it("recursively sanitizes arrays", () => {
      const result = sanitize(["<b>bold</b>", 42, "<script>x</script>"]);
      expect(result).toEqual(["bold", 42, "x"]);
    });
  });

  describe("dispatchAgentEvent", () => {
    it("dispatches CustomEvent on the element", () => {
      const el = document.createElement("div");
      const handler = vi.fn();
      el.addEventListener("agent-event", handler);

      dispatchAgentEvent(el, { eventName: "navigate", data: { url: "/pricing" } });

      expect(handler).toHaveBeenCalledTimes(1);
      const event = handler.mock.calls[0][0] as CustomEvent;
      expect(event.detail.eventName).toBe("navigate");
      expect(event.detail.data.url).toBe("/pricing");
    });

    it("dispatches window.postMessage", async () => {
      const el = document.createElement("div");

      const messagePromise = new Promise<MessageEvent>((resolve) => {
        window.addEventListener("message", (e) => {
          if (e.data?.source === "livelayer" && e.data?.payload?.eventName === "postmsg_test") {
            resolve(e);
          }
        });
      });

      dispatchAgentEvent(el, { eventName: "postmsg_test", data: { key: "value" } });

      const event = await messagePromise;
      expect(event.data.source).toBe("livelayer");
      expect(event.data.payload.eventName).toBe("postmsg_test");
      expect(event.data.payload.data.key).toBe("value");
    });

    it("sanitizes payloads", () => {
      const el = document.createElement("div");
      const handler = vi.fn();
      el.addEventListener("agent-event", handler);

      dispatchAgentEvent(el, {
        eventName: "info",
        data: { message: "<script>bad</script>" },
      });

      const event = handler.mock.calls[0][0] as CustomEvent;
      expect(event.detail.data.message).toBe("bad");
    });
  });

  describe("parseDataChannelMessage", () => {
    it("parses valid emit_event messages", () => {
      const raw = JSON.stringify({
        type: "emit_event",
        eventName: "navigate",
        data: { url: "/home" },
      });

      const result = parseDataChannelMessage(raw);
      expect(result).not.toBeNull();
      expect(result!.eventName).toBe("navigate");
      expect(result!.data.url).toBe("/home");
    });

    it("returns null for non-emit_event messages", () => {
      const raw = JSON.stringify({ type: "audio_data", payload: "..." });
      expect(parseDataChannelMessage(raw)).toBeNull();
    });

    it("returns null for invalid JSON", () => {
      expect(parseDataChannelMessage("not json")).toBeNull();
    });

    it("handles ArrayBuffer input", () => {
      const raw = JSON.stringify({
        type: "emit_event",
        eventName: "click",
        data: {},
      });
      const buf = new TextEncoder().encode(raw).buffer;

      const result = parseDataChannelMessage(buf);
      expect(result).not.toBeNull();
      expect(result!.eventName).toBe("click");
    });

    it("defaults data to empty object when missing", () => {
      const raw = JSON.stringify({ type: "emit_event", eventName: "ping" });
      const result = parseDataChannelMessage(raw);
      expect(result).not.toBeNull();
      expect(result!.data).toEqual({});
    });
  });
});
