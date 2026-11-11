// How tests start the fixture server. Phase 2's real connect() reuses the same shape.
import { fileURLToPath } from "node:url";
import { getDefaultEnvironment, type StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import { isAlive, killTree } from "../process-tree.js";
import type { StdioServerConfig } from "../server-config.js";

/**
 * Resolved from import.meta.url against the SOURCE tree. Never from dist/: tsconfig.build.json
 * excludes __fixtures__ from emit, so a compiled path does not exist.
 */
export const fixtureUrl = new URL("./echo-server.ts", import.meta.url);
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * `node --import tsx <fixture>`. Vitest transpiles test files in-process but not a path handed to
 * child_process.spawn, and Node 20 cannot run .ts natively. cwd is the repo root so that the bare
 * `tsx` specifier resolves from this repo's node_modules wherever the test runner was started.
 * Node's loader ExperimentalWarning goes to stderr, which is not the protocol stream.
 */
export function fixtureServerParams(): StdioServerParameters {
  return {
    command: process.execPath,
    args: ["--import", "tsx", fileURLToPath(fixtureUrl)],
    cwd: repoRoot,
    // stdio env REPLACES the environment, so extend the defaults rather than passing a bare object.
    env: { ...getDefaultEnvironment() },
    stderr: "ignore",
  };
}

export { isAlive };

/** Last-resort cleanup for tests: kills the whole tree rooted at pid. Safe on a dead pid. */
export function reap(pid: number | null | undefined): void {
  killTree(pid);
}

/** The same child as fixtureServerParams(), expressed as a ServerConfig for connect(). */
export function fixtureServerConfig(): StdioServerConfig {
  const p = fixtureServerParams();
  return { transport: "stdio", command: p.command, args: p.args ?? [], ...(p.cwd ? { cwd: p.cwd } : {}) };
}

/** Polls until `predicate` is true or `timeoutMs` passes. For asserting on asynchronous process state. */
export async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}
