// A live connection to one MCP server. Plain data around the SDK Client, so callers never touch
// transports directly.
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

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
