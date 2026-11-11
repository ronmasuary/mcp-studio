// A REAL stdio MCP server, used as the test target for every later phase. The MCP protocol is
// never mocked in this repo; tests spawn this file and talk to it over stdio.
//
// It uses the low-level `Server` rather than `McpServer` on purpose: `McpServer` does not
// paginate `tools/list`, and it validates schemas through zod, which cannot express the hostile
// JSON Schema (oneOf, prefixItems) that Phase 3 needs. Here every tool carries a raw JSON
// Schema object, verbatim.
//
// Never write to stdout from this file: stdout is the protocol stream.

import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

/** tools/list returns this many tools per page. The SDK has no default; the fixture chooses it. */
export const FIXTURE_PAGE_SIZE = 10;
/** Padding tools so the full list spans several pages. */
export const FILLER_TOOL_COUNT = 12;
export const SLOW_TOOL_MS = 1000;
export const BIG_TEXT_LENGTH = 200_000;
/** 1x1 transparent PNG. */
export const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

type Handler = (args: Record<string, unknown>, signal: AbortSignal) => Promise<CallToolResult>;
interface FixtureTool {
  def: Tool;
  handler: Handler;
}

const text = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }] });

const tools: FixtureTool[] = [
  {
    // flat string, required + optional boolean
    def: {
      name: "echo",
      description: "Returns the message it was given.",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string", description: "Text to echo back" },
          uppercase: { type: "boolean", description: "Shout it", default: false },
        },
        required: ["message"],
      },
    },
    handler: async (a) => text(a.uppercase === true ? String(a.message).toUpperCase() : String(a.message)),
  },
];

/** Full tool definitions in list order. Tests and Phase 3 read this instead of re-typing names. */
export const FIXTURE_TOOLS: readonly Tool[] = tools.map((t) => t.def);
export const FIXTURE_TOOL_NAMES: readonly string[] = FIXTURE_TOOLS.map((t) => t.name);

export function createFixtureServer(): Server {
  const server = new Server(
    { name: "mcp-studio-echo-fixture", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );

  // Cursor is an opaque string to clients; here it is the base64url offset.
  server.setRequestHandler(ListToolsRequestSchema, async (req) => {
    const cursor = req.params?.cursor;
    let start = 0;
    if (cursor !== undefined) {
      start = Number(Buffer.from(cursor, "base64url").toString("utf8"));
      if (!Number.isInteger(start) || start < 0 || start > FIXTURE_TOOLS.length) {
        throw new Error(`invalid cursor: ${cursor}`);
      }
    }
    const end = start + FIXTURE_PAGE_SIZE;
    const page = FIXTURE_TOOLS.slice(start, end);
    return end < FIXTURE_TOOLS.length
      ? { tools: [...page], nextCursor: Buffer.from(String(end), "utf8").toString("base64url") }
      : { tools: [...page] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const tool = tools.find((t) => t.def.name === req.params.name);
    if (!tool) throw new Error(`unknown tool: ${req.params.name}`);
    return tool.handler(req.params.arguments ?? {}, extra.signal);
  });

  return server;
}

async function main(): Promise<void> {
  await createFixtureServer().connect(new StdioServerTransport());
}

// Only start when run as a process, so tests can import the constants without side effects.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
