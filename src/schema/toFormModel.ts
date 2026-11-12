// JSON Schema (an MCP tool's `inputSchema`) to an ordered form model. Pure: no I/O, never throws.
import type { EnumValue, FormField, FormModel, UnsupportedField } from "./model.js";
import { joinPointer } from "./pointer.js";

type SchemaObject = Record<string, unknown>;

/**
 * Nesting levels (objects and arrays) below the root that become real fields. A field at depth
 * `maxDepth + 1` or deeper is emitted as `unsupported`. A top-level property has depth 1.
 */
export const DEFAULT_MAX_DEPTH = 5;

export interface FormModelOptions {
  maxDepth?: number;
}

interface Ctx {
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
    { ...slot, label: str(schema["title"]) ?? slot.name },
    { description: str(schema["description"]), default: schema["default"] },
  );
}

function unsupported(slot: Slot, schema: unknown, reason: string): UnsupportedField {
  return { kind: "unsupported", ...base(slot, isObject(schema) ? schema : {}), reason, rawSchema: schema };
}

function requiredNames(schema: SchemaObject): Set<string> {
  const r = schema["required"];
  return new Set(Array.isArray(r) ? r.filter((x): x is string => typeof x === "string") : []);
}

/** Properties in declaration order. `depth` is the depth of the fields being created. */
function buildProperties(schema: SchemaObject, parentPath: string, depth: number, ctx: Ctx): FormField[] {
  const props = schema["properties"];
  if (!isObject(props)) return [];
  const required = requiredNames(schema);
  return Object.entries(props).map(([name, sub]) =>
    build(sub, { name, path: joinPointer(parentPath, name), required: required.has(name) }, depth, ctx),
  );
}

function build(schema: unknown, slot: Slot, depth: number, ctx: Ctx): FormField {
  if (!isObject(schema)) return unsupported(slot, schema, "schema is a boolean, not an object schema");
  if (depth > ctx.maxDepth) {
    return unsupported(slot, schema, `nested more than ${ctx.maxDepth} levels deep, edit as raw JSON`);
  }
  const common = base(slot, schema);

  if (Array.isArray(schema["enum"]) && schema["enum"].length > 0 && schema["enum"].every(isEnumValue)) {
    return { kind: "enum", ...common, values: [...(schema["enum"] as EnumValue[])] };
  }
  if ("const" in schema && isEnumValue(schema["const"])) {
    return { kind: "enum", ...common, values: [schema["const"]] };
  }

  switch (schema["type"]) {
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
        { kind: schema["type"], ...common },
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
        return unsupported(slot, schema, "object without declared properties, edit as raw JSON");
      }
      return { kind: "object", ...common, fields: buildProperties(schema, slot.path, depth + 1, ctx) };
    case "array": {
      if (!isObject(schema["items"])) {
        return unsupported(slot, schema, "array without an items schema, edit as raw JSON");
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
    default:
      return unsupported(slot, schema, `type ${JSON.stringify(schema["type"] ?? null)} is not supported yet`);
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

/** Top-level properties become the fields, in the order the schema declares them. */
export function toFormModel(schema: unknown, opts: FormModelOptions = {}): FormModel {
  const ctx: Ctx = { maxDepth: opts.maxDepth ?? DEFAULT_MAX_DEPTH };
  const fields = isObject(schema) ? buildProperties(schema, "", 1, ctx) : [];
  return { fields, unsupported: collectUnsupported(fields, []) };
}
