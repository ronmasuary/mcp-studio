import { describe, expect, it } from "vitest";
import { FIXTURE_TOOLS } from "../mcp/__fixtures__/echo-server.js";
import type { FormState } from "./model.js";
import { toArgs } from "./toArgs.js";
import { toFormModel } from "./toFormModel.js";

const schemaOf = (name: string): unknown => FIXTURE_TOOLS.find((t) => t.name === name)?.inputSchema;
const run = (tool: string, state: FormState) => toArgs(toFormModel(schemaOf(tool)), state);

describe("toArgs coercion, one case per rule", () => {
  const cases: [string, string, FormState, Record<string, unknown>][] = [
    ["number text becomes a number", "add", { a: "3", b: "-4.5" }, { a: 3, b: -4.5 }],
    ["exponent text is a number", "add", { a: "1e2", b: ".5" }, { a: 100, b: 0.5 }],
    ["already-numeric values pass through", "add", { a: 3, b: 0 }, { a: 3, b: 0 }],
    ["positive overflow text stays a string so validation reports a type error", "add", { a: "1e400", b: "1" }, { a: "1e400", b: 1 }],
    ["negative overflow text stays a string", "add", { a: "-1e400", b: "1" }, { a: "-1e400", b: 1 }],
    ["a long digit run that overflows stays a string", "add", { a: "9".repeat(400), b: "1" }, { a: "9".repeat(400), b: 1 }],
    ["integer text becomes an integer", "add", { a: "1", b: "1", times: "2" }, { a: 1, b: 1, times: 2 }],
    ["a required number left empty is omitted so validation says required", "add", { a: "", b: "2" }, { b: 2 }],
    ["an empty optional number is dropped", "add", { a: "1", b: "2", times: "  " }, { a: 1, b: 2 }],
    ["an empty optional string is not sent as an empty string", "greet", { name: "Ada", title: "" }, { name: "Ada" }],
    ["a required string left empty is omitted so validation says required", "greet", { name: "" }, {}],
    ["whitespace in a string is a value, not blank", "greet", { name: "Ada", title: " " }, { name: "Ada", title: " " }],
    ["boolean text becomes a boolean", "echo", { message: "hi", uppercase: "true" }, { message: "hi", uppercase: true }],
    ["false is kept, not treated as empty", "echo", { message: "hi", uppercase: false }, { message: "hi", uppercase: false }],
    ["an untouched optional boolean is omitted", "echo", { message: "hi" }, { message: "hi" }],
    ["enum text is matched to the schema value", "paint", { colour: "red", finish: "" }, { colour: "red" }],
    ["state keys the model does not know are ignored", "echo", { message: "hi", bogus: 1 }, { message: "hi" }],
    ["defaults are not sent, the server applies them", "paint", { colour: "blue" }, { colour: "blue" }],
  ];

  it.each(cases)("%s", (_label, tool, state, expected) => {
    const { args, errors } = run(tool, state);
    expect(args).toEqual(expected);
    expect(errors).toEqual([]);
  });

  it("keeps schema order in the payload regardless of state order", () => {
    const { args } = run("add", { times: "2", b: "1", a: "1" });
    expect(Object.keys(args)).toEqual(["a", "b", "times"]);
  });

  it("passes an uncoercible number through untouched so validation reports it", () => {
    expect(run("add", { a: "abc", b: "0x10" }).args).toEqual({ a: "abc", b: "0x10" });
    expect(run("add", { a: "1e", b: "1,5" }).args).toEqual({ a: "1e", b: "1,5" });
  });

  it("keeps a non-integer in an integer field so validation can reject it", () => {
    expect(run("add", { a: "1", b: "1", times: "2.5" }).args).toMatchObject({ times: 2.5 });
  });

  it("matches numeric enum values by their text", () => {
    const model = toFormModel({ type: "object", properties: { n: { enum: [1, 2, 3] }, f: { enum: [true, false] } } });
    expect(toArgs(model, { n: "2", f: "false" }).args).toEqual({ n: 2, f: false });
    expect(toArgs(model, { n: "9" }).args).toEqual({ n: "9" });
  });
});

describe("nested objects and arrays", () => {
  it("omits an untouched optional object entirely, even when it has required children", () => {
    const model = toFormModel(schemaOf("hostile_schema"));
    expect(toArgs(model, { choice: "1" }).args).toEqual({ choice: 1 });
  });

  it("sends a required object even when empty, so the missing child is reported", () => {
    expect(run("create_user", {}).args).toEqual({ user: {} });
  });

  it("builds nested payloads and drops empty leaves at every level", () => {
    const { args } = run("create_user", { user: { name: "Ada", address: { street: "", city: "Leeds", zip: "" } } });
    expect(args).toEqual({ user: { name: "Ada", address: { city: "Leeds" } } });
  });

  it("drops an optional nested object whose fields are all blank", () => {
    const { args } = run("create_user", { user: { name: "Ada", address: { street: "", city: "", zip: "" } } });
    expect(args).toEqual({ user: { name: "Ada" } });
  });

  it("coerces each row of an array of objects", () => {
    const { args } = run("tag_items", { items: [{ id: "1", label: "a" }, { id: "2", label: "" }] });
    expect(args).toEqual({ items: [{ id: 1, label: "a" }, { id: 2 }] });
  });

  it("drops blank scalar rows and empty optional arrays", () => {
    expect(run("tag_items", { items: [{ id: "1" }], labels: ["x", "", "  "] }).args).toEqual({
      items: [{ id: 1 }],
      labels: ["x", "  "],
    });
    expect(run("tag_items", { items: [{ id: "1" }], labels: ["", ""] }).args).toEqual({ items: [{ id: 1 }] });
  });

  it("sends a required array even when empty", () => {
    expect(run("tag_items", {}).args).toEqual({ items: [] });
  });

  it("treats a non-array value for an array field as no rows", () => {
    expect(run("tag_items", { items: "oops", labels: 5 }).args).toEqual({ items: [] });
  });
});

describe("nullable fields", () => {
  const model = toFormModel({
    type: "object",
    properties: {
      opt: { anyOf: [{ type: "string" }, { type: "null" }] },
      req: { type: ["integer", "null"] },
    },
    required: ["req"],
  });

  it("sends an explicit null, omits an empty optional, and sends null for an empty required", () => {
    expect(toArgs(model, { opt: null, req: "5" }).args).toEqual({ opt: null, req: 5 });
    expect(toArgs(model, { opt: "", req: "" }).args).toEqual({ req: null });
  });
});

describe("unsupported fields carry raw JSON text", () => {
  it("parses the text from the raw editor", () => {
    const { args, errors } = run("hostile_schema", { choice: '{"id": 7}', pair: '["a", 1]' });
    expect(args).toEqual({ choice: { id: 7 }, pair: ["a", 1] });
    expect(errors).toEqual([]);
  });

  it("parses a JSON string literal as a string, not as text", () => {
    expect(run("hostile_schema", { choice: '"hello"' }).args).toEqual({ choice: "hello" });
  });

  it("omits an empty raw field and passes through an already parsed value", () => {
    expect(run("hostile_schema", { choice: "  ", pair: undefined }).args).toEqual({});
    expect(run("hostile_schema", { choice: { id: 1 } }).args).toEqual({ choice: { id: 1 } });
  });

  it("reports invalid JSON against the field instead of throwing, and does not send it", () => {
    const { args, errors } = run("hostile_schema", { choice: "{oops", pair: "[1,2]" });
    expect(args).toEqual({ pair: [1, 2] });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ path: "/choice", keyword: "json" });
    expect(errors[0]?.message).toMatch(/^not valid JSON/);
  });

  it("reaches into the depth-capped branch through its raw field", () => {
    const { args } = run("hostile_schema", {
      choice: "1",
      deep: { level1: { level2: { level3: { level4: { level5: '{"level6": "bottom"}' } } } } },
    });
    expect(args).toEqual({
      choice: 1,
      deep: { level1: { level2: { level3: { level4: { level5: { level6: "bottom" } } } } } },
    });
  });

  it("uses the whole state as raw JSON when the root itself is unsupported", () => {
    const model = toFormModel({ oneOf: [{ type: "object" }, { type: "object" }] });
    expect(toArgs(model, { "": '{"a": 1}' })).toEqual({ args: { a: 1 }, errors: [] });
    expect(toArgs(model, { "": "" })).toEqual({ args: {}, errors: [] });
    expect(toArgs(model, { "": "[1]" }).errors[0]).toMatchObject({ path: "", keyword: "json" });
    expect(toArgs(model, { "": "{" }).errors[0]).toMatchObject({ path: "", keyword: "json" });
  });
});

describe("robustness", () => {
  it("never throws on garbage state", () => {
    const model = toFormModel(schemaOf("create_user"));
    for (const state of [{}, { user: null }, { user: 5 }, { user: [] }, { user: { address: "x" } }] as FormState[]) {
      expect(() => toArgs(model, state)).not.toThrow();
    }
  });

  it("does not mutate the state it is given", () => {
    const state = { items: [{ id: "1", label: "" }], labels: ["a", ""] };
    const before = JSON.stringify(state);
    run("tag_items", state);
    expect(JSON.stringify(state)).toBe(before);
  });

  it("produces JSON-serialisable output for every fixture tool from an empty state", () => {
    for (const t of FIXTURE_TOOLS) {
      const { args } = toArgs(toFormModel(t.inputSchema), {});
      expect(() => JSON.stringify(args)).not.toThrow();
    }
  });
});
