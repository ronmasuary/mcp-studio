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
