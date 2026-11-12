import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// src/schema is reused by two later projects, so it stays pure: no React, no API layer, no I/O, and
// no import of src/mcp at all (the form model takes a plain JSON Schema, not a ToolDef).
const dir = dirname(fileURLToPath(import.meta.url));
const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

const importsOf = (file: string): string[] =>
  [...readFileSync(join(dir, file), "utf8").matchAll(/^\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1] ?? "");

describe("src/schema boundary", () => {
  it("finds the source files", () => {
    expect(sources).toEqual(expect.arrayContaining(["model.ts", "pointer.ts", "toArgs.ts", "toFormModel.ts", "validate.ts"]));
  });

  it.each(sources.map((f) => [f]))("%s imports only relative siblings, ajv and ajv-formats", (file) => {
    for (const spec of importsOf(file)) {
      const ok = /^\.\/[\w-]+\.js$/.test(spec) || spec === "ajv/dist/2020.js" || spec === "ajv-formats";
      expect(ok, `${file} imports ${spec}`).toBe(true);
    }
  });

  it.each(sources.map((f) => [f]))("%s does no I/O and has no side effects at import", (file) => {
    const text = readFileSync(join(dir, file), "utf8");
    expect(text).not.toMatch(/from\s+["']node:|\bprocess\.|\bconsole\.|\bfetch\(|\brequire\(/);
  });
});
