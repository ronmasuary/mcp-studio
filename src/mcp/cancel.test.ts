import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callTool } from "./call.js";
import { CallRegistry, cancelCall, defaultCalls, newCallId } from "./cancel.js";
import { connect } from "./connect.js";
import { SessionRegistry } from "./registry.js";
import type { Session } from "./session.js";
import { SLOW_TOOL_MS } from "./__fixtures__/echo-server.js";
import { fixtureServerConfig, reap } from "./__fixtures__/spawn.js";

const registry = new SessionRegistry();
let session: Session;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  session = await connect("cancel", fixtureServerConfig(), { registry });
});
afterAll(async () => {
  await registry.disconnectAll();
  reap(session?.pid);
});

describe("call cancellation", () => {
  it("newCallId mints distinct UUIDs", () => {
    const [a, b] = [newCallId(), newCallId()];
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });

  it("cancels the slow tool mid-flight by callId, well before it would finish", async () => {
    const callId = newCallId();
    const t0 = Date.now();
    const pending = callTool(session, "slow", {}, { callId });
    pending.catch(() => undefined);
    await sleep(100);
    expect(defaultCalls.has(callId)).toBe(true);
    expect(cancelCall(callId)).toBe(true);
    await expect(pending).rejects.toMatchObject({ kind: "cancelled" });
    expect(Date.now() - t0).toBeLessThan(SLOW_TOOL_MS - 200);
    expect(defaultCalls.has(callId)).toBe(false);
  });

  it("is registered before the request is issued: a same-tick cancel still lands", async () => {
    const callId = newCallId();
    const pending = callTool(session, "slow", {}, { callId });
    pending.catch(() => undefined);
    expect(cancelCall(callId)).toBe(true);
    await expect(pending).rejects.toMatchObject({ kind: "cancelled" });
  });

  it("leaves the session usable and other calls untouched", async () => {
    const keep = callTool(session, "slow", {}, { callId: newCallId() });
    const doomedId = newCallId();
    const doomed = callTool(session, "slow", {}, { callId: doomedId });
    doomed.catch(() => undefined);
    await sleep(100);
    cancelCall(doomedId);
    await expect(doomed).rejects.toMatchObject({ kind: "cancelled" });
    await expect(keep).resolves.toMatchObject({ isError: false });
    const after = await callTool(session, "echo", { message: "alive" }, { callId: newCallId() });
    expect(after.content).toEqual([{ type: "text", text: "alive" }]);
  });

  it("returns false for an unknown or already finished callId", async () => {
    expect(cancelCall("no-such-call")).toBe(false);
    const callId = newCallId();
    await callTool(session, "echo", { message: "x" }, { callId });
    expect(cancelCall(callId)).toBe(false);
  });

  it("refuses a callId that is already in flight, without disturbing the first call", async () => {
    const callId = newCallId();
    const first = callTool(session, "slow", {}, { callId });
    await expect(callTool(session, "echo", { message: "x" }, { callId })).rejects.toMatchObject({ kind: "duplicate_call" });
    await expect(first).resolves.toMatchObject({ isError: false });
  });

  it("honours an external AbortSignal, including one that is already aborted", async () => {
    const ac = new AbortController();
    const pending = callTool(session, "slow", {}, { callId: newCallId(), signal: ac.signal });
    pending.catch(() => undefined);
    setTimeout(() => ac.abort(), 100);
    await expect(pending).rejects.toMatchObject({ kind: "cancelled" });

    const done = AbortSignal.abort();
    await expect(callTool(session, "slow", {}, { callId: newCallId(), signal: done })).rejects.toMatchObject({
      kind: "cancelled",
    });
  });

  it("an injected registry keeps tests isolated from the default one", async () => {
    const calls = new CallRegistry();
    const callId = newCallId();
    const pending = callTool(session, "slow", {}, { callId, calls });
    pending.catch(() => undefined);
    expect(calls.size).toBe(1);
    expect(defaultCalls.has(callId)).toBe(false);
    calls.cancel(callId);
    await expect(pending).rejects.toMatchObject({ kind: "cancelled" });
    expect(calls.size).toBe(0);
  });
});
