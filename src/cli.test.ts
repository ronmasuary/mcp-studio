import { describe, expect, it } from "vitest";
import { USAGE } from "./cli.js";

// A real, collected test. It keeps `npm test` honest: with zero test files vitest exits 1,
// and we deliberately do not pass --passWithNoTests, so a broken include glob fails loudly.
describe("cli", () => {
  it("exposes a usage string", () => {
    expect(USAGE).toContain("mcp-studio");
  });
});
