// The http transport against real HTTP servers. No protocol mocking: the Streamable HTTP server
// is the SDK's own server transport serving the fixture's tools.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callTool } from "./call.js";
import { cancelCall, newCallId } from "./cancel.js";
import { connect } from "./connect.js";
import { SessionRegistry } from "./registry.js";
import { listTools } from "./tools.js";
import { FIXTURE_TOOL_NAMES } from "./__fixtures__/echo-server.js";
import {
  startSseOnlyFixture,
  startStreamableHttpFixture,
  type HttpFixture,
} from "./__fixtures__/http-server.js";

const registry = new SessionRegistry();
let streamable: HttpFixture;
let legacy: HttpFixture;
beforeAll(async () => {
  streamable = await startStreamableHttpFixture();
  legacy = await startSseOnlyFixture();
});
afterAll(async () => {
  await registry.disconnectAll();
  await streamable.close();
  await legacy.close();
});

describe("http transport", () => {
  it("connects, sends headers via requestInit, lists three pages, calls and disconnects", async () => {
    const session = await connect(
      "http-ok",
      {
        transport: "http",
        url: streamable.url,
        headers: { "X-Literal": "typed-in-modal", Authorization: { fromEnv: "MCP_STUDIO_TEST_TOKEN" } },
      },
      { registry, env: { MCP_STUDIO_TEST_TOKEN: "Bearer from-env" } },
    );
    expect(session.kind).toBe("http");
    expect(session.pid).toBeNull();
    expect(registry.get("http-ok")?.status).toBe("connected");

    // headers reached the server on the initialize POST and on later requests
    const withHeaders = streamable.seenHeaders.filter((h) => h["x-literal"] === "typed-in-modal");
    expect(withHeaders.length).toBeGreaterThan(0);
    expect(withHeaders.every((h) => h.authorization === "Bearer from-env")).toBe(true);

    const tools = await listTools(session);
    expect(tools.map((t) => t.name)).toEqual([...FIXTURE_TOOL_NAMES]);

    const res = await callTool(session, "echo", { message: "over http" }, { callId: newCallId() });
    expect(res.content).toEqual([{ type: "text", text: "over http" }]);
    const failing = await callTool(session, "always_fails", {}, { callId: newCallId() });
    expect(failing.isError).toBe(true);

    await registry.disconnect("http-ok");
    expect(registry.get("http-ok")?.status).toBe("disconnected");
  });

  it("cancels the slow tool over http", async () => {
    const own = new SessionRegistry();
    const session = await connect("http-cancel", { transport: "http", url: streamable.url }, { registry: own });
    const callId = newCallId();
    const pending = callTool(session, "slow", {}, { callId });
    pending.catch(() => undefined);
    setTimeout(() => cancelCall(callId), 100);
    await expect(pending).rejects.toMatchObject({ kind: "cancelled" });
    await own.disconnectAll();
  });

  it("an unreachable server fails initialize with a named kind", async () => {
    const err = await connect("http-down", { transport: "http", url: "http://127.0.0.1:1/mcp" }, { registry }).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ kind: "initialize_failed" });
    expect(registry.get("http-down")?.status).toBe("failed");
  });

  it("an SSE-only server fails with a named error, not a crash and not a silent fallback", async () => {
    const err = await connect("http-sse", { transport: "http", url: legacy.url }, { registry }).catch(
      (e: unknown) => e as Error,
    );
    expect(err).toMatchObject({ kind: "sse_only_unsupported" });
    expect((err as Error).message).toMatch(/2024-11-05/);
    expect(registry.get("http-sse")).toMatchObject({ status: "failed", lastError: { kind: "sse_only_unsupported" } });
    // the client never went on to use the legacy endpoint the stream announced
    expect(legacy.seenHeaders.length).toBeLessThan(10);
  });
});
