// tools/list across every page, normalised to the shape the rest of the product consumes.
import type { Tool, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { StudioError } from "./errors.js";
import type { Session } from "./session.js";

/** More pages than any real server has. Reaching it means the server never ends its cursor chain. */
export const MAX_LIST_PAGES = 50;
export const DEFAULT_LIST_TIMEOUT_MS = 30_000;

export interface ToolDef {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Tool["inputSchema"];
  outputSchema?: Tool["outputSchema"];
  annotations?: ToolAnnotations;
}

export interface ListToolsOptions {
  /** Hard cap on pages fetched. */
  maxPages?: number;
  /** Per-page request timeout in ms. The SDK default is 60s. */
  timeout?: number;
  signal?: AbortSignal;
}

/** Keeps only the fields ToolDef names and drops absent ones, so equality checks stay simple. */
export function toToolDef(tool: Tool): ToolDef {
  const def: ToolDef = { name: tool.name, inputSchema: tool.inputSchema };
  if (tool.title !== undefined) def.title = tool.title;
  if (tool.description !== undefined) def.description = tool.description;
  if (tool.outputSchema !== undefined) def.outputSchema = tool.outputSchema;
  if (tool.annotations !== undefined) def.annotations = tool.annotations;
  return def;
}

/**
 * Follows `nextCursor` until the server stops returning one. A server that keeps returning a
 * cursor forever, or hands the same cursor back, hits the page cap and fails with
 * pagination_runaway rather than looping.
 */
export async function listTools(session: Session, opts: ListToolsOptions = {}): Promise<ToolDef[]> {
  const maxPages = opts.maxPages ?? MAX_LIST_PAGES;
  const out: ToolDef[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await session.client.listTools(cursor === undefined ? undefined : { cursor }, {
      timeout: opts.timeout ?? DEFAULT_LIST_TIMEOUT_MS,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    out.push(...res.tools.map(toToolDef));
    if (!res.nextCursor) return out;
    if (seen.has(res.nextCursor)) {
      throw new StudioError("pagination_runaway", `server returned cursor "${res.nextCursor}" twice in tools/list`);
    }
    seen.add(res.nextCursor);
    cursor = res.nextCursor;
  }
  throw new StudioError("pagination_runaway", `tools/list still had a nextCursor after ${maxPages} pages`);
}
