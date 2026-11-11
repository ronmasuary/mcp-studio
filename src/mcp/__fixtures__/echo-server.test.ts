import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  BIG_TEXT_LENGTH,
  FILLER_TOOL_COUNT,
  FIXTURE_PAGE_SIZE,
  FIXTURE_TOOL_NAMES,
  SLOW_TOOL_MS,
  TINY_PNG_BASE64,
  TINY_WAV_BASE64,
} from "./echo-server.js";
import { fixtureServerParams, isAlive, reap } from "./spawn.js";

// Real server, real stdio, no mocks. One spawned process is shared by the file.
const transport = new StdioClientTransport(fixtureServerParams());
const client = new Client({ name: "fixture-smoke-test", version: "0.0.0" });
let pid: number | null = null;
let allTools: Tool[] = [];
// Loosely typed view of a JSON Schema, for assertions only.
interface SchemaNode {
  type?: string;
  minimum?: number;
  maximum?: number;
  enum?: string[];
  oneOf?: unknown[];
  prefixItems?: unknown[];
  items?: SchemaNode;
  properties?: Record<string, SchemaNode>;
  required?: string[];
}

async function listAllPages(): Promise<{ tools: Tool[]; pages: number }> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const res = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...res.tools);
    cursor = res.nextCursor;
    pages++;
  } while (cursor);
  return { tools, pages };
}

beforeAll(async () => {
  await client.connect(transport); // spawns the child and runs initialize
  pid = transport.pid;
  allTools = (await listAllPages()).tools;
});

afterAll(async () => {
  await client.close();
  // win32: SIGTERM does not reach grandchildren and a hung child would stall CI, so verify
  // and fall back to taskkill /T /F.
  reap(pid);
  if (pid) expect(isAlive(pid)).toBe(false);
});

describe("echo fixture server", () => {
  it("is a real child process that completed initialize", () => {
    expect(pid).toBeGreaterThan(0);
    expect(pid).not.toBe(process.pid);
    expect(client.getServerVersion()?.name).toBe("mcp-studio-echo-fixture");
    expect(client.getServerCapabilities()?.tools).toBeDefined();
  });

  it("exposes exactly the expected tool set across pages", () => {
    expect(allTools.map((t) => t.name)).toEqual([...FIXTURE_TOOL_NAMES]);
    for (const name of [
      "echo", "add", "paint", "greet", "create_user", "tag_items", "always_fails", "slow",
      "big_text", "tiny_image", "all_content_kinds", "hostile_schema", "delete_everything",
    ]) {
      expect(FIXTURE_TOOL_NAMES).toContain(name);
    }
    expect(FIXTURE_TOOL_NAMES.filter((n) => n.startsWith("filler_"))).toHaveLength(FILLER_TOOL_COUNT);
  });

  it("crosses a tools/list page boundary", async () => {
    const first = await client.listTools();
    expect(first.tools).toHaveLength(FIXTURE_PAGE_SIZE);
    expect(first.nextCursor).toBeTruthy();
    const second = await client.listTools({ cursor: first.nextCursor! });
    expect(second.tools[0]?.name).toBe(FIXTURE_TOOL_NAMES[FIXTURE_PAGE_SIZE]);
    const { pages } = await listAllPages();
    expect(pages).toBe(Math.ceil(FIXTURE_TOOL_NAMES.length / FIXTURE_PAGE_SIZE));
    expect(pages).toBeGreaterThan(2);
  });

  it("rejects a malformed cursor", async () => {
    await expect(client.listTools({ cursor: "not-a-cursor" })).rejects.toThrow(/invalid cursor/);
  });

  it("echoes text", async () => {
    const res = await client.callTool({ name: "echo", arguments: { message: "hi", uppercase: true } });
    expect(res.isError).toBeFalsy();
    expect(res.content).toEqual([{ type: "text", text: "HI" }]);
  });

  it("returns structuredContent for add", async () => {
    const res = await client.callTool({ name: "add", arguments: { a: 2, b: 3, times: 2 } });
    expect(res.structuredContent).toEqual({ sum: 10 });
  });

  it("returns isError as a successful response, not a throw", async () => {
    const res = await client.callTool({ name: "always_fails", arguments: { reason: "test" } });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual([{ type: "text", text: "failed on purpose: test" }]);
  });

  it("sleeps about a second", async () => {
    const t0 = Date.now();
    const res = await client.callTool({ name: "slow", arguments: {} });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(SLOW_TOOL_MS - 50);
    expect(res.isError).toBeFalsy();
  });

  it("can cancel the slow tool mid-flight", async () => {
    const ac = new AbortController();
    const call = client.callTool({ name: "slow", arguments: {} }, undefined, { signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    await expect(call).rejects.toBeDefined();
    // the session is still usable afterwards
    const res = await client.callTool({ name: "echo", arguments: { message: "still alive" } });
    expect(res.content).toEqual([{ type: "text", text: "still alive" }]);
  });

  it("returns a large text blob", async () => {
    const res = await client.callTool({ name: "big_text", arguments: {} });
    const first = (res.content as { type: string; text: string }[])[0];
    expect(first?.text).toHaveLength(BIG_TEXT_LENGTH);
  });

  it("returns a base64 image", async () => {
    const res = await client.callTool({ name: "tiny_image", arguments: {} });
    expect(res.content).toContainEqual({ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" });
  });

  it("returns audio, an embedded resource and a resource link", async () => {
    const res = await client.callTool({ name: "all_content_kinds", arguments: {} });
    const content = res.content as { type: string }[];
    expect(content.map((c) => c.type)).toEqual(["audio", "resource", "resource_link"]);
    expect(content[0]).toEqual({ type: "audio", data: TINY_WAV_BASE64, mimeType: "audio/wav" });
    expect(content[1]).toEqual({
      type: "resource",
      resource: { uri: "fixture://notes/readme", mimeType: "text/plain", text: "embedded resource text" },
    });
    expect(content[2]).toMatchObject({ type: "resource_link", uri: "fixture://notes/linked", name: "linked-notes" });
  });

  it("carries the destructive annotation on exactly one tool", () => {
    const destructive = allTools.filter((t) => t.annotations?.destructiveHint === true);
    expect(destructive.map((t) => t.name)).toEqual(["delete_everything"]);
  });

  it("serves the hostile schema verbatim", () => {
    const schema = allTools.find((t) => t.name === "hostile_schema")?.inputSchema as SchemaNode;
    expect(schema.properties?.choice?.oneOf).toHaveLength(2);
    expect(schema.properties?.pair?.prefixItems).toHaveLength(2);
    let depth = 0;
    let node: SchemaNode | undefined = schema.properties?.deep;
    while (node?.properties) {
      depth++;
      node = Object.values(node.properties)[0];
    }
    expect(depth).toBe(6);
  });

  it("covers the flat schema shapes", () => {
    const byName = (n: string) => allTools.find((t) => t.name === n)!.inputSchema as SchemaNode;
    expect(byName("add").properties?.a).toMatchObject({ type: "number", minimum: -100, maximum: 100 });
    expect(byName("add").properties?.times?.type).toBe("integer");
    expect(byName("paint").properties?.colour?.enum).toEqual(["red", "green", "blue"]);
    expect(byName("greet").required).toEqual(["name"]);
    expect(byName("tag_items").properties?.items?.items?.type).toBe("object");
    expect(byName("create_user").properties?.user?.properties?.address?.type).toBe("object");
  });
});
