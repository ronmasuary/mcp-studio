// JSON Schema (an MCP tool's `inputSchema`) to an ordered form model. Pure: no I/O, never throws.
import type { EnumValue, FormField, FormModel, UnsupportedField } from "./model.js";
import { joinPointer } from "./pointer.js";

type SchemaObject = Record<string, unknown>;

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

/** Only keys that are present, so a field object never carries `minimum: undefined`. */
function pick<T extends object>(out: T, entries: Record<string, unknown>): T {
  for (const [k, v] of Object.entries(entries)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

interface Slot {
  name: string;
  path: string;
  required: boolean;
}

function base(slot: Slot, schema: SchemaObject): Slot & { label: string } {
  return pick(
    { ...slot, label: str(schema["title"]) ?? slot.name },
    { description: str(schema["description"]), default: schema["default"] },
  );
}

function unsupported(slot: Slot, schema: unknown, reason: string): UnsupportedField {
  const s = isObject(schema) ? schema : {};
  return { kind: "unsupported", ...base(slot, s), reason, rawSchema: schema };
}

function build(schema: unknown, slot: Slot): FormField {
  if (!isObject(schema)) return unsupported(slot, schema, "schema is a boolean, not an object schema");
  const common = base(slot, schema);

  if (Array.isArray(schema["enum"]) && schema["enum"].every(isEnumValue) && schema["enum"].length > 0) {
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
    default:
      return unsupported(slot, schema, `type ${JSON.stringify(schema["type"] ?? null)} is not supported yet`);
  }
}

function collectUnsupported(fields: FormField[], out: UnsupportedField[]): UnsupportedField[] {
  for (const f of fields) if (f.kind === "unsupported") out.push(f);
  return out;
}

/** Top-level properties become the fields, in the order the schema declares them. */
export function toFormModel(schema: unknown): FormModel {
  const fields: FormField[] = [];
  if (isObject(schema) && isObject(schema["properties"])) {
    const required = new Set(Array.isArray(schema["required"]) ? schema["required"].filter((r) => typeof r === "string") : []);
    for (const [name, sub] of Object.entries(schema["properties"])) {
      fields.push(build(sub, { name, path: joinPointer("", name), required: required.has(name) }));
    }
  }
  return { fields, unsupported: collectUnsupported(fields, []) };
}
