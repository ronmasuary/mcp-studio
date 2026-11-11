// callTool: one tools/call, with a measured duration and an explicit timeout.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { StudioError, isRequestTimeout } from "./errors.js";
import type { Session } from "./session.js";

/** The SDK default is 60s, which outlives the 20s test budget and any patient user. */
export const DEFAULT_CALL_TIMEOUT_MS = 30_000;

export type ContentBlock = CallToolResult["content"][number];

/**
 * Exactly the fields of a tools/call response, plus `ms`. There is no `ok`: `isError` is the
 * single truth, and `isError: true` is a SUCCESSFUL JSON-RPC response, so it is returned, not thrown.
 */
export interface CallResult {
  content: ContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError: boolean;
  /** Wall-clock duration measured here. The SDK reports no timing. */
  ms: number;
}

export interface CallOptions {
  /** Identifies the call. Cancellation by id is wired up in cancel.ts. */
  callId: string;
  signal?: AbortSignal;
  /** Request timeout in ms. Defaults to DEFAULT_CALL_TIMEOUT_MS. */
  timeout?: number;
}

export async function callTool(
  session: Session,
  name: string,
  args: Record<string, unknown>,
  opts: CallOptions,
): Promise<CallResult> {
  const timeout = opts.timeout ?? DEFAULT_CALL_TIMEOUT_MS;
  const started = performance.now();
  try {
    const res = await session.client.callTool({ name, arguments: args }, undefined, {
      timeout,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const result: CallResult = {
      content: (res.content ?? []) as ContentBlock[],
      isError: res.isError === true,
      ms: Math.round(performance.now() - started),
    };
    if (res.structuredContent !== undefined) result.structuredContent = res.structuredContent as Record<string, unknown>;
    return result;
  } catch (err) {
    const ms = Math.round(performance.now() - started);
    if (isRequestTimeout(err)) throw new StudioError("timeout", `${name} timed out after ${timeout}ms`, { cause: err });
    if (opts.signal?.aborted) throw new StudioError("cancelled", `${name} was cancelled after ${ms}ms`, { cause: err });
    throw err;
  }
}
