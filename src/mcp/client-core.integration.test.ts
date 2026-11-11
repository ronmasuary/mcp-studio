// The Phase 2 gate: connect, list across every page, call, cancel and disconnect a real stdio
// server through the public API alone, with no UI and no mocks.
import { afterAll, describe, expect, it } from "vitest";
import { callTool } from "./call.js";
import { cancelCall, newCallId } from "./cancel.js";
import { connect, disconnect } from "./connect.js";
import { normaliseContent } from "./content.js";
import { SessionRegistry } from "./registry.js";
import { listTools } from "./tools.js";
import { FIXTURE_PAGE_SIZE, FIXTURE_TOOL_NAMES, SLOW_TOOL_MS, TINY_PNG_BASE64 } from "./__fixtures__/echo-server.js";
import { fixtureServerConfig, isAlive, reap, waitFor } from "./__fixtures__/spawn.js";

const registry = new SessionRegistry();
const pids: number[] = [];
afterAll(async () => {
  await registry.disconnectAll();
  pids.forEach(reap);
});

describe("client core gate", () => {
  it("connect, list (paginated), call, cancel, disconnect", async () => {
    const session = await connect("gate", fixtureServerConfig(), { registry });
    pids.push(session.pid!);
    expect(registry.get("gate")?.status).toBe("connected");

    const tools = await listTools(session);
    expect(tools).toHaveLength(FIXTURE_TOOL_NAMES.length);
    expect(Math.ceil(tools.length / FIXTURE_PAGE_SIZE)).toBe(3);

    const echo = await callTool(session, "echo", { message: "gate" }, { callId: newCallId() });
    expect(echo).toMatchObject({ isError: false, content: [{ type: "text", text: "gate" }] });

    const callId = newCallId();
    const t0 = Date.now();
    const slow = callTool(session, "slow", {}, { callId });
    slow.catch(() => undefined);
    setTimeout(() => cancelCall(callId), 100);
    await expect(slow).rejects.toMatchObject({ kind: "cancelled" });
    expect(Date.now() - t0).toBeLessThan(SLOW_TOOL_MS);

    await disconnect("gate", { registry });
    expect(registry.get("gate")?.status).toBe("disconnected");
    expect(await waitFor(() => !isAlive(session.pid!))).toBe(true);
  });

  it("runs the slow tool to completion when it is not cancelled", async () => {
    const session = await connect("slow", fixtureServerConfig(), { registry });
    pids.push(session.pid!);
    const res = await callTool(session, "slow", {}, { callId: newCallId() });
    expect(res.content).toEqual([{ type: "text", text: "done sleeping" }]);
    expect(res.ms).toBeGreaterThanOrEqual(SLOW_TOOL_MS - 50);
    await disconnect("slow", { registry });
  });

  it("reads an image and every content kind through normaliseContent", async () => {
    const session = await connect("content", fixtureServerConfig(), { registry });
    pids.push(session.pid!);
    const image = await callTool(session, "tiny_image", {}, { callId: newCallId() });
    expect(normaliseContent(image.content).map((b) => b.kind)).toEqual(["text", "image"]);
    expect(normaliseContent(image.content)[1]).toMatchObject({ kind: "image", data: TINY_PNG_BASE64 });
    const all = await callTool(session, "all_content_kinds", {}, { callId: newCallId() });
    expect(all.content.map((c) => c.type)).toEqual(["audio", "resource", "resource_link"]);
    expect(normaliseContent(all.content).map((b) => b.kind)).toEqual(["audio", "resource", "resource_link"]);
    await disconnect("content", { registry });
  });

  it("passes structuredContent through", async () => {
    const session = await connect("structured", fixtureServerConfig(), { registry });
    pids.push(session.pid!);
    const user = { name: "Ada", address: { city: "London" } };
    const res = await callTool(session, "create_user", { user }, { callId: newCallId() });
    expect(res.structuredContent).toEqual({ created: user });
    await disconnect("structured", { registry });
  });
});

describe("stdio environment", () => {
  // A child that is not an MCP server fails initialize, and its stderr is attached to the error,
  // which makes the environment it actually received observable without mocking anything.
  const probe = [
    'console.error("ENV " + JSON.stringify({',
    "  path: Boolean(process.env.PATH || process.env.Path),",
    '  systemRoot: process.platform === "win32" ? Boolean(process.env.SystemRoot) : true,',
    "  literal: process.env.MCP_STUDIO_LITERAL,",
    "  ref: process.env.MCP_STUDIO_REF,",
    "})); process.exit(1);",
  ].join("\n");

  it("extends the default environment instead of replacing it, and resolves fromEnv", async () => {
    const err = await connect(
      "env",
      {
        transport: "stdio",
        command: process.execPath,
        args: ["-e", probe],
        env: { MCP_STUDIO_LITERAL: "typed", MCP_STUDIO_REF: { fromEnv: "MCP_STUDIO_HOST_VAR" } },
      },
      { registry, env: { MCP_STUDIO_HOST_VAR: "from-host" } },
    ).catch((e: unknown) => e as Error);
    const line = (err as Error).message.split("\n").find((l) => l.startsWith("ENV "));
    expect(line).toBeDefined();
    expect(JSON.parse(line!.slice(4))).toEqual({ path: true, systemRoot: true, literal: "typed", ref: "from-host" });
  });
});
