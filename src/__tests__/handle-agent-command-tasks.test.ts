// ─── handle-agent-command — task_field_updated / task_completed ──────
//
// Locks down the new 0.6.0 task command surface. The existing tests
// (handle-agent-command.test.ts if present) cover navigate / scroll /
// click; this file is task-specific.

import { describe, expect, it, vi } from "vitest";
import { handleAgentCommand } from "../handle-agent-command";

describe("handleAgentCommand: task_field_updated", () => {
  it("returns true and calls onTaskFieldUpdated for valid cmd", () => {
    const onTaskFieldUpdated = vi.fn();
    const handled = handleAgentCommand(
      {
        type: "task_field_updated",
        fieldId: "email",
        fieldName: "email_address",
        value: "dean@fssn.co",
        kind: "email",
        source: "agent",
      } as unknown as Record<string, unknown>,
      { onTaskFieldUpdated },
    );
    expect(handled).toBe(true);
    expect(onTaskFieldUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        fieldId: "email",
        fieldName: "email_address",
        value: "dean@fssn.co",
        kind: "email",
        source: "agent",
      }),
    );
  });

  it("falls back fieldName → fieldId when fieldName missing", () => {
    const onTaskFieldUpdated = vi.fn();
    handleAgentCommand(
      {
        type: "task_field_updated",
        fieldId: "phone",
        value: "212-555-8000",
        kind: "phone",
      } as unknown as Record<string, unknown>,
      { onTaskFieldUpdated },
    );
    expect(onTaskFieldUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ fieldName: "phone" }),
    );
  });

  it("respects collect_data capability gate", () => {
    const onTaskFieldUpdated = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handled = handleAgentCommand(
      {
        type: "task_field_updated",
        fieldId: "x",
        value: "y",
        kind: "text",
        source: "agent",
      } as unknown as Record<string, unknown>,
      {
        // Allowlist exists but doesn't include collect_data → blocked.
        capabilities: ["navigate"],
        onTaskFieldUpdated,
      },
    );
    expect(handled).toBe(true);
    expect(onTaskFieldUpdated).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("handleAgentCommand: task_completed", () => {
  it("returns true and calls onTaskCompleted with the result payload", () => {
    const onTaskCompleted = vi.fn();
    const result = {
      sessionId: "room_xyz",
      startedAt: "2026-05-14T00:00:00Z",
      endedAt: "2026-05-14T00:01:30Z",
      source: "agent" as const,
      results: {
        email_address: {
          fieldId: "email",
          fieldName: "email_address",
          value: "dean@fssn.co",
          kind: "email",
        },
      },
    };
    const handled = handleAgentCommand(
      { type: "task_completed", result } as unknown as Record<string, unknown>,
      { onTaskCompleted },
    );
    expect(handled).toBe(true);
    expect(onTaskCompleted).toHaveBeenCalledWith({ result });
  });

  it("skips onTaskCompleted when result payload is missing", () => {
    const onTaskCompleted = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handled = handleAgentCommand(
      { type: "task_completed" } as unknown as Record<string, unknown>,
      { onTaskCompleted },
    );
    expect(handled).toBe(true);
    expect(onTaskCompleted).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
