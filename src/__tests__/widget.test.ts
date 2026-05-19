import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ─── Web Component Registration ─────────────────────────────────────

describe("LiveLayerWidget custom element", () => {
  beforeEach(() => {
    // Clear any previous instances from the DOM
    document.body.innerHTML = "";
  });

  it("registers <livelayer-widget> as a custom element", async () => {
    await import("../widget");
    const Ctor = customElements.get("livelayer-widget");
    expect(Ctor).toBeDefined();
    expect(Ctor!.name).toBe("LiveLayerWidget");
  });

  it("has TAG_NAME static property", async () => {
    const { LiveLayerWidget } = await import("../widget");
    expect(LiveLayerWidget.TAG_NAME).toBe("livelayer-widget");
  });

  it("observes agent-id attribute", async () => {
    const { LiveLayerWidget } = await import("../widget");
    expect(LiveLayerWidget.observedAttributes).toContain("agent-id");
  });

  it("creates a shadow root on construction", async () => {
    await import("../widget");
    const el = document.createElement("livelayer-widget");
    expect(el.shadowRoot).not.toBeNull();
    expect(el.shadowRoot!.mode).toBe("open");
  });

  it("fetches config when connected with agent-id", async () => {
    const mockConfig = {
      experienceMode: "WIDGET",
      widgetConfig: {
        mediaType: "video",
        position: "bottom-right",
        colors: {},
        video: { allowCamera: true, allowScreenShare: true, allowTyping: true },
      },
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(mockConfig), { status: 200 }),
    );

    await import("../widget");
    const el = document.createElement("livelayer-widget");
    el.setAttribute("agent-id", "agent_test123");
    document.body.appendChild(el);

    // Wait for async initialization
    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/agents/agent_test123/config",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    fetchSpy.mockRestore();
  });

  it("renders error when config fetch fails", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 404 }),
    );

    await import("../widget");
    const el = document.createElement("livelayer-widget");
    el.setAttribute("agent-id", "agent_bad");
    document.body.appendChild(el);

    await vi.waitFor(() => {
      const errorDiv = el.shadowRoot!.querySelector(".ll-error");
      expect(errorDiv).not.toBeNull();
      expect(errorDiv!.textContent).toContain("Unable to load");
    });

    fetchSpy.mockRestore();
  });

  it("does not initialize twice when upgraded from parsed HTML with attributes", async () => {
    // Regression test: during custom-element upgrade, attributeChangedCallback fires for
    // each observed attribute BEFORE connectedCallback. If both paths call _initialize,
    // we get duplicate config fetches (and, with a real agent, duplicate LiveKit rooms).
    const mockConfig = {
      experienceMode: "WIDGET",
      widgetConfig: {
        mediaType: "video",
        position: "bottom-right",
        colors: {},
      },
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(mockConfig), { status: 200 }),
    );

    await import("../widget");

    // Parse HTML with the element already present — triggers the upgrade lifecycle
    // (attributeChangedCallback → connectedCallback), not the createElement path.
    document.body.innerHTML = '<livelayer-widget agent-id="agent_upgrade"></livelayer-widget>';

    // Let microtasks drain so _initialize's fetch is visible.
    await new Promise((r) => setTimeout(r, 20));

    const configCalls = fetchSpy.mock.calls.filter(([url]) =>
      typeof url === "string" && url.includes("agent_upgrade/config"),
    );
    expect(configCalls).toHaveLength(1);

    fetchSpy.mockRestore();
  });

  it("re-initializes when agent-id attribute changes", async () => {
    const mockConfig = {
      experienceMode: "WIDGET",
      widgetConfig: {
        mediaType: "audio",
        position: "bottom-left",
        colors: {},
      },
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      () => Promise.resolve(new Response(JSON.stringify(mockConfig), { status: 200 })),
    );

    await import("../widget");
    const el = document.createElement("livelayer-widget");
    el.setAttribute("agent-id", "agent_first");
    document.body.appendChild(el);

    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/agents/agent_first/config",
        expect.any(Object),
      );
    });

    // Change agent-id
    el.setAttribute("agent-id", "agent_second");

    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/agents/agent_second/config",
        expect.any(Object),
      );
    });

    fetchSpy.mockRestore();
  });
});
