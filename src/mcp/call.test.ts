import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CALL_TIMEOUT_MS, callTool } from "./call.js";
import { connect } from "./connect.js";
import { SessionRegistry } from "./registry.js";
import type { Session } from "./session.js";
import { SLOW_TOOL_MS } from "./__fixtures__/echo-server.js";
import { fixtureServerConfig, reap } from "./__fixtures__/spawn.js";

const registry = new SessionRegistry();
let session: Session;
const id = () => ({ callId: randomUUID() });

beforeAll(async () => {
  session = await connect("call", fixtureServerConfig(), { registry });
});
afterAll(async () => {
  await registry.disconnectAll();
  reap(session?.pid);
});

describe("callTool", () => {
  it("returns content, isError and a measured duration, and no ok field", async () => {
    const res = await callTool(session, "echo", { message: "hi", uppercase: true }, id());
    expect(res.content).toEqual([{ type: "text", text: "HI" }]);
    expect(res.isError).toBe(false);
    expect(res.ms).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(res.ms)).toBe(true);
    expect(res).not.toHaveProperty("ok");
    expect(res).not.toHaveProperty("structuredContent");
  });

  it("returns structuredContent when the tool provides it", async () => {
    const res = await callTool(session, "add", { a: 2, b: 3, times: 2 }, id());
    expect(res.structuredContent).toEqual({ sum: 10 });
  });

  it("returns isError: true as a successful result, not a rejection", async () => {
    const res = await callTool(session, "always_fails", { reason: "because" }, id());
    expect(res.isError).toBe(true);
    expect(res.content).toEqual([{ type: "text", text: "failed on purpose: because" }]);
  });

  it("measures ms itself, so a slow tool reports about its sleep", async () => {
    const res = await callTool(session, "slow", {}, id());
    expect(res.ms).toBeGreaterThanOrEqual(SLOW_TOOL_MS - 50);
    expect(res.ms).toBeLessThan(SLOW_TOOL_MS * 5);
  });

  it("applies an explicit timeout and the session survives it", async () => {
    const t0 = Date.now();
    await expect(callTool(session, "slow", {}, { ...id(), timeout: 200 })).rejects.toMatchObject({ kind: "timeout" });
    expect(Date.now() - t0).toBeLessThan(SLOW_TOOL_MS);
    const after = await callTool(session, "echo", { message: "still alive" }, id());
    expect(after.isError).toBe(false);
  });

  it("defaults to a 30s timeout, not the SDK's 60s", () => {
    expect(DEFAULT_CALL_TIMEOUT_MS).toBe(30_000);
  });
});
