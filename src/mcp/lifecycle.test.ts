import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { connect, disconnect } from "./connect.js";
import { isAlive, killTree, trackedPids } from "./process-tree.js";
import { SessionRegistry } from "./registry.js";
import { fixtureServerConfig, reap, waitFor } from "./__fixtures__/spawn.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const dir = mkdtempSync(path.join(os.tmpdir(), "mcp-studio-lifecycle-"));
const registry = new SessionRegistry();
const leaked: number[] = [];
afterAll(async () => {
  await registry.disconnectAll();
  leaked.forEach(reap);
  rmSync(dir, { recursive: true, force: true });
});


describe("process tree kill", () => {
  it("killTree takes a parent AND its grandchild", async () => {
    // parent spawns a grandchild, prints its pid, then both idle
    const script = `const { spawn } = require("node:child_process");
      const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      console.log(g.pid); setInterval(() => {}, 1000);`;
    const parent = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
    leaked.push(parent.pid!);
    const grandchild = await new Promise<number>((resolve) =>
      parent.stdout.once("data", (d: Buffer) => resolve(Number(d.toString().trim()))),
    );
    leaked.push(grandchild);
    expect(isAlive(parent.pid!)).toBe(true);
    expect(isAlive(grandchild)).toBe(true);

    killTree(parent.pid);
    expect(await waitFor(() => !isAlive(parent.pid!) && !isAlive(grandchild))).toBe(true);
  });

  it("killTree is a no-op for a dead pid, null and our own pid", () => {
    expect(() => killTree(null)).not.toThrow();
    expect(() => killTree(2_147_000_000)).not.toThrow();
    killTree(process.pid);
    expect(isAlive(process.pid)).toBe(true);
  });
});

describe("disconnect", () => {
  it("a well-behaved server exits on disconnect and is no longer tracked", async () => {
    const session = await connect("polite", fixtureServerConfig(), { registry });
    expect(trackedPids()).toContain(session.pid);
    await disconnect("polite", { registry });
    expect(await waitFor(() => !isAlive(session.pid!))).toBe(true);
    expect(trackedPids()).not.toContain(session.pid);
    expect(session.closing).toBe(true);
    expect(registry.get("polite")?.lastError).toBeUndefined();
  });

  it("kills the whole tree of a launcher that ignores stdin closing (the npx case)", async () => {
    const pidFile = path.join(dir, "tree.json");
    const session = await connect(
      "launcher",
      {
        transport: "stdio",
        command: process.execPath,
        args: ["--import", "tsx", fileURLToPath(new URL("./__fixtures__/wrapper-server.ts", import.meta.url)), pidFile],
        cwd: repoRoot,
      },
      { registry },
    );
    // MCP really works through the launcher to the grandchild
    expect(session.client.getServerVersion()?.name).toBe("mcp-studio-echo-fixture");
    expect(await waitFor(() => existsSync(pidFile))).toBe(true);
    const pids = JSON.parse(readFileSync(pidFile, "utf8")) as { wrapper: number; server: number; sleeper: number };
    leaked.push(pids.wrapper, pids.server, pids.sleeper);
    expect(pids.wrapper).toBe(session.pid);
    expect([pids.wrapper, pids.server, pids.sleeper].every(isAlive)).toBe(true);

    await disconnect("launcher", { registry });
    expect(await waitFor(() => ![pids.wrapper, pids.server, pids.sleeper].some(isAlive))).toBe(true);
    expect(trackedPids()).not.toContain(pids.wrapper);
  });
});

describe("process exit hook", () => {
  it("reaps a launcher's whole tree when its owner exits without disconnecting", async () => {
    const probe = fileURLToPath(new URL("./__fixtures__/exit-probe.ts", import.meta.url));
    const pidFile = path.join(dir, "exit-tree.json");
    const out = execFileSync(process.execPath, ["--import", "tsx", probe, pidFile], { cwd: repoRoot, encoding: "utf8" });
    const pids = JSON.parse(out.trim().split(/\r?\n/).pop()!) as { wrapper: number; server: number; sleeper: number };
    const all = [pids.wrapper, pids.server, pids.sleeper];
    leaked.push(...all);
    expect(all.every((p) => p > 0)).toBe(true);
    expect(await waitFor(() => !all.some(isAlive))).toBe(true);
  });
});
