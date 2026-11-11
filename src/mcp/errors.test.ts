// One real trigger per ErrorKind, so each case is provably distinguishable from the others.
import { afterAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { callTool } from "./call.js";
import { cancelCall, newCallId } from "./cancel.js";
import { connect } from "./connect.js";
import { toolErrorKind, type ErrorKind } from "./errors.js";
import { trackedPids } from "./process-tree.js";
import { SessionRegistry } from "./registry.js";
import type { ServerConfig } from "./server-config.js";
import { listTools } from "./tools.js";
import { fixtureServerConfig, isAlive, reap, waitFor } from "./__fixtures__/spawn.js";
import { BIG_TEXT_LENGTH } from "./__fixtures__/echo-server.js";

const registry = new SessionRegistry();
const pids: number[] = [];
afterAll(async () => {
  await registry.disconnectAll();
  pids.forEach(reap);
});

const kindOf = async (p: Promise<unknown>): Promise<ErrorKind | "resolved"> => {
  try {
    await p;
    return "resolved";
  } catch (err) {
    return (err as { kind: ErrorKind }).kind;
  }
};
const idle = ["-e", "setInterval(() => {}, 1000)"];

describe("error taxonomy against real processes", () => {
  it("spawn_failed: the command does not exist", async () => {
    expect(await kindOf(connect("e1", { transport: "stdio", command: "no-such-binary-xyz" }, { registry }))).toBe("spawn_failed");
  });

  it("spawn_failed: the working directory does not exist", async () => {
    const cfg: ServerConfig = { transport: "stdio", command: process.execPath, args: idle, cwd: path.join(os.tmpdir(), "mcp-studio-no-such-dir") };
    expect(await kindOf(connect("e1b", cfg, { registry }))).toBe("spawn_failed");
  });

  it("initialize_failed: the process starts but never speaks MCP, and its stderr is attached", async () => {
    const cfg: ServerConfig = {
      transport: "stdio",
      command: process.execPath,
      args: ["-e", "console.error('boom from child'); process.exit(3)"],
    };
    const err = await connect("e2", cfg, { registry }).catch((e: unknown) => e as Error & { kind: ErrorKind });
    expect((err as { kind: ErrorKind }).kind).toBe("initialize_failed");
    expect((err as Error).message).toContain("boom from child");
  });

  it("initialize_failed: a hung handshake times out and the child is killed, not leaked", async () => {
    const before = new Set(trackedPids());
    const cfg: ServerConfig = { transport: "stdio", command: process.execPath, args: idle };
    const t0 = Date.now();
    const err = await connect("e3", cfg, { registry, connectTimeoutMs: 400 }).catch((e: unknown) => e as Error & { kind: ErrorKind });
    expect((err as { kind: ErrorKind }).kind).toBe("initialize_failed");
    expect((err as Error).message).toMatch(/timed out after 400ms/);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(trackedPids().filter((p) => !before.has(p))).toEqual([]);
    expect(registry.get("e3")?.status).toBe("failed");
  });

  it("config_invalid: a fromEnv reference to an unset variable names the variable, not a value", async () => {
    const cfg: ServerConfig = { transport: "stdio", command: process.execPath, args: idle, env: { K: { fromEnv: "MCP_STUDIO_SURELY_UNSET" } } };
    const err = await connect("e4", cfg, { registry, env: {} }).catch((e: unknown) => e as Error & { kind: ErrorKind });
    expect((err as { kind: ErrorKind }).kind).toBe("config_invalid");
    expect((err as Error).message).toContain("MCP_STUDIO_SURELY_UNSET");
  });

  it("config_invalid: a malformed config", async () => {
    expect(await kindOf(connect("e5", { transport: "stdio", command: "" }, { registry }))).toBe("config_invalid");
  });

  it("timeout, cancelled, tool_error and protocol_error are four different outcomes", async () => {
    const session = await connect("live", fixtureServerConfig(), { registry });
    pids.push(session.pid!);
    const call = (name: string, extra: { timeout?: number } = {}) =>
      callTool(session, name, {}, { callId: newCallId(), ...extra });

    expect(await kindOf(call("slow", { timeout: 150 }))).toBe("timeout");

    // (the cancel path is covered in depth by cancel.test.ts; here only the kind)
    const callId = newCallId();
    const pending = callTool(session, "slow", {}, { callId });
    pending.catch(() => undefined);
    cancelCall(callId);
    expect(await kindOf(pending)).toBe("cancelled");

    const toolErr = await call("always_fails");
    expect(toolErr).toMatchObject({ isError: true });
    expect(toolErrorKind(toolErr)).toBe("tool_error");
    expect(toolErrorKind(await call("tiny_image"))).toBeUndefined();

    expect(await kindOf(call("no_such_tool"))).toBe("protocol_error");
    await registry.disconnect("live");
  });

  it("transport_dropped: the server dies mid-call", async () => {
    const session = await connect("dying", fixtureServerConfig(), { registry });
    pids.push(session.pid!);
    const pending = callTool(session, "slow", {}, { callId: newCallId() });
    setTimeout(() => reap(session.pid), 100);
    expect(await kindOf(pending)).toBe("transport_dropped");
    expect(await waitFor(() => registry.get("dying")?.status === "disconnected")).toBe(true);
    expect(registry.get("dying")?.lastError?.kind).toBe("transport_dropped");
    // and afterwards the dead session is not_connected, not a hang
    expect(await kindOf(callTool(session, "echo", { message: "x" }, { callId: newCallId() }))).toBe("not_connected");
    expect(await kindOf(listTools(session))).toBe("not_connected");
  });

  it("not_connected: a registry lookup for a server that is not live", () => {
    expect(() => registry.requireSession("never-registered")).toThrowError(/not registered/);
    try {
      registry.requireSession("dying");
    } catch (err) {
      expect((err as { kind: ErrorKind }).kind).toBe("not_connected");
    }
  });
});

describe("response size cap", () => {
  it("response_too_large: a message over maxResponseBytes closes the connection and says why", async () => {
    const session = await connect("capped", fixtureServerConfig(), { registry, maxResponseBytes: 50_000 });
    pids.push(session.pid!);
    // under the cap everything works
    expect(await callTool(session, "tiny_image", {}, { callId: newCallId() })).toMatchObject({ isError: false });
    expect(BIG_TEXT_LENGTH).toBeGreaterThan(50_000);

    const err = await callTool(session, "big_text", {}, { callId: newCallId() }).catch((e: unknown) => e as Error & { kind: ErrorKind });
    expect((err as { kind: ErrorKind }).kind).toBe("response_too_large");
    expect((err as Error).message).toMatch(/50000 byte cap/);
    expect(await waitFor(() => registry.get("capped")?.status === "disconnected")).toBe(true);
    expect(registry.get("capped")?.lastError?.kind).toBe("response_too_large");
    expect(await waitFor(() => !isAlive(session.pid!))).toBe(true);
  });

  it("the same call succeeds with the default cap", async () => {
    const session = await connect("uncapped", fixtureServerConfig(), { registry });
    pids.push(session.pid!);
    const res = await callTool(session, "big_text", {}, { callId: newCallId() });
    expect(res.isError).toBe(false);
    await registry.disconnect("uncapped");
  });
});
