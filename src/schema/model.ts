// The form model: what the UI renders, produced from a tool's JSON Schema by toFormModel. Pure
// data. This module and everything beside it in src/schema/ must stay free of React, the API
// layer and any I/O, because Firewall and Vault reuse it.

/** A JSON value that can sit in an `enum` and still be shown as one choice in a select. */
export type EnumValue = string | number | boolean | null;

interface FieldBase {
  /** The property name, or "0" for the single item template of an array. */
  name: string;
  /**
   * JSON Pointer to the instance this field edits, in the same format as Ajv's `instancePath`
   * ("" is the root, "/user/address/city" a leaf). An array's item template is addressed at index
   * 0 ("/items/0"); the UI rebases it for each real row with `rebasePath`.
   */
  path: string;
  /** The schema `title` when there is one, otherwise the property name. */
  label: string;
  required: boolean;
  description?: string;
  /** The schema `default`, verbatim. Shown as a hint; toArgs never sends it, the server applies it. */
  default?: unknown;
  /** The schema allows `null` as well (for example `anyOf: [X, { type: "null" }]`). */
  nullable?: boolean;
}

export interface StringField extends FieldBase {
  kind: "string";
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
}

interface NumericConstraints {
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
}

export interface NumberField extends FieldBase, NumericConstraints {
  kind: "number";
}

export interface IntegerField extends FieldBase, NumericConstraints {
  kind: "integer";
}

export interface BooleanField extends FieldBase {
  kind: "boolean";
}

export interface EnumField extends FieldBase {
  kind: "enum";
  /** In schema order. A `const` becomes an enum with one value. */
  values: EnumValue[];
}

export interface ArrayField extends FieldBase {
  kind: "array";
  /** One template; the UI instantiates it once per row. Its `required` is always true. */
  item: FormField;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
}

export interface ObjectField extends FieldBase {
  kind: "object";
  /** In schema declaration order, which is the order the UI renders. */
  fields: FormField[];
}

/**
 * The escape hatch. Anything outside the supported subset lands here instead of throwing, and the
 * UI renders `rawSchema` plus a JSON editor, so a hostile schema never makes a tool uncallable.
 * `reason` and `path` are what turn it from a dead end into an instruction: "oneOf at
 * /filters/0, edit as raw JSON".
 */
export interface UnsupportedField extends FieldBase {
  kind: "unsupported";
  /** Human-readable, never empty. */
  reason: string;
  rawSchema: unknown;
}

export type FormField =
  | StringField
  | NumberField
  | IntegerField
  | BooleanField
  | EnumField
  | ArrayField
  | ObjectField
  | UnsupportedField;

export type FormFieldKind = FormField["kind"];

export interface FormModel {
  /** The tool's top-level arguments, in schema order. */
  fields: FormField[];
  /** Every unsupported field anywhere in the tree, in tree order, so the UI can show one banner. */
  unsupported: UnsupportedField[];
}
