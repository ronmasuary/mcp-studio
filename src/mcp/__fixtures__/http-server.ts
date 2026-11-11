// Real HTTP MCP servers for the http transport tests. Both are plain node:http servers on an
// ephemeral loopback port. The first speaks Streamable HTTP and serves the same tools as the stdio
// fixture; the second speaks only the legacy HTTP+SSE transport (protocol 2024-11-05).
import { randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createFixtureServer } from "./echo-server.js";

export interface HttpFixture {
  /** e.g. http://127.0.0.1:54321/mcp */
  url: string;
  /** Headers of every request the server received, in order. */
  seenHeaders: IncomingHttpHeaders[];
  close(): Promise<void>;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`));
  });
}

function closer(server: Server): () => Promise<void> {
  return () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
}

/** A Streamable HTTP server backed by the fixture's tools. Each client session gets its own server. */
export async function startStreamableHttpFixture(): Promise<HttpFixture> {
  const seenHeaders: IncomingHttpHeaders[] = [];
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const server = createServer((req, res) => {
    seenHeaders.push(req.headers);
    void (async () => {
      try {
        const body = req.method === "POST" ? await readJson(req) : undefined;
        const sid = req.headers["mcp-session-id"];
        let transport = typeof sid === "string" ? sessions.get(sid) : undefined;
        if (!transport && isInitializeRequest(body)) {
          const created: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id: string): void => {
              sessions.set(id, created);
            },
          });
          await createFixtureServer().connect(created);
          transport = created;
        }
        if (!transport) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "no valid session" }, id: null }));
          return;
        }
        await transport.handleRequest(req, res, body);
      } catch {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    })();
  });
  const url = await listen(server);
  return { url, seenHeaders, close: closer(server) };
}

/**
 * A legacy HTTP+SSE server: GET opens an event stream that announces a POST endpoint, and POSTs to
 * the URL a Streamable HTTP client uses are refused with 405. A real server of this vintage.
 */
export async function startSseOnlyFixture(): Promise<HttpFixture> {
  const seenHeaders: IncomingHttpHeaders[] = [];
  const server = createServer((req, res) => {
    seenHeaders.push(req.headers);
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write("event: endpoint\ndata: /messages?sessionId=legacy\n\n");
      return;
    }
    req.resume();
    res.writeHead(405, { Allow: "GET" });
    res.end();
  });
  const url = await listen(server);
  return { url, seenHeaders, close: closer(server) };
}
