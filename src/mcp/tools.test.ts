import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect } from "./connect.js";
import { SessionRegistry } from "./registry.js";
import type { Session } from "./session.js";
import { listTools } from "./tools.js";
import { FIXTURE_PAGE_SIZE, FIXTURE_TOOLS, FIXTURE_TOOL_NAMES } from "./__fixtures__/echo-server.js";
import { fixtureServerConfig, reap } from "./__fixtures__/spawn.js";

const registry = new SessionRegistry();
let session: Session;
beforeAll(async () => {
  session = await connect("tools", fixtureServerConfig(), { registry });
});
afterAll(async () => {
  await registry.disconnectAll();
  reap(session?.pid);
});

describe("listTools", () => {
  it("fixture spans three pages, so a single-page implementation cannot pass", () => {
    expect(Math.ceil(FIXTURE_TOOL_NAMES.length / FIXTURE_PAGE_SIZE)).toBe(3);
  });

  it("collects every tool across all pages, in order", async () => {
    const tools = await listTools(session);
    expect(tools.map((t) => t.name)).toEqual([...FIXTURE_TOOL_NAMES]);
    expect(tools.length).toBeGreaterThan(2 * FIXTURE_PAGE_SIZE);
  });

  it("makes exactly one request per page", async () => {
    const calls: (string | undefined)[] = [];
    const original = session.client.listTools.bind(session.client);
    session.client.listTools = ((params?: { cursor?: string }, options?: never) => {
      calls.push(params?.cursor);
      return original(params, options);
    }) as typeof session.client.listTools;
    try {
      await listTools(session);
    } finally {
      session.client.listTools = original;
    }
    expect(calls).toHaveLength(3);
    expect(calls[0]).toBeUndefined();
    expect(calls[1]).toBeTruthy();
    expect(calls[2]).toBeTruthy();
    expect(calls[1]).not.toBe(calls[2]);
  });

  it("normalises to ToolDef and keeps schemas and annotations", async () => {
    const tools = await listTools(session);
    const add = tools.find((t) => t.name === "add")!;
    expect(add.description).toMatch(/Adds two numbers/);
    expect(add.inputSchema).toEqual(FIXTURE_TOOLS.find((t) => t.name === "add")!.inputSchema);
    expect(add.outputSchema).toBeDefined();
    expect(tools.find((t) => t.name === "delete_everything")?.annotations?.destructiveHint).toBe(true);
    // absent optional fields are absent, not undefined
    const echo = tools.find((t) => t.name === "echo")!;
    expect(Object.keys(echo).sort()).toEqual(["description", "inputSchema", "name"]);
  });

  it("stops at the hard page cap instead of looping", async () => {
    await expect(listTools(session, { maxPages: 2 })).rejects.toMatchObject({ kind: "pagination_runaway" });
  });
});
