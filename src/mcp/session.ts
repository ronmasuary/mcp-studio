// A live connection to one MCP server. Plain data around the SDK Client, so callers never touch
// transports directly.
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StudioError } from "./errors.js";

export type TransportKind = "stdio" | "http";

export interface Session {
  readonly serverId: string;
  readonly kind: TransportKind;
  readonly client: Client;
  /**
   * Child process pid for stdio sessions, captured when the process spawned. The SDK's own
   * `transport.pid` returns null once the process has exited, which is exactly when cleanup
   * wants it, so it is recorded here.
   */
  pid: number | null;
  /** True once the transport has closed, for any reason. */
  closed: boolean;
  /** True when WE initiated the close (disconnect), as opposed to the transport dropping. */
  closing: boolean;
  /** The last error the transport reported, for example the stdio buffer cap tripping. */
  lastTransportError: Error | undefined;
  /** Tail of the child's stderr (stdio only), kept to explain failures. */
  stderrTail: () => string;
  /** Called once when the transport closes. */
  readonly closeListeners: Set<(session: Session) => void>;
}

/** The SDK's ReadBuffer message when one stdio message exceeds maxBufferSize. */
const BUFFER_CAP_RE = /exceeded maximum size of (d+) bytes/;

/**
 * Why a session closed when we did not ask it to: response_too_large when the stdio buffer cap
 * tripped, transport_dropped otherwise (child exited, socket closed).
 */
export function dropError(session: Session): StudioError {
  const cause = session.lastTransportError;
  const cap = cause ? BUFFER_CAP_RE.exec(cause.message) : null;
  if (cap) {
    return new StudioError(
      "response_too_large",
      `a response exceeded the ${cap[1]} byte cap and the connection was closed`,
      { cause },
    );
  }
  const tail = session.stderrTail().trim();
  const why = cause ? `: ${cause.message}` : "";
  return new StudioError(
    "transport_dropped",
    `connection to "${session.serverId}" was lost${why}${tail ? `
server stderr:
${tail}` : ""}`,
    { cause },
  );
}
