# ADR-0003: The JSON Schema subset the form renders, the depth cap, the escape hatch, and Ajv2020 over the SDK wrapper

Status: accepted (Phase 3, task 3.8)

## Context

The product is a form generated from a tool's `inputSchema`. MCP schemas are JSON Schema 2020-12 and
come from servers we do not control: some are flat and tidy, some use `oneOf`, tuples, recursion or
`$ref`. A form generator that tries to render all of JSON Schema never finishes, and one that throws
on the first keyword it does not know makes that tool uncallable from the UI. The code that does
this lives in `src/schema/` and is reused by two later projects, so it is pure: no React, no API
layer, no I/O, and it does not import `src/mcp/` (it takes a plain JSON Schema, not a `ToolDef`).

Validation has the same shape of problem. The UI wants one message under the input that caused it,
which needs Ajv's `errors[]` with `instancePath`. Three things in the installed packages decide how
that is done (ajv 8.20.0, ajv-formats 3.0.1 and `@modelcontextprotocol/sdk` 1.32.2, all checked
against `node_modules` and by running them, not from memory):

1. `import Ajv from "ajv"` is the draft-07 class. Compiling a schema whose `$schema` is the 2020-12
   URI throws `no schema with key or ref "https://json-schema.org/draft/2020-12/schema"`. Compiling
   one without `$schema` that uses `prefixItems` with `items: false` does not throw, but it silently
   ignores `prefixItems` and applies `items: false` to every element, so `["a"]` is rejected too.
   Both outcomes are wrong, and the second is quiet.
2. The SDK's `AjvJsonSchemaValidator` builds exactly that draft-07 `Ajv`, and its validator function
   returns `{ valid, data, errorMessage }` where `errorMessage` is `ajv.errorsText(errors)`, one
   string. The structured `errors[]` never leave the wrapper.
3. `ajv/dist/2020` exports `Ajv2020` (as a named export and as `default`), and `ajv-formats` 3.0.1
   works on it.

## Decision

### The supported subset

`toFormModel(schema)` returns `{ fields, unsupported }`. `fields` is the ordered, renderable tree;
`unsupported` is that tree's `unsupported` nodes, flattened, so the UI can show one banner.

| Schema shape | Field kind | Constraints carried |
|---|---|---|
| `type: "string"` | `string` | `minLength`, `maxLength`, `pattern`, `format` |
| `type: "number"`, `"integer"` | `number`, `integer` | `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf` |
| `type: "boolean"` | `boolean` | none |
| `enum` of primitives, `const` | `enum` | `values` in schema order (`const` is a one-value enum) |
| `type: "object"` with `properties` | `object` | `fields`, in declaration order |
| `type: "array"` with one `items` schema | `array` | `item` template, `minItems`, `maxItems`, `uniqueItems` |
| `$ref` to `#/...` in the same document | whatever it points at | sibling keywords next to the ref win |
| `anyOf` or `oneOf` of `[X, {type:"null"}]`, or `type: [X, "null"]` | X, with `nullable: true` | as X |

Every field also carries `name`, `path`, `label` (the schema `title`, else the name), `required`,
and `description` and `default` when present. `path` is a JSON Pointer in the same format as Ajv's
`instancePath`, so an error finds its field by string equality. An array's item template is
addressed at index 0 and `rebasePath` moves it onto row N.

Ordering: properties are emitted in the order the schema declares them, not required-first. The
schema author put the fields in an order for a reason, and the order must not change when a
`required` list is edited. Required names that have no entry in `properties` are appended as
`unsupported` fields, so a required argument is never silently dropped.

### The escape hatch

Anything else becomes `{ kind: "unsupported", reason, path, rawSchema }` (plus the usual `name`,
`label` and `required`). It never throws and never removes the tool: the UI renders the raw schema
and a JSON editor for that field, and `toArgs` parses the text. `reason` is never empty and names
the cause, and `path` names the place, so the UI can say "oneOf at `/filters/0`, edit as raw JSON".
The fixture's `hostile_schema` produces exactly three, and no other fixture tool produces any:

| Path | Reason |
|---|---|
| `/choice` | `oneOf (2 alternatives) is outside the supported subset, edit as raw JSON` |
| `/deep/level1/level2/level3/level4/level5` | `nested more than 5 levels deep, edit as raw JSON` |
| `/pair` | `tuple array (prefixItems) has a different schema per position, edit as raw JSON` |

The unsupported cases are `oneOf`, `anyOf` (beyond nullable), `allOf`, `not`, `if`, tuples
(`prefixItems` or array-form `items`), free-form objects (no `properties`), schemas with no `type`,
`type` unions other than "X or null", enums of objects, `true` and `false` schemas, a `$ref` that is
not a local pointer or does not resolve, and a root that is not an object schema (reported once at
path `""`, in which case the whole `arguments` object is raw JSON). Only the offending field is
replaced, not its parent: an array of `oneOf` items stays an array and only its item template is
unsupported.

### The depth cap

Objects and arrays count as a level, and a top-level property has depth 1. A field at depth 6 or
deeper (`DEFAULT_MAX_DEPTH = 5`, overridable with `maxDepth`) is emitted as `unsupported`, with the
whole subtree kept in `rawSchema`. Five was chosen because the deepest realistic tool schemas
(`create_user` is three levels) sit well inside it, five nested indented groups is already near
the limit of a usable pane, and the hostile fixture is six levels deep, so the cap is exercised by a
real schema and not a toy. The cap also bounds recursive schemas: a self-referencing `$ref` resolves
one level per step and stops at the cap rather than looping, and a `$ref` that points at itself is
caught separately after 16 hops.

### From form state to a payload

The plan wrote `toArgs(formState)`; the model is a required second argument because type coercion and the drop-empty-optionals rule both need the field kinds and `required` flags, which form state alone does not carry.

`toArgs(model, state)` returns `{ args, errors }`.

- Text typed into a number or integer field becomes a number (`"3"` to `3`, `"1e2"` to `100`).
  Text that is not a number (`"abc"`, `"0x10"`, `"1,5"`) is passed through unchanged so validation
  reports it on the right field. A fractional value in an integer field is kept for the same reason.
- A blank optional field is omitted, never sent as `""` or `null`. A blank required scalar is also
  omitted, so Ajv reports `is required` on it; a user who needs an empty string for a required field
  uses the raw JSON editor.
- A field with a schema `default` that the user left alone is omitted: the server applies its own
  default, and the model only shows the default as a hint.
- An optional object with nothing typed anywhere in it is omitted, even if it has required
  children, so an untouched optional section does not send half an object. A required object is
  always sent.
- Blank scalar rows in an array are dropped. `null` is sent only for a `nullable` field.
- An `unsupported` field's state is JSON text. Empty is omitted, valid JSON is parsed, and invalid
  JSON is reported as a `json` error on that field and not sent.

### Validation

`validateArgs(schema, args, model?)` and `validateForm(model, schema, state)` use `Ajv2020`
imported from `ajv/dist/2020.js`, constructed with `{ allErrors: true, strict: false }`, plus
`ajv-formats`. Details that matter:

- Errors are read from `validate.errors[]`. `required` and `additionalProperties` report the parent
  in `instancePath` and the child in `params`, so the error is moved to the child's path.
- With a `model`, each error's `path` is the rendered field that owns it, found by `fieldAtPath`
  (array rows go through the item template). An error inside an `unsupported` JSON editor lands on
  that editor, and the exact location is kept in `instancePath`.
- Errors from inside a `oneOf` or `anyOf` branch are dropped and the combinator's own error is kept,
  because the user did not pick that branch.
- `$schema` is stripped before compiling. `Ajv2020` throws on a dialect it was not given, and tools
  in the wild still say draft-07. A fresh `Ajv2020` is built per schema so two tools declaring the
  same `$id` cannot collide, and compiled validators are cached per schema object in a `WeakMap`.
- A schema that cannot be compiled (unknown `$ref`, a nonexistent `type`) returns `valid: true`,
  no errors and a `schemaError` string. A schema we cannot read must not block a call.
- `ajv-formats` is CommonJS and its type declarations do not give a callable default under
  NodeNext, so the import accepts both `default` and the module itself.

### Why not the SDK's validator wrapper

It is the draft-07 `Ajv` (installed-code fact 1) and it throws the per-field information away
(fact 2). It can say "this payload is wrong" but not "this input is wrong", and the form exists to
do the second. The SDK keeps using its own wrapper internally, for example to check a tool's
`structuredContent` against `outputSchema` in `Client.callTool`; that is unaffected.

## Consequences

- Servers whose useful schemas are `oneOf`-heavy get a raw JSON field for those parts and a form for
  the rest. That is a deliberate trade: the subset is small, bounded and tested, instead of a
  renderer that is never finished.
- `additionalProperties` and `patternProperties` on an object that also has `properties` are not
  rendered, since the form only knows declared fields. Ajv still enforces them on validation, so a
  violation is reported (at the property, for `additionalProperties`).
- Ordering follows `Object.entries`, so property names that look like array indexes (`"1"`, `"2"`)
  are emitted first in numeric order. That is JavaScript object semantics, which this layer cannot
  see through.
- A required string cannot be sent as `""` from the form. This is the one place the form is less
  expressive than the schema; the raw JSON editor covers it. Raw mode calls `validateArgs` directly rather than `validateForm`, because the `path: ""` raw branch in `toArgs` only fires when the root schema itself was unsupported.
- Validation can pass while the server still rejects the call (rules the schema does not state),
  and can fail on a schema the server is lenient about. The server stays the final judge, which is
  why a `schemaError` does not block and the UI still offers the raw JSON editor. A truthy `schemaError` must render as a non-blocking banner above the form in Phase 5 task 5.9, since failing open is deliberate but nothing else requires the UI to surface it.
- Tests drive the real fixture tool list: every one of the 25 tools yields either a model or an
  explicit `unsupported` with a reason and a path that `fieldAtPath` resolves, `hostile_schema` is
  pinned to the three entries above, and a boundary test fails if anything in `src/schema/` imports
  React, the API layer, `src/mcp/` or a `node:` module.
