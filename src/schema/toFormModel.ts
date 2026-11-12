// JSON Schema (an MCP tool's `inputSchema`) to an ordered form model. Pure: no I/O, never throws.
//
// The supported subset is deliberately small (see docs/adr/0003-schema-subset.md): scalars, enums,
// objects with declared properties, arrays of one item schema, local $refs, and "nullable" written
// as `anyOf: [X, null]` or `type: [X, "null"]`. Everything else becomes an `unsupported` field that
// carries a reason, a path and the raw schema, so the UI can offer a raw JSON editor for just that
// part instead of giving up on the tool.
import type { EnumValue, FormField, FormModel, UnsupportedField } from "./model.js";
import { joinPointer, unescapePointerSegment } from "./pointer.js";

type SchemaObject = Record<string, unknown>;

/**
 * Nesting levels (objects and arrays) below the root that become real fields. A field at depth
 * `maxDepth + 1` or deeper is emitted as `unsupported`. A top-level property has depth 1.
 */
export const DEFAULT_MAX_DEPTH = 5;

/** Longest `$ref` to `$ref` chain followed before giving up, so a self-referencing ref cannot loop. */
const MAX_REF_HOPS = 16;

/** Keywords that make a schema's shape depend on the value, which a static form cannot express. */
const UNSUPPORTED_KEYWORDS = ["oneOf", "anyOf", "allOf", "not", "if"] as const;

export interface FormModelOptions {
  maxDepth?: number;
}

interface Ctx {
  root: SchemaObject;
  maxDepth: number;
}

interface Slot {
  name: string;
  path: string;
  required: boolean;
}

function isObject(v: unknown): v is SchemaObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function isEnumValue(v: unknown): v is EnumValue {
  return v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/** Copies only the entries that are present, so a field never carries `minimum: undefined`. */
function pick<T extends object>(out: T, entries: Record<string, unknown>): T {
  for (const [k, v] of Object.entries(entries)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

function base(slot: Slot, schema: SchemaObject): Slot & { label: string } {
  return pick(
    { ...slot, label: str(schema["title"]) ?? (slot.name || "arguments") },
    { description: str(schema["description"]), default: schema["default"] },
  );
}

function unsupported(slot: Slot, schema: unknown, reason: string): UnsupportedField {
  return { kind: "unsupported", ...base(slot, isObject(schema) ? schema : {}), reason, rawSchema: schema };
}

function omit(o: SchemaObject, key: string): SchemaObject {
  return Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));
}

function requiredNames(schema: SchemaObject): string[] {
  const r = schema["required"];
  return Array.isArray(r) ? r.filter((x): x is string => typeof x === "string") : [];
}

/** Follows `#/...` pointers into the root schema. Anything else (URLs, anchors) is not resolved. */
function lookupLocalRef(ref: string, root: SchemaObject): unknown {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  let node: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    let key: string;
    try {
      key = unescapePointerSegment(decodeURIComponent(raw));
    } catch {
      return undefined;
    }
    if (!isObject(node) && !Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

type Resolved = { schema: SchemaObject } | { error: string };

/** Inlines `$ref`. Sibling keywords next to the ref win over the target, as in draft 2020-12. */
function resolveRefs(schema: SchemaObject, root: SchemaObject): Resolved {
  let current = schema;
  for (let hop = 0; hop < MAX_REF_HOPS; hop++) {
    const ref = current["$ref"];
    if (typeof ref !== "string") return { schema: current };
    const target = lookupLocalRef(ref, root);
    if (!isObject(target)) {
      return { error: `$ref "${ref}" does not resolve to a schema in this document, edit as raw JSON` };
    }
    const siblings = omit(current, "$ref");
    current = { ...target, ...siblings };
  }
  return { error: "$ref chain is too long or circular, edit as raw JSON" };
}

const isNullSchema = (s: unknown): boolean => isObject(s) && s["type"] === "null" && !("enum" in s);

/**
 * Collapses the two spellings of "X or null" into X plus a nullable flag. Anything wider than that
 * (two real alternatives, or three branches) is left alone and reported as unsupported.
 */
function collapseNullable(schema: SchemaObject): { schema: SchemaObject; nullable: boolean } {
  for (const kw of ["anyOf", "oneOf"] as const) {
    const branches = schema[kw];
    if (Array.isArray(branches) && branches.length === 2) {
      const real = branches.filter((b) => !isNullSchema(b));
      if (real.length === 1 && isObject(real[0])) {
        const rest = omit(schema, kw);
        return { schema: { ...real[0], ...rest }, nullable: true };
      }
    }
  }
  const t = schema["type"];
  if (Array.isArray(t) && t.length === 2 && t.includes("null")) {
    const other = t.find((x) => x !== "null");
    if (typeof other === "string") return { schema: { ...schema, type: other }, nullable: true };
  }
  return { schema, nullable: false };
}

/** Properties in declaration order, then required names that have no schema. */
function buildProperties(schema: SchemaObject, parentPath: string, depth: number, ctx: Ctx): FormField[] {
  const props = isObject(schema["properties"]) ? schema["properties"] : {};
  const required = new Set(requiredNames(schema));
  const fields = Object.entries(props).map(([name, sub]) =>
    build(sub, { name, path: joinPointer(parentPath, name), required: required.has(name) }, depth, ctx),
  );
  for (const name of required) {
    if (name in props) continue;
    // Required but never declared: the server will reject a call without it, and the form has no
    // type to render. Offer a raw JSON slot rather than silently dropping a required argument.
    fields.push(
      unsupported(
        { name, path: joinPointer(parentPath, name), required: true },
        {},
        `required property "${name}" has no schema in properties, edit as raw JSON`,
      ),
    );
  }
  return fields;
}

function inferType(schema: SchemaObject): string | undefined {
  if (isObject(schema["properties"])) return "object";
  if ("items" in schema || "prefixItems" in schema) return "array";
  return undefined;
}

type Common = ReturnType<typeof base> & { nullable?: boolean };

function buildArray(input: SchemaObject, schema: SchemaObject, common: Common, slot: Slot, depth: number, ctx: Ctx): FormField {
  if ("prefixItems" in schema || Array.isArray(schema["items"])) {
    return unsupported(slot, input, "tuple array (prefixItems) has a different schema per position, edit as raw JSON");
  }
  if (!isObject(schema["items"])) {
    return unsupported(slot, input, "array without an items schema, edit as raw JSON");
  }
  const item = build(schema["items"], { name: "0", path: joinPointer(slot.path, 0), required: true }, depth + 1, ctx);
  return pick(
    { kind: "array" as const, ...common, item },
    {
      minItems: num(schema["minItems"]),
      maxItems: num(schema["maxItems"]),
      uniqueItems: typeof schema["uniqueItems"] === "boolean" ? schema["uniqueItems"] : undefined,
    },
  );
}

function build(input: unknown, slot: Slot, depth: number, ctx: Ctx): FormField {
  if (input === true) return unsupported(slot, input, "schema accepts any value, edit as raw JSON");
  if (input === false) return unsupported(slot, input, "schema accepts no value, edit as raw JSON");
  if (!isObject(input)) return unsupported(slot, input, "schema is not an object, edit as raw JSON");
  if (depth > ctx.maxDepth) {
    return unsupported(slot, input, `nested more than ${ctx.maxDepth} levels deep, edit as raw JSON`);
  }
  const resolved = resolveRefs(input, ctx.root);
  if ("error" in resolved) return unsupported(slot, input, resolved.error);

  const { schema, nullable } = collapseNullable(resolved.schema);
  for (const kw of UNSUPPORTED_KEYWORDS) {
    if (kw in schema) {
      const branches = schema[kw];
      const count = Array.isArray(branches) ? ` (${branches.length} alternatives)` : "";
      return unsupported(slot, input, `${kw}${count} is outside the supported subset, edit as raw JSON`);
    }
  }

  const common: Common = { ...base(slot, schema), ...(nullable ? { nullable: true } : {}) };

  if (Array.isArray(schema["enum"]) && schema["enum"].length > 0 && schema["enum"].every(isEnumValue)) {
    return { kind: "enum", ...common, values: [...(schema["enum"] as EnumValue[])] };
  }
  if ("const" in schema && isEnumValue(schema["const"])) {
    return { kind: "enum", ...common, values: [schema["const"]] };
  }
  if ("enum" in schema) return unsupported(slot, input, "enum with non-primitive or no values, edit as raw JSON");

  const type = schema["type"] ?? inferType(schema);
  switch (type) {
    case "string":
      return pick(
        { kind: "string" as const, ...common },
        {
          minLength: num(schema["minLength"]),
          maxLength: num(schema["maxLength"]),
          pattern: str(schema["pattern"]),
          format: str(schema["format"]),
        },
      );
    case "number":
    case "integer":
      return pick(
        { kind: type === "integer" ? ("integer" as const) : ("number" as const), ...common },
        {
          minimum: num(schema["minimum"]),
          maximum: num(schema["maximum"]),
          exclusiveMinimum: num(schema["exclusiveMinimum"]),
          exclusiveMaximum: num(schema["exclusiveMaximum"]),
          multipleOf: num(schema["multipleOf"]),
        },
      );
    case "boolean":
      return { kind: "boolean", ...common };
    case "object":
      if (!isObject(schema["properties"])) {
        return unsupported(slot, input, "free-form object with no declared properties, edit as raw JSON");
      }
      return { kind: "object", ...common, fields: buildProperties(schema, slot.path, depth + 1, ctx) };
    case "array":
      return buildArray(input, schema, common, slot, depth, ctx);
    case undefined:
      return unsupported(slot, input, "schema has no type, edit as raw JSON");
    default:
      return unsupported(slot, input, `type ${JSON.stringify(type)} is not supported, edit as raw JSON`);
  }
}

function collectUnsupported(fields: FormField[], out: UnsupportedField[]): UnsupportedField[] {
  for (const f of fields) {
    if (f.kind === "unsupported") out.push(f);
    else if (f.kind === "object") collectUnsupported(f.fields, out);
    else if (f.kind === "array") collectUnsupported([f.item], out);
  }
  return out;
}

const ROOT: Slot = { name: "", path: "", required: true };

/** The root is rendered as a flat list of fields, so it gets its own, stricter, checks. */
function rootFields(schema: unknown, ctx: Ctx): FormField[] {
  if (!isObject(schema)) return [unsupported(ROOT, schema, "input schema is not an object schema, edit as raw JSON")];
  const resolved = resolveRefs(schema, ctx.root);
  if ("error" in resolved) return [unsupported(ROOT, schema, resolved.error)];
  const root = resolved.schema;
  const keyword = UNSUPPORTED_KEYWORDS.find((k) => k in root);
  if (keyword) return [unsupported(ROOT, schema, `root ${keyword} is outside the supported subset, edit as raw JSON`)];
  if (root["type"] !== undefined && root["type"] !== "object") {
    return [unsupported(ROOT, schema, "root type is not object, edit as raw JSON")];
  }
  return buildProperties(root, "", 1, ctx);
}

/**
 * Builds the form for a tool's `inputSchema`. The top-level properties become the fields, in the
 * order the schema declares them. A root that is not an object schema becomes one `unsupported`
 * field at path "" so the tool stays callable through the raw JSON editor.
 */
export function toFormModel(schema: unknown, opts: FormModelOptions = {}): FormModel {
  const ctx: Ctx = { root: isObject(schema) ? schema : {}, maxDepth: opts.maxDepth ?? DEFAULT_MAX_DEPTH };
  const fields = rootFields(schema, ctx);
  return { fields, unsupported: collectUnsupported(fields, []) };
}
