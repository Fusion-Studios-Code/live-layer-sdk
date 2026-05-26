import { describe, it, expect, beforeEach } from "vitest";
import { discover } from "../manifest/discover";

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("manifest discover — auto mode", () => {
  it("picks up <input> inside a <form>", () => {
    document.body.innerHTML = `
      <form>
        <label for="bn">Business name</label>
        <input id="bn" name="business_name" type="text" required />
      </form>
    `;
    const entries = discover();
    expect(entries).toHaveLength(1);
    expect(entries[0].field).toMatchObject({
      id: "business_name",
      label: "Business name",
      kind: "text",
      required: true,
    });
  });

  it("infers kind from input[type]", () => {
    document.body.innerHTML = `
      <form>
        <input name="email" type="email" />
        <input name="phone" type="tel" />
        <input name="link" type="url" />
        <input name="age" type="number" />
        <input name="birthday" type="date" />
        <input name="newsletter" type="checkbox" />
      </form>
    `;
    const byId = Object.fromEntries(
      discover().map((e) => [e.field.id, e.field.kind]),
    );
    expect(byId.email).toBe("email");
    expect(byId.phone).toBe("phone");
    expect(byId.link).toBe("url");
    expect(byId.age).toBe("number");
    expect(byId.birthday).toBe("date");
    expect(byId.newsletter).toBe("boolean");
  });

  it("infers kind=long_text for <textarea>", () => {
    document.body.innerHTML = `
      <form><textarea name="notes" placeholder="Anything else?"></textarea></form>
    `;
    const entries = discover();
    expect(entries[0].field.kind).toBe("long_text");
    expect(entries[0].field.label).toBe("Anything else?");
  });

  it("infers kind=select with options for <select>", () => {
    document.body.innerHTML = `
      <form>
        <label for="t">Tone</label>
        <select id="t" name="tone">
          <option value="friendly">Friendly</option>
          <option value="formal">Formal</option>
        </select>
      </form>
    `;
    const entries = discover();
    expect(entries[0].field.kind).toBe("select");
    expect(entries[0].field.options).toEqual([
      { id: "friendly", label: "Friendly" },
      { id: "formal", label: "Formal" },
    ]);
  });

  it("infers kind=multi_select for <select multiple>", () => {
    document.body.innerHTML = `<form><select name="tags" multiple><option value="a">A</option></select></form>`;
    const entries = discover();
    expect(entries[0].field.kind).toBe("multi_select");
  });

  it("resolves label from associated <label for>", () => {
    document.body.innerHTML = `
      <form>
        <label for="x">Email address</label>
        <input id="x" name="email" type="email" />
      </form>
    `;
    expect(discover()[0].field.label).toBe("Email address");
  });

  it("falls back to placeholder when no label is present", () => {
    document.body.innerHTML = `<form><input name="email" placeholder="you@company.com" /></form>`;
    expect(discover()[0].field.label).toBe("you@company.com");
  });

  it("falls back to title-cased name as last resort", () => {
    document.body.innerHTML = `<form><input name="business_name" /></form>`;
    expect(discover()[0].field.label).toBe("Business Name");
  });

  it("reads the current value", () => {
    document.body.innerHTML = `<form><input name="bn" value="Acme" /></form>`;
    expect(discover()[0].field.value).toBe("Acme");
  });

  it("reads checkbox state as boolean", () => {
    document.body.innerHTML = `<form><input name="news" type="checkbox" checked /></form>`;
    expect(discover()[0].field.value).toBe(true);
  });

  it("reads numeric inputs as number", () => {
    document.body.innerHTML = `<form><input name="age" type="number" value="42" /></form>`;
    expect(discover()[0].field.value).toBe(42);
  });

  it("attaches formId when input is inside a named <form>", () => {
    document.body.innerHTML = `<form id="booking"><input name="email" type="email" /></form>`;
    expect(discover()[0].field.formId).toBe("booking");
  });

  it("does not de-dupe across distinct form fields", () => {
    document.body.innerHTML = `
      <form>
        <input name="a" />
        <input name="b" />
        <input name="c" />
      </form>
    `;
    expect(discover()).toHaveLength(3);
  });

  it("de-dupes radio groups by name (keeps the first only)", () => {
    document.body.innerHTML = `
      <form>
        <input name="size" type="radio" value="s" />
        <input name="size" type="radio" value="m" checked />
        <input name="size" type="radio" value="l" />
      </form>
    `;
    const entries = discover();
    expect(entries).toHaveLength(1);
    expect(entries[0].field.id).toBe("size");
  });
});

describe("manifest discover — strict mode (data-ll-field opt-in)", () => {
  it("only picks up tagged elements when ANY element has data-ll-field", () => {
    document.body.innerHTML = `
      <form>
        <input name="public" data-ll-field />
        <input name="ignored" type="text" />
      </form>
    `;
    const entries = discover();
    expect(entries).toHaveLength(1);
    expect(entries[0].field.id).toBe("public");
  });

  it("honors data-ll-label override", () => {
    document.body.innerHTML = `
      <input name="x" data-ll-field data-ll-label="What's your dog's name?" />
    `;
    expect(discover()[0].field.label).toBe("What's your dog's name?");
  });

  it("honors data-ll-kind override", () => {
    document.body.innerHTML = `<input name="x" data-ll-field data-ll-kind="email" />`;
    expect(discover()[0].field.kind).toBe("email");
  });

  it("honors data-ll-required", () => {
    document.body.innerHTML = `<input name="x" data-ll-field data-ll-required />`;
    expect(discover()[0].field.required).toBe(true);
  });

  it("honors data-ll-description", () => {
    document.body.innerHTML = `<input name="x" data-ll-field data-ll-description="primary contact email" />`;
    expect(discover()[0].field.description).toBe("primary contact email");
  });

  it("parses data-ll-options into FieldOption[]", () => {
    document.body.innerHTML = `<input name="x" data-ll-field data-ll-options="a:Alpha,b:Beta" />`;
    expect(discover()[0].field.options).toEqual([
      { id: "a", label: "Alpha" },
      { id: "b", label: "Beta" },
    ]);
  });

  it("inputs without data-ll-field outside a form ARE picked up in auto mode", () => {
    document.body.innerHTML = `<input name="floater" placeholder="just a name" />`;
    const entries = discover();
    expect(entries).toHaveLength(1);
    expect(entries[0].field.id).toBe("floater");
  });
});

describe("manifest discover — privacy guards", () => {
  it("skips <input type=password>", () => {
    document.body.innerHTML = `<form><input name="pass" type="password" /></form>`;
    expect(discover()).toEqual([]);
  });

  it("skips <input type=hidden>", () => {
    document.body.innerHTML = `<form><input name="csrf" type="hidden" /></form>`;
    expect(discover()).toEqual([]);
  });

  it("skips inputs with autocomplete=cc-*", () => {
    document.body.innerHTML = `<form><input name="card" autocomplete="cc-number" /></form>`;
    expect(discover()).toEqual([]);
  });

  it("skips inputs with data-ll-private", () => {
    document.body.innerHTML = `<form><input name="ssn" data-ll-private /></form>`;
    expect(discover()).toEqual([]);
  });

  it("skips inputs inside .ll-widget (the widget's own DOM)", () => {
    document.body.innerHTML = `
      <div class="ll-widget">
        <input name="should_skip" />
      </div>
      <form><input name="should_keep" /></form>
    `;
    const ids = discover().map((e) => e.field.id);
    expect(ids).toEqual(["should_keep"]);
  });

  it("skips inputs with no name AND no id", () => {
    document.body.innerHTML = `<form><input type="text" /></form>`;
    expect(discover()).toEqual([]);
  });
});
