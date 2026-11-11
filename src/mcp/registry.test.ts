import { afterAll, describe, expect, it } from "vitest";
import { connect } from "./connect.js";
import { SessionRegistry } from "./registry.js";
import { fixtureServerConfig, isAlive, reap, waitFor } from "./__fixtures__/spawn.js";

const registry = new SessionRegistry();
const pids: number[] = [];
afterAll(async () => {
  await registry.disconnectAll();
  pids.forEach(reap);
});

describe("SessionRegistry", () => {
  it("define records a disconnected entry", () => {
    registry.define("defined", fixtureServerConfig());
    expect(registry.get("defined")?.status).toBe("disconnected");
    expect(registry.requireSession.bind(registry, "defined")).toThrow(/disconnected/);
  });

  it("walks connecting, connected, disconnected against a real server", async () => {
    const pending = connect("walk", fixtureServerConfig(), { registry });
    expect(registry.get("walk")?.status).toBe("connecting");
    const session = await pending;
    pids.push(session.pid!);
    expect(registry.get("walk")?.status).toBe("connected");
    expect(registry.requireSession("walk")).toBe(session);
    expect(session.serverId).toBe("walk");
    expect(isAlive(session.pid!)).toBe(true);

    await registry.disconnect("walk");
    expect(registry.get("walk")?.status).toBe("disconnected");
    expect(registry.get("walk")?.session).toBeUndefined();
    expect(registry.get("walk")?.lastError).toBeUndefined();
    expect(await waitFor(() => !isAlive(session.pid!))).toBe(true);
  });

  it("refuses a second connect for a live serverId", async () => {
    const session = await connect("dup", fixtureServerConfig(), { registry });
    pids.push(session.pid!);
    await expect(connect("dup", fixtureServerConfig(), { registry })).rejects.toMatchObject({ kind: "already_connected" });
    // the refusal must not have disturbed the live session
    expect(registry.get("dup")?.status).toBe("connected");
    await registry.disconnect("dup");
  });

  it("reaches failed with lastError, and a failed server can be retried", async () => {
    const bad = { transport: "stdio", command: "definitely-not-a-command-xyz" } as const;
    await expect(connect("failing", bad, { registry })).rejects.toMatchObject({ kind: "spawn_failed" });
    expect(registry.get("failing")?.status).toBe("failed");
    expect(registry.get("failing")?.lastError?.kind).toBe("spawn_failed");
    const session = await connect("failing", fixtureServerConfig(), { registry });
    pids.push(session.pid!);
    expect(registry.get("failing")?.status).toBe("connected");
    expect(registry.get("failing")?.lastError).toBeUndefined();
    await registry.disconnect("failing");
  });

  it("marks an unexpectedly dead child as disconnected with a transport_dropped error", async () => {
    const session = await connect("dropped", fixtureServerConfig(), { registry });
    pids.push(session.pid!);
    reap(session.pid);
    expect(await waitFor(() => registry.get("dropped")?.status === "disconnected")).toBe(true);
    expect(registry.get("dropped")?.lastError?.kind).toBe("transport_dropped");
    expect(() => registry.requireSession("dropped")).toThrow(/disconnected/);
  });

  it("remove disconnects and forgets", async () => {
    const session = await connect("gone", fixtureServerConfig(), { registry });
    pids.push(session.pid!);
    await registry.remove("gone");
    expect(registry.has("gone")).toBe(false);
    expect(await waitFor(() => !isAlive(session.pid!))).toBe(true);
  });

  it("list reports every definition with its status", () => {
    const byId = Object.fromEntries(registry.list().map((e) => [e.serverId, e.entry.status]));
    expect(byId).toMatchObject({ defined: "disconnected", walk: "disconnected", failing: "disconnected", dropped: "disconnected" });
  });
});
