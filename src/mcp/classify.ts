// One place that decides which ErrorKind a failed request was. Used by callTool and listTools so
// every caller sees the same taxonomy.
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { StudioError, errorMessage, isConnectionClosed, isRequestTimeout, isStudioError } from "./errors.js";
import { dropError, type Session } from "./session.js";

export interface ClassifyContext {
  session: Session;
  /** True when OUR AbortController fired (cancelCall or an external signal). */
  aborted: boolean;
  /** What was being attempted, for messages: `tools/call echo`, `tools/list`. */
  what: string;
  timeoutMs: number;
}

/** Throws not_connected up front instead of letting the SDK fail with an unhelpful "Not connected". */
export function assertOpen(session: Session): void {
  if (!session.closed) return;
  const why = dropError(session);
  throw new StudioError("not_connected", `"${session.serverId}" is not connected (${why.message})`, { cause: why });
}

/**
 * Order matters.
 *  1. Our own abort first: the SDK reports ANY abort whose reason is not an McpError as
 *     RequestTimeout, so checking timeout first would label every cancel a timeout.
 *  2. Timeout.
 *  3. A closed session: the child exited, the socket dropped, or the response cap tripped.
 *  4. Any other JSON-RPC error response (unknown tool, invalid params) is a protocol_error.
 */
export function classifyRequestError(err: unknown, ctx: ClassifyContext): StudioError {
  if (ctx.aborted) return new StudioError("cancelled", `${ctx.what} was cancelled`, { cause: err });
  if (isStudioError(err)) return err;
  if (isRequestTimeout(err)) return new StudioError("timeout", `${ctx.what} timed out after ${ctx.timeoutMs}ms`, { cause: err });
  if (ctx.session.closed || isConnectionClosed(err)) return dropError(ctx.session);
  if (err instanceof McpError) return new StudioError("protocol_error", `${ctx.what} failed: ${err.message}`, { cause: err });
  return new StudioError("protocol_error", `${ctx.what} failed: ${errorMessage(err)}`, { cause: err });
}
