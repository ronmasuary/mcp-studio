// Validation of a call payload against the tool's own JSON Schema, with one message per field.
//
// This uses Ajv2020 directly, on purpose. MCP schemas are JSON Schema 2020-12 (`prefixItems`,
// `$defs`), which the default draft-07 `Ajv` class rejects, and the SDK's AjvJsonSchemaValidator
// wrapper returns only `{ valid, data, errorMessage }`: no `errors[]`, so no `instancePath` to put a
// message under the right input. See docs/adr/0003-schema-subset.md.
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsImport, { type FormatsPlugin } from "ajv-formats";
import type { FieldError, FormModel, FormState } from "./model.js";
import { escapePointerSegment, fieldAtPath } from "./pointer.js";
import { toArgs } from "./toArgs.js";

// ajv-formats is CommonJS with `exports.default`; under NodeNext the default import is the module
// object for the type checker and the plugin itself at runtime. Accept both.
const addFormats: FormatsPlugin =
  (addFormatsImport as unknown as { default?: FormatsPlugin }).default ?? (addFormatsImport as unknown as FormatsPlugin);

export interface ValidationResult {
  /** No schema violations found. The server remains the final judge. */
  valid: boolean;
  errors: FieldError[];
  /** The same messages grouped by field path, ready for lookup while rendering. */
  byPath: Record<string, string[]>;
  /**
   * Set when the tool's schema itself could not be compiled (an unknown `$ref`, draft-07 tuple
   * `items`). `valid` is then true and `errors` empty: a schema we cannot read must not block a call.
   */
  schemaError?: string;
}

export interface FormValidation extends ValidationResult {
  /** The payload that was validated, so the caller sends exactly what was checked. */
  args: Record<string, unknown>;
}

type Compiled = { validate: ValidateFunction } | { error: string };

// Keyed by schema object identity: a tool's inputSchema is validated on every keystroke, and
// compiling is by far the costly step. A WeakMap lets entries go with the schema.
const cache = new WeakMap<object, Compiled>();

function compile(schema: object): Compiled {
  const hit = cache.get(schema);
  if (hit) return hit;
  let result: Compiled;
  try {
    // A fresh instance per schema, so two tools that declare the same `$id` cannot collide. `$schema`
    // is dropped because Ajv2020 throws on any dialect it was not given, and tools in the wild
    // still say draft-07; the keywords in use are validated by what they are, not by the label.
    const rest = Object.fromEntries(Object.entries(schema).filter(([k]) => k !== "$schema"));
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    result = { validate: ajv.compile(rest) };
  } catch (err) {
    result = { error: err instanceof Error ? err.message : String(err) };
  }
  cache.set(schema, result);
  return result;
}

/** `required` and `additionalProperties` report the parent; the field at fault is the child. */
function errorPath(e: ErrorObject): string {
  const p = e.params as Record<string, unknown>;
  const child = p["missingProperty"] ?? p["additionalProperty"] ?? p["unevaluatedProperty"];
  return typeof child === "string" ? `${e.instancePath}/${escapePointerSegment(child)}` : e.instancePath;
}

function message(e: ErrorObject): string {
  const p = e.params as Record<string, unknown>;
  switch (e.keyword) {
    case "required":
      return "is required";
    case "additionalProperties":
    case "unevaluatedProperties":
      return "is not an allowed property";
    case "enum":
      return Array.isArray(p["allowedValues"])
        ? `must be one of: ${p["allowedValues"].map((v) => JSON.stringify(v)).join(", ")}`
        : "must be one of the allowed values";
    default:
      return e.message ?? `failed ${e.keyword}`;
  }
}

/** Errors from inside a oneOf/anyOf branch describe a branch the user did not pick; the combinator's own error says it. */
const inBranch = (e: ErrorObject): boolean => /\/(oneOf|anyOf)\/\d+(\/|$)/.test(e.schemaPath);

function toFieldErrors(errors: ErrorObject[], model: FormModel | undefined): FieldError[] {
  const out: FieldError[] = [];
  const seen = new Set<string>();
  for (const e of errors) {
    if (inBranch(e)) continue;
    const instancePath = errorPath(e);
    const owner = model ? fieldAtPath(model, instancePath) : undefined;
    const path = owner ? owner.path : instancePath;
    const msg = message(e);
    const key = `${path}\u0000${msg}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path, message: msg, keyword: e.keyword, ...(path !== instancePath ? { instancePath } : {}) });
  }
  return out;
}

function group(errors: FieldError[]): Record<string, string[]> {
  const byPath: Record<string, string[]> = {};
  for (const e of errors) (byPath[e.path] ??= []).push(e.message);
  return byPath;
}

function result(errors: FieldError[], schemaError?: string): ValidationResult {
  return { valid: errors.length === 0, errors, byPath: group(errors), ...(schemaError ? { schemaError } : {}) };
}

/**
 * Validates `args` against `schema`. With a `model`, each error's `path` is the rendered field that
 * owns it (so an error inside an `unsupported` JSON editor lands on that editor, with the exact
 * location kept in `instancePath`); without one, `path` is Ajv's `instancePath`. Never throws.
 */
export function validateArgs(schema: unknown, args: unknown, model?: FormModel): ValidationResult {
  if (typeof schema !== "object" || schema === null) return result([], "input schema is not an object");
  const compiled = compile(schema);
  if ("error" in compiled) return result([], compiled.error);
  compiled.validate(args);
  return result(toFieldErrors(compiled.validate.errors ?? [], model));
}

/**
 * The whole pipeline for one Run click: coerce the form state, then validate the payload. Errors
 * toArgs raised (unparseable raw JSON) come first and suppress the schema error for the same field,
 * since "required" on a field whose JSON failed to parse is just noise.
 */
export function validateForm(model: FormModel, schema: unknown, state: FormState): FormValidation {
  const built = toArgs(model, state);
  const checked = validateArgs(schema, built.args, model);
  const blocked = new Set(built.errors.map((e) => e.path));
  const errors = [...built.errors, ...checked.errors.filter((e) => !blocked.has(e.path))];
  const base = result(errors, checked.schemaError);
  return { ...base, args: built.args };
}
