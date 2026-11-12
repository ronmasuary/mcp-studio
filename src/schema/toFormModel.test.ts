import { describe, expect, it } from "vitest";
import { FIXTURE_TOOLS, FIXTURE_TOOL_NAMES } from "../mcp/__fixtures__/echo-server.js";
import type { FormField, FormFieldKind } from "./model.js";
import { fieldAtPath, rebasePath } from "./pointer.js";
import { DEFAULT_MAX_DEPTH, toFormModel } from "./toFormModel.js";

const schemaOf = (name: string): unknown => {
  const tool = FIXTURE_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`no fixture tool ${name}`);
  return tool.inputSchema;
};
const modelOf = (name: string) => toFormModel(schemaOf(name));

/** One line per field, depth-first: `path:kind`, `*` when required. Compact enough to read in a table. */
function outline(fields: FormField[]): string[] {
  const out: string[] = [];
  const walk = (f: FormField): void => {
    out.push(`${f.path}:${f.kind}${f.required ? "*" : ""}`);
    if (f.kind === "object") f.fields.forEach(walk);
    if (f.kind === "array") walk(f.item);
  };
  fields.forEach(walk);
  return out;
}

const KINDS: FormFieldKind[] = ["string", "number", "integer", "boolean", "enum", "array", "object", "unsupported"];

describe("every fixture tool", () => {
  // The gate for this phase: a real tool list, not hand-written toy schemas.
  it("covers all 25 fixture tools", () => {
    expect(FIXTURE_TOOLS).toHaveLength(25);
  });

  // Only hostile_schema falls outside the subset, and exactly where it should.
  const EXPECTED_UNSUPPORTED: Record<string, { path: string; reason: RegExp }[]> = {
    hostile_schema: [
      { path: "/choice", reason: /^oneOf \(2 alternatives\)/ },
      { path: "/deep/level1/level2/level3/level4/level5", reason: /nested more than 5 levels deep/ },
      { path: "/pair", reason: /prefixItems/ },
    ],
  };

  it.each(FIXTURE_TOOL_NAMES.map((n) => [n]))("%s yields a sane model or an explicit unsupported", (name) => {
    const model = modelOf(name);
    const seen: FormField[] = [];
    const walk = (f: FormField): void => {
      seen.push(f);
      if (f.kind === "object") f.fields.forEach(walk);
      if (f.kind === "array") walk(f.item);
    };
    model.fields.forEach(walk);

    for (const f of seen) {
      expect(KINDS).toContain(f.kind);
      expect(f.path === "" || f.path.startsWith("/")).toBe(true);
      expect(f.label).not.toBe("");
      if (f.kind === "unsupported") {
        expect(f.reason.length).toBeGreaterThan(0);
        expect(f.rawSchema).toBeDefined();
      }
    }

    const expected = EXPECTED_UNSUPPORTED[name] ?? [];
    expect(model.unsupported.map((u) => u.path)).toEqual(expected.map((e) => e.path));
    model.unsupported.forEach((u, i) => {
      expect(u.reason).toMatch(expected[i]?.reason ?? /$^/);
      // The path is real: the model can find the field it names.
      expect(fieldAtPath(model, u.path)?.field).toBe(u);
    });
    expect(model.unsupported).toEqual(seen.filter((f) => f.kind === "unsupported"));
  });

  it("is deterministic and does not mutate the schema it is given", () => {
    for (const t of FIXTURE_TOOLS) {
      const before = JSON.stringify(t.inputSchema);
      const a = toFormModel(t.inputSchema);
      const b = toFormModel(t.inputSchema);
      expect(JSON.stringify(t.inputSchema)).toBe(before);
      expect(a).toEqual(b);
    }
  });
});

describe("one case per schema shape, from the fixture", () => {
  const cases: [string, string, string[]][] = [
    ["flat string, optional boolean", "echo", ["/message:string*", "/uppercase:boolean"]],
    ["number and integer with bounds", "add", ["/a:number*", "/b:number*", "/times:integer"]],
    ["enums", "paint", ["/colour:enum*", "/finish:enum"]],
    ["optional vs required", "greet", ["/name:string*", "/title:string", "/excited:boolean"]],
    [
      "two-level nested objects",
      "create_user",
      ["/user:object*", "/user/name:string*", "/user/address:object", "/user/address/street:string", "/user/address/city:string*", "/user/address/zip:string"],
    ],
    [
      "arrays of objects and of strings",
      "tag_items",
      ["/items:array*", "/items/0:object*", "/items/0/id:integer*", "/items/0/label:string", "/labels:array", "/labels/0:string*"],
    ],
    ["no properties", "slow", []],
    ["tool-level error tool", "always_fails", ["/reason:string"]],
    ["destructive tool", "delete_everything", ["/confirm:boolean"]],
    [
      "hostile: oneOf, depth cap, prefixItems",
      "hostile_schema",
      [
        "/choice:unsupported*",
        "/deep:object",
        "/deep/level1:object*",
        "/deep/level1/level2:object*",
        "/deep/level1/level2/level3:object*",
        "/deep/level1/level2/level3/level4:object*",
        "/deep/level1/level2/level3/level4/level5:unsupported*",
        "/pair:unsupported",
      ],
    ],
    ["padding tool", "filler_01", ["/n:integer"]],
  ];

  it.each(cases)("%s (%s)", (_label, tool, expected) => {
    expect(outline(modelOf(tool).fields)).toEqual(expected);
  });

  it("carries constraints, defaults and descriptions", () => {
    const add = modelOf("add").fields;
    expect(add[0]).toMatchObject({ kind: "number", minimum: -100, maximum: 100, description: "First addend" });
    expect(add[2]).toMatchObject({ kind: "integer", minimum: 1, maximum: 5, default: 1 });

    const greet = modelOf("greet").fields;
    expect(greet[0]).toMatchObject({ kind: "string", minLength: 1, description: "Who to greet" });

    const paint = modelOf("paint").fields;
    expect(paint[0]).toMatchObject({ kind: "enum", values: ["red", "green", "blue"] });
    expect(paint[1]).toMatchObject({ kind: "enum", values: ["matte", "gloss"], default: "matte" });

    const echo = modelOf("echo").fields;
    expect(echo[1]).toMatchObject({ kind: "boolean", default: false, description: "Shout it" });

    const user = modelOf("create_user").fields[0];
    const address = user?.kind === "object" ? user.fields[1] : undefined;
    const zip = address?.kind === "object" ? address.fields[2] : undefined;
    expect(zip).toMatchObject({ kind: "string", pattern: "^[0-9]{5}$", path: "/user/address/zip" });

    const items = modelOf("tag_items").fields[0];
    expect(items).toMatchObject({ kind: "array", minItems: 1 });
  });

  it("does not carry keys that were absent (no undefined constraints)", () => {
    const greet = modelOf("greet").fields[2];
    expect(greet && Object.keys(greet).sort()).toEqual(["kind", "label", "name", "path", "required"]);
  });

  it("emits properties in declaration order, not required-first", () => {
    const names = modelOf("greet").fields.map((f) => f.name);
    expect(names).toEqual(["name", "title", "excited"]);
    const reordered = toFormModel({
      type: "object",
      properties: { z: { type: "string" }, a: { type: "string" }, m: { type: "string" } },
      required: ["m", "z"],
    });
    expect(reordered.fields.map((f) => f.name)).toEqual(["z", "a", "m"]);
  });
});

describe("depth cap", () => {
  const deep = (): unknown => schemaOf("hostile_schema");

  it("defaults to 5 levels", () => {
    expect(DEFAULT_MAX_DEPTH).toBe(5);
  });

  it("turns the six-level hostile branch into unsupported at the first field past the cap", () => {
    const u = toFormModel(deep()).unsupported.find((f) => f.path.startsWith("/deep"));
    expect(u?.path).toBe("/deep/level1/level2/level3/level4/level5");
    expect(u?.reason).toBe("nested more than 5 levels deep, edit as raw JSON");
    // The raw schema is kept whole, so the user can still send the six-level value as JSON.
    expect(JSON.stringify(u?.rawSchema)).toContain("level6");
  });

  it("renders the whole branch when the cap allows it", () => {
    const model = toFormModel(deep(), { maxDepth: 7 });
    expect(model.unsupported.map((f) => f.path)).toEqual(["/choice", "/pair"]);
    expect(outline(model.fields)).toContain("/deep/level1/level2/level3/level4/level5/level6:string*");
  });

  it("cuts exactly at the cap: depth 1 means only top-level scalars survive", () => {
    const model = toFormModel(schemaOf("create_user"), { maxDepth: 1 });
    const user = model.fields[0];
    expect(user?.kind).toBe("object");
    expect(model.unsupported.map((f) => f.path)).toEqual(["/user/name", "/user/address"]);
  });

  it("maxDepth 0 makes every field unsupported but still produces a model", () => {
    const model = toFormModel(schemaOf("echo"), { maxDepth: 0 });
    expect(model.fields.every((f) => f.kind === "unsupported")).toBe(true);
    expect(model.fields).toHaveLength(2);
  });

  it("counts array items as a level", () => {
    const model = toFormModel(schemaOf("tag_items"), { maxDepth: 1 });
    expect(model.unsupported.map((f) => f.path)).toEqual(["/items/0", "/labels/0"]);
  });
});

describe("unsupported escape hatch", () => {
  it("names oneOf, anyOf, allOf, not and if", () => {
    for (const kw of ["oneOf", "anyOf", "allOf", "not", "if"]) {
      const schema = {
        type: "object",
        properties: { f: { [kw]: kw === "not" || kw === "if" ? { type: "string" } : [{ type: "string" }, { type: "integer" }] } },
      };
      const [field] = toFormModel(schema).fields;
      expect(field).toMatchObject({ kind: "unsupported", path: "/f" });
      expect(field?.kind === "unsupported" && field.reason).toContain(kw);
    }
  });

  it("reports a oneOf inside an array item at the item path, and keeps the array", () => {
    const schema = {
      type: "object",
      properties: { filters: { type: "array", items: { oneOf: [{ type: "string" }, { type: "integer" }] } } },
    };
    const model = toFormModel(schema);
    expect(model.fields[0]?.kind).toBe("array");
    expect(model.unsupported).toHaveLength(1);
    expect(model.unsupported[0]).toMatchObject({ path: "/filters/0", rawSchema: schema.properties.filters.items });
    expect(model.unsupported[0]?.reason).toMatch(/^oneOf/);
  });

  it("handles tuples, free-form objects, untyped schemas, arrays without items, and true/false schemas", () => {
    const schema = {
      type: "object",
      properties: {
        tuple: { type: "array", items: [{ type: "string" }] },
        free: { type: "object" },
        free2: { type: "object", additionalProperties: { type: "string" } },
        untyped: { description: "anything" },
        noItems: { type: "array" },
        any: true,
        none: false,
        multi: { type: ["string", "integer"] },
        weirdEnum: { enum: [{ a: 1 }] },
        unknownType: { type: "date" },
      },
    };
    const model = toFormModel(schema);
    expect(model.fields.every((f) => f.kind === "unsupported")).toBe(true);
    const reasons = Object.fromEntries(model.unsupported.map((u) => [u.name, u.reason]));
    expect(reasons["tuple"]).toMatch(/tuple/);
    expect(reasons["free"]).toMatch(/free-form/);
    expect(reasons["free2"]).toMatch(/free-form/);
    expect(reasons["untyped"]).toMatch(/no type/);
    expect(reasons["noItems"]).toMatch(/items/);
    expect(reasons["any"]).toMatch(/any value/);
    expect(reasons["none"]).toMatch(/no value/);
    expect(reasons["multi"]).toMatch(/type/);
    expect(reasons["weirdEnum"]).toMatch(/enum/);
    expect(reasons["unknownType"]).toMatch(/"date"/);
    expect(model.unsupported.find((u) => u.name === "untyped")?.description).toBe("anything");
  });

  it("offers a raw slot for a required property that has no schema", () => {
    const model = toFormModel({ type: "object", properties: { a: { type: "string" } }, required: ["a", "ghost"] });
    expect(model.fields.map((f) => f.name)).toEqual(["a", "ghost"]);
    expect(model.unsupported[0]).toMatchObject({ name: "ghost", path: "/ghost", required: true });
    expect(model.unsupported[0]?.reason).toContain('"ghost"');
  });

  it("escapes pointer characters in property names", () => {
    const model = toFormModel({ type: "object", properties: { "a/b": { type: "string" }, "c~d": { type: "string" } } });
    expect(model.fields.map((f) => f.path)).toEqual(["/a~1b", "/c~0d"]);
  });

  it.each([
    ["null", null],
    ["a number", 42],
    ["a string", "object"],
    ["an array", []],
    ["true", true],
  ])("never throws on a non-object root (%s) and yields one root unsupported", (_l, input) => {
    const model = toFormModel(input);
    expect(model.fields).toHaveLength(1);
    expect(model.fields[0]).toMatchObject({ kind: "unsupported", path: "" });
    expect(model.unsupported).toHaveLength(1);
  });

  it("turns a root oneOf, a non-object root type and a dangling root ref into a root unsupported", () => {
    expect(toFormModel({ oneOf: [{}, {}] }).fields[0]).toMatchObject({ kind: "unsupported", path: "" });
    expect(toFormModel({ type: "array" }).fields[0]).toMatchObject({ kind: "unsupported", path: "" });
    const dangling = toFormModel({ $ref: "#/$defs/Nope" }).fields[0];
    expect(dangling).toMatchObject({ kind: "unsupported", path: "" });
  });

  it("gives an empty form, not an error, for a root object with no properties", () => {
    for (const s of [{ type: "object" }, { type: "object", properties: {} }, {}]) {
      expect(toFormModel(s)).toEqual({ fields: [], unsupported: [] });
    }
  });
});

describe("refs and nullable", () => {
  it("inlines local $refs, with sibling keywords winning", () => {
    const schema = {
      type: "object",
      $defs: { Name: { type: "string", minLength: 2, description: "from def" } },
      properties: { who: { $ref: "#/$defs/Name", description: "from site" } },
    };
    expect(toFormModel(schema).fields[0]).toMatchObject({ kind: "string", minLength: 2, description: "from site" });
  });

  it("resolves a root $ref, as pydantic-style schemas write them", () => {
    const schema = { $ref: "#/$defs/Args", $defs: { Args: { type: "object", properties: { q: { type: "string" } } } } };
    expect(outline(toFormModel(schema).fields)).toEqual(["/q:string"]);
  });

  it("reports unresolvable and circular refs instead of looping", () => {
    const bad = toFormModel({ type: "object", properties: { a: { $ref: "https://example.com/x.json" }, b: { $ref: "#/$defs/missing" } } });
    expect(bad.unsupported.map((u) => u.path)).toEqual(["/a", "/b"]);
    expect(bad.unsupported[0]?.reason).toContain("$ref");

    const loop = toFormModel({ type: "object", $defs: { A: { $ref: "#/$defs/A" } }, properties: { a: { $ref: "#/$defs/A" } } });
    expect(loop.unsupported[0]?.reason).toMatch(/circular/);
  });

  it("stops a recursive schema at the depth cap", () => {
    const tree = { $defs: { Node: { type: "object", properties: { child: { $ref: "#/$defs/Node" }, v: { type: "string" } } } }, type: "object", properties: { root: { $ref: "#/$defs/Node" } } };
    const model = toFormModel(tree);
    // Both the sixth-level child and its sibling leaf are past the cap.
    expect(model.unsupported.map((u) => u.path)).toEqual([
      "/root/child/child/child/child/child",
      "/root/child/child/child/child/v",
    ]);
    expect(model.unsupported.every((u) => /nested more than 5/.test(u.reason))).toBe(true);
  });

  it("collapses X-or-null into X with nullable, in both spellings", () => {
    const model = toFormModel({
      type: "object",
      properties: {
        a: { anyOf: [{ type: "string", minLength: 3 }, { type: "null" }], description: "d" },
        b: { type: ["integer", "null"] },
        c: { oneOf: [{ type: "null" }, { type: "boolean" }] },
      },
    });
    expect(model.unsupported).toEqual([]);
    expect(model.fields[0]).toMatchObject({ kind: "string", minLength: 3, nullable: true, description: "d" });
    expect(model.fields[1]).toMatchObject({ kind: "integer", nullable: true });
    expect(model.fields[2]).toMatchObject({ kind: "boolean", nullable: true });
  });

  it("leaves a real two-way anyOf unsupported", () => {
    const model = toFormModel({ type: "object", properties: { a: { anyOf: [{ type: "string" }, { type: "integer" }] } } });
    expect(model.unsupported[0]?.reason).toMatch(/^anyOf/);
  });

  it("treats const as a one-value enum", () => {
    const f = toFormModel({ type: "object", properties: { k: { const: "fixed" } } }).fields[0];
    expect(f).toMatchObject({ kind: "enum", values: ["fixed"] });
  });

  it("uses title as the label and falls back to the name", () => {
    const [a, b] = toFormModel({ type: "object", properties: { a: { type: "string", title: "A title" }, b: { type: "string" } } }).fields;
    expect([a?.label, b?.label]).toEqual(["A title", "b"]);
  });
});

describe("rebasePath and fieldAtPath", () => {
  it("rebases an item template onto a real row", () => {
    const items = modelOf("tag_items").fields[0];
    if (items?.kind !== "array") throw new Error("expected array");
    const row = rebasePath(items.item, "/items/0", "/items/3");
    expect(outline([row])).toEqual(["/items/3:object*", "/items/3/id:integer*", "/items/3/label:string"]);
    // The template itself is untouched.
    expect(items.item.path).toBe("/items/0");
  });

  it("finds a field through array rows and returns the real path", () => {
    const model = modelOf("tag_items");
    expect(fieldAtPath(model, "/items/2/id")).toMatchObject({ path: "/items/2/id", field: { kind: "integer", name: "id" } });
    expect(fieldAtPath(model, "/items")).toMatchObject({ path: "/items", field: { kind: "array" } });
    expect(fieldAtPath(model, "/nope")).toBeUndefined();
  });

  it("falls back to the nearest enclosing field for a path inside a raw JSON field", () => {
    const model = modelOf("hostile_schema");
    expect(fieldAtPath(model, "/choice/id")).toMatchObject({ path: "/choice", field: { kind: "unsupported" } });
    expect(fieldAtPath(model, "/deep/level1/level2/level3/level4/level5/level6")?.path).toBe(
      "/deep/level1/level2/level3/level4/level5",
    );
  });
});
