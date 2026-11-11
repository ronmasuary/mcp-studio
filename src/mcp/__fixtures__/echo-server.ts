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

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("cancelled"));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("cancelled"));
      },
      { once: true },
    );
  });
}

// Deeply nested object, built programmatically so the depth is explicit.
function nestedSchema(depth: number): Record<string, unknown> {
  let inner: Record<string, unknown> = { type: "string", description: "Leaf value" };
  for (let i = depth; i >= 1; i--) {
    inner = { type: "object", properties: { [`level${i}`]: inner }, required: [`level${i}`] };
  }
  return inner;
}

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
  {
    // numbers with min/max, integer vs number
    def: {
      name: "add",
      description: "Adds two numbers. Both are bounded, and the count must be an integer.",
      inputSchema: {
        type: "object",
        properties: {
          a: { type: "number", minimum: -100, maximum: 100, description: "First addend" },
          b: { type: "number", minimum: -100, maximum: 100, description: "Second addend" },
          times: { type: "integer", minimum: 1, maximum: 5, default: 1, description: "Repeat count" },
        },
        required: ["a", "b"],
      },
      outputSchema: {
        type: "object",
        properties: { sum: { type: "number" } },
        required: ["sum"],
      },
    },
    handler: async (a) => {
      const sum = (Number(a.a) + Number(a.b)) * Number(a.times ?? 1);
      return { content: [{ type: "text", text: String(sum) }], structuredContent: { sum } };
    },
  },
  {
    // enum, required
    def: {
      name: "paint",
      description: "Picks a colour from a fixed set.",
      inputSchema: {
        type: "object",
        properties: {
          colour: { type: "string", enum: ["red", "green", "blue"], description: "Colour name" },
          finish: { type: "string", enum: ["matte", "gloss"], default: "matte" },
        },
        required: ["colour"],
      },
    },
    handler: async (a) => text(`${String(a.finish ?? "matte")} ${String(a.colour)}`),
  },
  {
    // optional vs required across several flat types
    def: {
      name: "greet",
      description: "Greets a person. Only the name is required.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1, description: "Who to greet" },
          title: { type: "string", description: "Optional honorific" },
          excited: { type: "boolean" },
        },
        required: ["name"],
      },
    },
    handler: async (a) =>
      text(`Hello, ${a.title ? `${String(a.title)} ` : ""}${String(a.name)}${a.excited === true ? "!" : "."}`),
  },
  {
    // nested objects
    def: {
      name: "create_user",
      description: "Creates a user record from a nested object.",
      inputSchema: {
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: {
              name: { type: "string" },
              address: {
                type: "object",
                properties: {
                  street: { type: "string" },
                  city: { type: "string" },
                  zip: { type: "string", pattern: "^[0-9]{5}$" },
                },
                required: ["city"],
              },
            },
            required: ["name"],
          },
        },
        required: ["user"],
      },
    },
    handler: async (a) => ({
      content: [{ type: "text", text: JSON.stringify(a.user) }],
      structuredContent: { created: a.user },
    }),
  },
  {
    // arrays of objects
    def: {
      name: "tag_items",
      description: "Tags a list of items. Each item is an object.",
      inputSchema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: { id: { type: "integer" }, label: { type: "string" } },
              required: ["id"],
            },
          },
          labels: { type: "array", items: { type: "string" }, description: "Array of strings" },
        },
        required: ["items"],
      },
    },
    handler: async (a) => text(`tagged ${(a.items as unknown[]).length} items`),
  },
  {
    // isError: true is a SUCCESSFUL JSON-RPC response, not a throw
    def: {
      name: "always_fails",
      description: "Always returns a tool-level error (isError: true).",
      inputSchema: { type: "object", properties: { reason: { type: "string" } } },
    },
    handler: async (a) => ({
      isError: true,
      content: [{ type: "text", text: `failed on purpose: ${String(a.reason ?? "no reason given")}` }],
    }),
  },
  {
    // ~1s sleep, honours cancellation
    def: {
      name: "slow",
      description: `Sleeps about ${SLOW_TOOL_MS}ms, then answers. Cancellable.`,
      inputSchema: { type: "object", properties: {} },
    },
    handler: async (_a, signal) => {
      await sleep(SLOW_TOOL_MS, signal);
      return text("done sleeping");
    },
  },
  {
    // large text blob
    def: {
      name: "big_text",
      description: `Returns ${BIG_TEXT_LENGTH} characters of text, to exercise response truncation.`,
      inputSchema: { type: "object", properties: {} },
    },
    handler: async () => text("x".repeat(BIG_TEXT_LENGTH)),
  },
  {
    // base64 image content
    def: {
      name: "tiny_image",
      description: "Returns a 1x1 PNG as base64 image content.",
      inputSchema: { type: "object", properties: {} },
    },
    handler: async () => ({
      content: [
        { type: "text", text: "here is an image" },
        { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
      ],
    }),
  },
  {
    // Hostile schema: oneOf, deep nesting, prefixItems. Phase 3 pins down what the form
    // refuses to render and falls back to raw JSON for.
    def: {
      name: "hostile_schema",
      description: "Deliberately awkward schema: oneOf, 6 levels of nesting, prefixItems.",
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          choice: {
            oneOf: [
              { type: "string" },
              { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
            ],
          },
          deep: nestedSchema(6),
          pair: {
            type: "array",
            prefixItems: [{ type: "string" }, { type: "number" }],
            items: false,
            minItems: 2,
          },
        },
        required: ["choice"],
      },
    },
    handler: async (a) => text(JSON.stringify(a)),
  },
  // Padding so tools/list spans multiple pages.
  ...Array.from({ length: FILLER_TOOL_COUNT }, (_v, i): FixtureTool => {
    const name = `filler_${String(i + 1).padStart(2, "0")}`;
    return {
      def: {
        name,
        description: `Padding tool ${i + 1} of ${FILLER_TOOL_COUNT}, present to force pagination.`,
        inputSchema: { type: "object", properties: { n: { type: "integer" } } },
      },
      handler: async (a) => text(`${name} ${String(a.n ?? "")}`.trim()),
    };
  }),
  {
    // Phase 5 gates this behind a confirm dialog
    def: {
      name: "delete_everything",
      description: "Pretends to delete everything. Does nothing real.",
      inputSchema: { type: "object", properties: { confirm: { type: "boolean" } } },
      annotations: { destructiveHint: true, readOnlyHint: false },
    },
    handler: async () => text("nothing was deleted, this is a fixture"),
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
