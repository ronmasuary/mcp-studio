# ADR-0001: Transports are stdio and Streamable HTTP, with no SSE-only fallback

Status: accepted (Phase 2, task 2.12)

## Context

MCP Studio connects to servers over the transports the MCP specification defines. Three names get
conflated, so this ADR is deliberate about them.

- **stdio.** The client spawns the server as a child process and exchanges newline-delimited
  JSON-RPC over its stdin and stdout.
- **HTTP+SSE.** The transport of protocol revision **2024-11-05**. The client opens a long-lived
  `GET` that returns a Server-Sent Events stream, the server announces a separate POST endpoint in
  an `endpoint` event, and the client sends every request to that endpoint. Two endpoints, one
  logical session.
- **Streamable HTTP.** The transport introduced in protocol revision **2025-03-26**, which
  superseded HTTP+SSE. One endpoint accepts `POST` for client-to-server messages. The server
  answers either with a plain JSON body or by upgrading that response to an SSE stream, and a
  client may also open a `GET` for a server-to-client stream.

What was deprecated is the **HTTP+SSE transport of 2024-11-05**. It was replaced by Streamable HTTP
in 2025-03-26. **Server-Sent Events as a mechanism is not deprecated**: Streamable HTTP itself uses
SSE for the server-to-client stream, so a Streamable HTTP client contains SSE parsing. The SDK
reflects this: `client/sse.js` still ships, with `SSEClientTransport` marked `@deprecated` in
favour of `StreamableHTTPClientTransport`. "We dropped SSE" would be wrong; "we did not implement
the legacy two-endpoint transport" is right.

## Decision

1. Support exactly two transports: **stdio** and **Streamable HTTP**.
2. **Do not implement the legacy HTTP+SSE transport, and do not fall back to it.** `SSEClientTransport`
   is not imported anywhere.
3. A URL that serves only the legacy transport fails `connect` with the named error kind
   `sse_only_unsupported`. The message states that the server speaks protocol 2024-11-05 and that
   there is no fallback. It is not a crash, not a generic "initialize failed", and not a silent
   retry over a different transport.
4. HTTP headers go in `StreamableHTTPClientTransport`'s `opts.requestInit.headers`. The transport
   has no `headers` option of its own.
5. OAuth is out of scope for v0.1: static headers only, with values either typed into the connect
   modal (memory only) or referenced by environment variable name (ADR-0007).

### How the SSE-only case is detected

A Streamable HTTP client opens with a `POST` of the `initialize` request. A legacy server rejects
that with 400, 404 or 405. When `connect` sees one of those, it makes a single bounded `GET` with
`Accept: text/event-stream`; a 2xx response whose `Content-Type` is `text/event-stream` identifies a
legacy endpoint, and the error is `sse_only_unsupported`. Any other outcome stays
`initialize_failed`. The probe is one request with a 3 second limit, and it never follows the
`endpoint` event it receives.

## Consequences

- Servers that have not migrated off 2024-11-05 cannot be used until they do. The error says so
  precisely, which is more useful than a timeout. If demand appears, a legacy transport can be added
  behind an explicit user choice; an automatic fallback stays off the table because it hides which
  protocol a user is actually testing, and MCP Studio exists to show exactly that.
- The detection is a heuristic. A current server that returns 400 or 404 to `initialize` and also
  serves an event stream on `GET` would be misreported as legacy. That is rare, and the original
  HTTP status is preserved as the error's `cause`.
- The Streamable HTTP transport has no equivalent of the stdio response-size cap. `maxResponseBytes`
  applies to stdio only. The per-call timeout (30 seconds by default) bounds how long a response can
  take, and `normaliseContent` bounds what reaches the UI.
- Tests run against real servers: the SDK's own Streamable HTTP server transport serving the stdio
  fixture's tools, and a small `node:http` server that behaves like a 2024-11-05 server. No protocol
  mocking.
