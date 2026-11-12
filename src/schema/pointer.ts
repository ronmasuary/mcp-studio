// JSON Pointer helpers (RFC 6901). Field paths use the same format as Ajv's `instancePath`, so an
// error maps to its field by plain string equality.
import type { FormField, FormModel } from "./model.js";

export function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function unescapePointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** `joinPointer("/a", "b/c")` is `/a/b~1c`. The root pointer is the empty string. */
export function joinPointer(parent: string, segment: string | number): string {
  return `${parent}/${escapePointerSegment(String(segment))}`;
}

/** The subset of a field that `rebasePath` needs to walk. */
interface PathNode {
  path: string;
  fields?: PathNode[];
  item?: PathNode;
}

/**
 * Copy of `field` with every path that starts with `from` moved under `to`. The UI uses it to turn
 * an array's item template (addressed at index 0) into the row at index N, so per-field errors
 * from Ajv's `instancePath` line up with the rendered inputs.
 */
export function rebasePath<T extends PathNode>(field: T, from: string, to: string): T {
  const move = (p: string): string =>
    p === from || p.startsWith(`${from}/`) ? `${to}${p.slice(from.length)}` : p;
  const copy = { ...field, path: move(field.path) };
  if (field.fields) copy.fields = field.fields.map((f) => rebasePath(f, from, to));
  if (field.item) copy.item = rebasePath(field.item, from, to);
  return copy;
}

/** The field that owns an instance path, plus the real (indexed) path of that field. */
export interface FieldAtPath {
  field: FormField;
  /** `field.path` with array item templates replaced by the indexes in the instance path. */
  path: string;
}

/**
 * Finds the form field responsible for an instance path such as `/items/2/id`, walking array rows
 * through their item template. When the path goes deeper than the model does, the nearest enclosing
 * field wins: an error at `/filters/0/id` inside an `unsupported` raw JSON field belongs to that
 * field. Returns undefined only for the root, or a path that leaves the model at the top level.
 */
export function fieldAtPath(model: FormModel, path: string): FieldAtPath | undefined {
  const segments = path === "" ? [] : path.slice(1).split("/").map(unescapePointerSegment);
  const only = model.fields.length === 1 ? model.fields[0] : undefined;
  if (only && only.kind === "unsupported" && only.path === "") return { field: only, path: "" };

  let node: FormField | undefined;
  let real = "";
  for (const seg of segments) {
    if (node === undefined || node.kind === "object") {
      const next: FormField | undefined = (node ? node.fields : model.fields).find((f) => f.name === seg);
      if (!next) return node ? { field: node, path: real } : undefined;
      node = next;
    } else if (node.kind === "array" && /^\d+$/.test(seg)) {
      node = node.item;
    } else {
      return { field: node, path: real };
    }
    real = joinPointer(real, seg);
  }
  return node ? { field: node, path: real } : undefined;
}
