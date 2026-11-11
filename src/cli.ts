#!/usr/bin/env node
// Placeholder entry point. `mcp-studio serve` arrives in Phase 4.

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const USAGE = "mcp-studio: groundwork only, nothing to run yet.\n";

export function main(): void {
  process.stdout.write(USAGE);
}

// Run only as the entry point, so importing this module has no side effects. realpath because
// npm installs the bin as a symlink on unix, where argv[1] is the link and import.meta.url is not.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  main();
}
