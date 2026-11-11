// The error taxonomy. Every way a connect or call can go wrong is one `kind`, so the API layer
// can map kinds to status codes and the UI can pick a message without parsing strings.
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

export type ErrorKind =
  /** The child process could not be started (ENOENT, EACCES, bad cwd). */
  | "spawn_failed"
  /** The transport came up but the MCP `initialize` handshake did not complete. */
  | "initialize_failed"
  /** The URL speaks only the deprecated HTTP+SSE transport of protocol revision 2024-11-05. */
  | "sse_only_unsupported"
  /** The connection went away mid-flight: the child exited, the socket closed, the buffer cap tripped. */
  | "transport_dropped"
  /** A single message exceeded the configured response-size cap. */
  | "response_too_large"
  /** The call exceeded its timeout. */
  | "timeout"
  /** The caller aborted the call. */
  | "cancelled"
  /** The tool ran and reported `isError: true`. A successful response, surfaced by `toolErrorKind`. */
  | "tool_error"
  /** A `{ fromEnv }` reference points at a variable that is not set. */
  | "config_invalid"
  /** The session is not connected. */
  | "not_connected"
  /** The serverId is already connected or connecting. */
  | "already_connected"
  /** A callId is already in flight. */
  | "duplicate_call"
  /** The server's tools/list never ended within the page cap. */
  | "pagination_runaway";

export class StudioError extends Error {
  readonly kind: ErrorKind;
  constructor(kind: ErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StudioError";
    this.kind = kind;
  }
}

/** A thrown value tagged with its kind. Already-tagged errors pass through unchanged. */
export function isStudioError(err: unknown): err is StudioError {
  return err instanceof StudioError;
}

/** Node's spawn failures carry `syscall: "spawn <cmd>"` and a code such as ENOENT. */
export function isSpawnFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as NodeJS.ErrnoException;
  return typeof e.syscall === "string" && e.syscall.startsWith("spawn");
}

export function isRequestTimeout(err: unknown): boolean {
  return err instanceof McpError && err.code === ErrorCode.RequestTimeout;
}

export function isConnectionClosed(err: unknown): boolean {
  return err instanceof McpError && err.code === ErrorCode.ConnectionClosed;
}

/** For a tool result: "tool_error" when the server reported `isError: true`, otherwise undefined. */
export function toolErrorKind(result: { isError: boolean }): ErrorKind | undefined {
  return result.isError ? "tool_error" : undefined;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
