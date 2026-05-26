import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  registerFields,
  getRegisteredFields,
  setFieldValue,
  clearRegistry,
  subscribeRegistry,
} from "../manifest";

beforeEach(() => clearRegistry());

describe("manifest registry", () => {
  it("registers an array of fields", () => {
    registerFields([
      { id: "email", label: "Email", kind: "email", value: "", required: true },
    ]);
    expect(getRegisteredFields()).toHaveLength(1);
    expect(getRegisteredFields()[0]).toMatchObject({ id: "email", label: "Email" });
  });

  it("merges new fields with existing entries (id is the key)", () => {
    registerFields([{ id: "a", label: "A", kind: "text", value: "", required: false }]);
    registerFields([{ id: "b", label: "B", kind: "text", value: "", required: false }]);
    expect(getRegisteredFields().map((f) => f.id).sort()).toEqual(["a", "b"]);
  });

  it("replaces an entry when re-registered with the same id", () => {
    registerFields([{ id: "x", label: "Old", kind: "text", value: "", required: false }]);
    registerFields([{ id: "x", label: "New", kind: "email", value: "", required: true }]);
    const f = getRegisteredFields()[0];
    expect(f.label).toBe("New");
    expect(f.kind).toBe("email");
    expect(f.required).toBe(true);
  });

  it("returns a deregister function that removes ONLY those fields", () => {
    registerFields([{ id: "keep", label: "K", kind: "text", value: "", required: false }]);
    const off = registerFields([
      { id: "tmp", label: "T", kind: "text", value: "", required: false },
    ]);
    expect(getRegisteredFields()).toHaveLength(2);
    off();
    const remaining = getRegisteredFields().map((f) => f.id);
    expect(remaining).toEqual(["keep"]);
  });

  it("setFieldValue updates an existing field's value", () => {
    registerFields([{ id: "x", label: "X", kind: "text", value: "", required: false }]);
    const changed = setFieldValue("x", "hello");
    expect(changed).toBe(true);
    expect(getRegisteredFields()[0].value).toBe("hello");
  });

  it("setFieldValue is a no-op when the value didn't change", () => {
    registerFields([{ id: "x", label: "X", kind: "text", value: "same", required: false }]);
    expect(setFieldValue("x", "same")).toBe(false);
  });

  it("setFieldValue returns false for unknown ids", () => {
    expect(setFieldValue("missing", "x")).toBe(false);
  });

  it("subscribe fires on register + setFieldValue + clear", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeRegistry(listener);
    registerFields([{ id: "x", label: "X", kind: "text", value: "", required: false }]);
    setFieldValue("x", "new");
    clearRegistry();
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
  });

  it("ignores entries with no id", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerFields([{ id: "", label: "x", kind: "text", value: "", required: false } as any]);
    expect(getRegisteredFields()).toEqual([]);
  });

  it("clearRegistry empties the store", () => {
    registerFields([{ id: "a", label: "A", kind: "text", value: "", required: false }]);
    expect(getRegisteredFields()).toHaveLength(1);
    clearRegistry();
    expect(getRegisteredFields()).toEqual([]);
  });
});
