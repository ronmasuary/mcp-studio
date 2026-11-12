// JSON Pointer helpers (RFC 6901). Field paths use the same format as Ajv's `instancePath`, so an
// error maps to its field by plain string equality.

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
