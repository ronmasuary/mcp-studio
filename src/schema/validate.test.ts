import { describe, expect, it } from "vitest";
import { FIXTURE_TOOLS } from "../mcp/__fixtures__/echo-server.js";
import type { FormState } from "./model.js";
import { toFormModel } from "./toFormModel.js";
import { validateArgs, validateForm } from "./validate.js";

const schemaOf = (name: string): unknown => FIXTURE_TOOLS.find((t) => t.name === name)?.inputSchema;
const check = (tool: string, state: FormState) => validateForm(toFormModel(schemaOf(tool)), schemaOf(tool), state);

describe("per-field errors from the fixture schemas", () => {
  // [label, tool, state, expected path, expected keyword]
  const bad: [string, string, FormState, string, string][] = [
    ["missing required string is reported on that field", "echo", {}, "/message", "required"],
    ["number above maximum", "add", { a: "1", b: "500" }, "/b", "maximum"],
    ["number below minimum", "add", { a: "-101", b: "0" }, "/a", "minimum"],
    ["non-numeric text in a number field", "add", { a: "abc", b: "1" }, "/a", "type"],
    ["fractional integer", "add", { a: "1", b: "1", times: "2.5" }, "/times", "type"],
    ["integer below minimum", "add", { a: "1", b: "1", times: "0" }, "/times", "minimum"],
    ["blank required string is reported as required", "greet", { name: "" }, "/name", "required"],
    ["missing nested required leaf", "create_user", { user: { name: "Ada", address: { street: "x" } } }, "/user/address/city", "required"],
    ["nested pattern violation", "create_user", { user: { name: "Ada", address: { city: "Leeds", zip: "abc" } } }, "/user/address/zip", "pattern"],
    ["array below minItems", "tag_items", { items: [] }, "/items", "minItems"],
    ["required inside an array row, addressed by real index", "tag_items", { items: [{ id: "1" }, { label: "x" }] }, "/items/1/id", "required"],
    ["type error inside an array row", "tag_items", { items: [{ id: "1" }, { id: "x" }] }, "/items/1/id", "type"],
    ["oneOf matching neither branch", "hostile_schema", { choice: "[]" }, "/choice", "oneOf"],
    ["prefixItems positional type", "hostile_schema", { choice: "1", pair: '[1, 2]' }, "/pair", "type"],
  ];

  it.each(bad)("%s", (_l, tool, state, path, keyword) => {
    const r = check(tool, state);
    expect(r.valid).toBe(false);
    const hit = r.errors.find((e) => e.path === path && e.keyword === keyword);
    expect(hit, JSON.stringify(r.errors)).toBeDefined();
    expect(r.byPath[path]?.length).toBeGreaterThan(0);
  });

  it("accepts a valid payload for each shape", () => {
    const good: [string, FormState][] = [
      ["echo", { message: "hi" }],
      ["add", { a: "1", b: "2", times: "3" }],
      ["paint", { colour: "red", finish: "gloss" }],
      ["greet", { name: "Ada" }],
      ["create_user", { user: { name: "Ada", address: { city: "Leeds", zip: "12345" } } }],
      ["tag_items", { items: [{ id: "1", label: "a" }], labels: ["x"] }],
      ["slow", {}],
      ["always_fails", {}],
      ["hostile_schema", { choice: '"text"', pair: '["a", 1]' }],
      ["hostile_schema", { choice: '{"id": 1}' }],
    ];
    for (const [tool, state] of good) {
      const r = check(tool, state);
      expect(r, tool).toMatchObject({ valid: true, errors: [] });
    }
  });

  it("returns the validated payload so the caller sends exactly what was checked", () => {
    const r = check("add", { a: "1", b: "2" });
    expect(r.args).toEqual({ a: 1, b: 2 });
  });

  it("every fixture tool validates cleanly from a payload built from an empty form, or says why", () => {
    for (const t of FIXTURE_TOOLS) {
      const r = validateForm(toFormModel(t.inputSchema), t.inputSchema, {});
      expect(r.schemaError, t.name).toBeUndefined();
      // Only the tools with required fields may fail, and then only on those fields.
      for (const e of r.errors) expect(["required", "minItems", "minLength", "oneOf"]).toContain(e.keyword);
    }
  });
});

describe("error shaping", () => {
  it("drops the noise from oneOf branches the user did not pick", () => {
    const r = check("hostile_schema", { choice: "[]" });
    expect(r.errors.filter((e) => e.path === "/choice")).toHaveLength(1);
    expect(r.errors.find((e) => e.path === "/choice")?.message).toBe("must match exactly one schema in oneOf");
  });

  it("maps an error inside a raw JSON field onto that field and keeps the exact location", () => {
    const r = check("hostile_schema", { choice: '{"id": "x"}' });
    // A oneOf error is the only one reported, and it is on the field the user can edit.
    expect(r.errors.map((e) => e.path)).toEqual(["/choice"]);

    const deep = check("hostile_schema", {
      choice: '"ok"',
      deep: { level1: { level2: { level3: { level4: { level5: '{"level6": 5}' } } } } },
    });
    expect(deep.errors).toEqual([
      expect.objectContaining({
        path: "/deep/level1/level2/level3/level4/level5",
        instancePath: "/deep/level1/level2/level3/level4/level5/level6",
        keyword: "type",
      }),
    ]);
  });

  it("puts required on the missing child, not the parent", () => {
    const r = check("create_user", { user: { name: "Ada", address: { street: "x" } } });
    expect(r.errors).toEqual([expect.objectContaining({ path: "/user/address/city", message: "is required" })]);
  });

  it("spells out the allowed values for an enum", () => {
    const r = validateArgs(schemaOf("paint"), { colour: "pink" }, toFormModel(schemaOf("paint")));
    expect(r.errors[0]).toMatchObject({ path: "/colour", keyword: "enum", message: 'must be one of: "red", "green", "blue"' });
  });

  it("reports additional properties on the offending key", () => {
    const schema = { type: "object", properties: { a: { type: "string" } }, additionalProperties: false };
    const r = validateArgs(schema, { a: "x", b: 1 });
    expect(r.errors).toEqual([expect.objectContaining({ path: "/b", message: "is not an allowed property" })]);
  });

  it("escapes pointer characters in the path of a missing key", () => {
    const r = validateArgs({ type: "object", required: ["a/b"] }, {});
    expect(r.errors[0]?.path).toBe("/a~1b");
  });

  it("groups several messages on one field", () => {
    const r = validateArgs({ type: "object", properties: { s: { type: "string", minLength: 5, pattern: "^[0-9]+$" } } }, { s: "ab" });
    expect(r.byPath["/s"]).toHaveLength(2);
  });

  it("checks formats through ajv-formats", () => {
    const schema = { type: "object", properties: { e: { type: "string", format: "email" }, u: { type: "string", format: "uri" } } };
    expect(validateArgs(schema, { e: "nope", u: "also nope" }).errors.map((e) => e.path)).toEqual(["/e", "/u"]);
    expect(validateArgs(schema, { e: "a@b.co", u: "https://x.dev/y" }).valid).toBe(true);
  });

  it("reports unparseable raw JSON once, without a second 'required' on the same field", () => {
    const r = check("hostile_schema", { choice: "{oops" });
    expect(r.errors.filter((e) => e.path === "/choice")).toEqual([expect.objectContaining({ keyword: "json" })]);
    expect(r.valid).toBe(false);
  });
});

describe("JSON Schema dialects", () => {
  it("compiles 2020-12 prefixItems and $defs, which draft-07 Ajv cannot", () => {
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      $defs: { Pt: { type: "array", prefixItems: [{ type: "number" }, { type: "number" }], items: false } },
      properties: { p: { $ref: "#/$defs/Pt" } },
    };
    expect(validateArgs(schema, { p: [1, 2] }).valid).toBe(true);
    expect(validateArgs(schema, { p: [1, 2, 3] }).valid).toBe(false);
    expect(validateArgs(schema, { p: ["a", 2] }).errors[0]?.path).toBe("/p/0");
  });

  it("accepts a draft-07 $schema label instead of throwing on the unknown dialect", () => {
    const schema = { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { n: { type: "integer" } }, required: ["n"] };
    expect(validateArgs(schema, {}).errors[0]).toMatchObject({ path: "/n", keyword: "required" });
    expect(validateArgs(schema, { n: 1 }).valid).toBe(true);
  });

  it("two schemas that declare the same $id do not collide", () => {
    const a = { $id: "https://example.com/args", type: "object", required: ["a"] };
    const b = { $id: "https://example.com/args", type: "object", required: ["b"] };
    expect(validateArgs(a, {}).errors[0]?.path).toBe("/a");
    expect(validateArgs(b, {}).errors[0]?.path).toBe("/b");
  });

  it("tolerates unknown keywords because strict is off", () => {
    expect(validateArgs({ type: "object", "x-vendor": { anything: true } }, {}).valid).toBe(true);
  });
});

describe("a schema that cannot be compiled never blocks a call", () => {
  it.each([
    ["an unresolvable $ref", { type: "object", properties: { a: { $ref: "#/$defs/missing" } } }],
    ["a type that does not exist", { type: "object", properties: { a: { type: "date" } } }],
    ["a non-object schema", null],
  ])("%s", (_l, schema) => {
    const r = validateArgs(schema, { a: 1 });
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.schemaError).toBeTruthy();
  });

  it("gives the same answer when the same schema object is validated again (cached)", () => {
    const schema = schemaOf("add");
    const first = validateArgs(schema, { a: "x" });
    const second = validateArgs(schema, { a: "x" });
    expect(second).toEqual(first);
    expect(first.valid).toBe(false);
  });
});

describe("a collapsed nullable field keeps its own constraint message", () => {
  const schema = { type: "object", properties: { nick: { anyOf: [{ type: "string", minLength: 5 }, { type: "null" }] } } };

  it("reports minLength on the field, not the bare anyOf", () => {
    const r = validateForm(toFormModel(schema), schema, { nick: "ab" });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ path: "/nick", keyword: "minLength" });
    expect(r.errors.some((e) => e.keyword === "anyOf")).toBe(false);
  });

  it("accepts a valid value", () => {
    expect(validateForm(toFormModel(schema), schema, { nick: "abcdef" }).valid).toBe(true);
  });
});
