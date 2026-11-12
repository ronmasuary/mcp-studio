// Form state to the `arguments` object of a tools/call request.
//
// The rules, in one place: an empty optional is dropped rather than sent as "" or null, text typed
// into a number field becomes a number, a field the user never touched is left to the server's own
// default, a blank required scalar is left out so validation reports it as required, and nothing
// here throws. A value that cannot be coerced is passed through unchanged so validation reports it
// against the right field, except raw JSON that does not parse, which has no value to pass and is
// reported here. A user who really wants an empty string for a required field uses the raw JSON
// editor.
import type { FieldError, FormField, FormModel, FormState } from "./model.js";
import { joinPointer } from "./pointer.js";

export interface ArgsResult {
  args: Record<string, unknown>;
  /** Only problems that stop a value being produced at all (unparseable raw JSON). */
  errors: FieldError[];
}

const NUMBER_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Nothing to send. A string field is blank only when empty, since "  " is a value the user typed. */
function isBlank(field: FormField, value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "string") return false;
  return field.kind === "string" ? value === "" : value.trim() === "";
}

/** True when the user typed something in this subtree. Untouched optional objects are not sent. */
function hasInput(field: FormField, value: unknown): boolean {
  if (field.kind === "object") {
    const source = isRecord(value) ? value : {};
    return field.fields.some((f) => hasInput(f, source[f.name]));
  }
  if (field.kind === "array") return Array.isArray(value) && value.some((row) => hasInput(field.item, row));
  return !isBlank(field, value);
}

interface Pass {
  errors: FieldError[];
}

/** `inArray` rows are values, not optional slots: a blank scalar row is dropped, not sent as "". */
function coerce(field: FormField, value: unknown, path: string, pass: Pass, inArray: boolean): unknown {
  if (value === null && field.nullable) return null;
  if (field.kind === "object") {
    if (!field.required && !hasInput(field, value)) return undefined;
    return coerceObject(field.fields, value, path, pass);
  }
  if (field.kind === "array") return coerceArray(field, value, path, pass);
  if (field.kind === "unsupported") return coerceRaw(value, path, pass);

  if (isBlank(field, value)) {
    if (inArray || !field.required) return undefined;
    return field.nullable ? null : undefined;
  }

  switch (field.kind) {
    case "string":
      return typeof value === "string" ? value : String(value);
    case "number":
    case "integer": {
      if (typeof value === "number") return value;
      const text = String(value).trim();
      return NUMBER_TEXT.test(text) ? Number(text) : value;
    }
    case "boolean": {
      if (typeof value === "boolean") return value;
      const text = String(value).trim().toLowerCase();
      return text === "true" ? true : text === "false" ? false : value;
    }
    case "enum": {
      const hit = field.values.find((v) => v === value || (typeof value === "string" && String(v) === value));
      return hit === undefined ? value : hit;
    }
  }
}

function coerceObject(fields: FormField[], value: unknown, path: string, pass: Pass): Record<string, unknown> {
  const source = isRecord(value) ? value : {};
  const out: Record<string, unknown> = {};
  for (const child of fields) {
    const v = coerce(child, source[child.name], joinPointer(path, child.name), pass, false);
    if (v !== undefined) out[child.name] = v;
  }
  return out;
}

function coerceArray(field: Extract<FormField, { kind: "array" }>, value: unknown, path: string, pass: Pass): unknown {
  const rows = Array.isArray(value) ? value : [];
  const out: unknown[] = [];
  rows.forEach((row, i) => {
    const v = coerce(field.item, row, joinPointer(path, i), pass, true);
    if (v !== undefined) out.push(v);
  });
  return out.length === 0 && !field.required ? undefined : out;
}

/** Raw JSON from the escape-hatch editor. Text is parsed; anything already parsed passes through. */
function coerceRaw(value: unknown, path: string, pass: Pass): unknown {
  if (typeof value !== "string") return value === null ? undefined : value;
  if (value.trim() === "") return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch (err) {
    pass.errors.push({ path, keyword: "json", message: `not valid JSON: ${err instanceof Error ? err.message : String(err)}` });
    return undefined;
  }
}

/**
 * Builds the `arguments` payload for `model` from `state`. Keys follow the model's order, state keys
 * the model does not know are ignored, and a value the user left blank is omitted so the server
 * applies its own default.
 *
 * If the whole input schema was unsupported (a field at path ""), the state's `""` entry is the
 * raw JSON for the entire arguments object.
 */
export function toArgs(model: FormModel, state: FormState): ArgsResult {
  const pass: Pass = { errors: [] };
  const only = model.fields.length === 1 ? model.fields[0] : undefined;
  if (only && only.kind === "unsupported" && only.path === "") {
    const raw = coerceRaw(state[""], "", pass);
    if (raw !== undefined && !isRecord(raw)) {
      pass.errors.push({ path: "", keyword: "json", message: "arguments must be a JSON object" });
      return { args: {}, errors: pass.errors };
    }
    return { args: (raw as Record<string, unknown> | undefined) ?? {}, errors: pass.errors };
  }
  const args = coerceObject(model.fields, state, "", pass);
  return { args, errors: pass.errors };
}
