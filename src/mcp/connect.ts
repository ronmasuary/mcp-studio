// Build a transport, run the MCP initialize handshake, hand back a Session.
// The CALLER supplies serverId. This module never mints one.
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  StudioError,
  errorMessage,
  isRequestTimeout,
  isSpawnFailure,
  isStudioError,
} from "./errors.js";
import type { Session } from "./session.js";
import {
  ServerConfigSchema,
  isEnvRef,
  type HttpServerConfig,
  type SecretValue,
  type ServerConfig,
  type StdioServerConfig,
} from "./server-config.js";

export const CLIENT_INFO = { name: "mcp-studio", version: "0.0.0" } as const;
/** How long initialize may take. The SDK default is 60s, which outlives any sane UI spinner. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const STDERR_TAIL_CHARS = 4096;
const SSE_PROBE_TIMEOUT_MS = 3000;

export interface ConnectOptions {
  /** Where `{ fromEnv }` references are resolved. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Initialize deadline in ms. */
  connectTimeoutMs?: number;
  /**
   * Largest single message the stdio transport accepts, in bytes. Above it the transport errors
   * and closes (SDK default 10MB). The http transport has no equivalent; see ADR-0001.
   */
  maxResponseBytes?: number;
}

/**
 * Turns `{ A: "literal", B: { fromEnv: "NAME" } }` into plain strings. A missing variable is a
 * config_invalid error that names the variable, never a value.
 */
export function resolveValues(
  values: Record<string, SecretValue> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    if (!isEnvRef(value)) {
      out[key] = value;
      continue;
    }
    const resolved = env[value.fromEnv];
    if (resolved === undefined) {
      throw new StudioError("config_invalid", `"${key}" refers to environment variable ${value.fromEnv}, which is not set`);
    }
    out[key] = resolved;
  }
  return out;
}

/** A stdio transport that remembers its child's pid from the moment it spawns. */
class TrackedStdioTransport extends StdioClientTransport {
  spawnedPid: number | null = null;
  override async start(): Promise<void> {
    await super.start();
    this.spawnedPid = this.pid;
  }
}

/**
 * True when `command` resolves to a file. The SDK spawns through cross-spawn, which on Windows
 * reports a missing command as a child that prints "not recognized" and exits, so a missing
 * executable would otherwise look like a failed handshake. Checking first keeps spawn_failed
 * and initialize_failed distinguishable on every platform.
 */
export function commandResolves(command: string, env: Record<string, string>, cwd?: string): boolean {
  const exts = process.platform === "win32" ? (env.PATHEXT ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  const isFile = (p: string): boolean => {
    try {
      if (!statSync(p).isFile()) return false;
      if (process.platform !== "win32") accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  const candidates = (base: string): string[] =>
    path.extname(base) && process.platform === "win32" ? [base, ...exts.map((e) => base + e)] : exts.map((e) => base + e);
  if (command.includes("/") || command.includes("\\")) {
    return candidates(path.resolve(cwd ?? process.cwd(), command)).some(isFile);
  }
  const pathVar = env.PATH ?? env.Path ?? "";
  return pathVar
    .split(path.delimiter)
    .filter(Boolean)
    .some((dir) => candidates(path.join(dir, command)).some(isFile));
}

function buildStdio(cfg: StdioServerConfig, opts: ConnectOptions): TrackedStdioTransport {
  const resolved = resolveValues(cfg.env, opts.env);
  const env = { ...getDefaultEnvironment(), ...resolved };
  if (!commandResolves(cfg.command, env, cfg.cwd)) {
    throw new StudioError("spawn_failed", `could not start "${cfg.command}": command not found`);
  }
  return new TrackedStdioTransport({
    command: cfg.command,
    ...(cfg.args ? { args: cfg.args } : {}),
    ...(cfg.cwd ? { cwd: cfg.cwd } : {}),
    // A bare `env` REPLACES the environment and the child loses PATH, SystemRoot, APPDATA and
    // COMSPEC, which breaks every npx server on Windows. Always extend the defaults.
    env,
    stderr: "pipe",
    ...(opts.maxResponseBytes ? { maxBufferSize: opts.maxResponseBytes } : {}),
  });
}

function buildHttp(cfg: HttpServerConfig, opts: ConnectOptions): StreamableHTTPClientTransport {
  const headers = resolveValues(cfg.headers, opts.env);
  // StreamableHTTPClientTransport has no `headers` option. They travel in requestInit.
  return new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers } });
}

/**
 * Legacy HTTP+SSE servers (protocol revision 2024-11-05) answer a GET with an event stream and
 * reject the POST that Streamable HTTP opens with. Probe once so the failure can be named.
 */
async function looksSseOnly(cfg: HttpServerConfig, opts: ConnectOptions): Promise<boolean> {
  try {
    const res = await fetch(cfg.url, {
      method: "GET",
      headers: { ...resolveValues(cfg.headers, opts.env), Accept: "text/event-stream" },
      signal: AbortSignal.timeout(SSE_PROBE_TIMEOUT_MS),
    });
    void res.body?.cancel().catch(() => undefined);
    return res.ok && (res.headers.get("content-type") ?? "").includes("text/event-stream");
  } catch {
    return false;
  }
}

async function classifyConnectError(
  err: unknown,
  cfg: ServerConfig,
  opts: ConnectOptions,
  stderrTail: string,
): Promise<StudioError> {
  if (isStudioError(err)) return err;
  if (cfg.transport === "stdio" && isSpawnFailure(err)) {
    return new StudioError("spawn_failed", `could not start "${cfg.command}": ${errorMessage(err)}`, { cause: err });
  }
  if (cfg.transport === "http" && err instanceof StreamableHTTPError && [400, 404, 405].includes(err.code ?? 0)) {
    if (await looksSseOnly(cfg, opts)) {
      return new StudioError(
        "sse_only_unsupported",
        `${cfg.url} speaks only the legacy HTTP+SSE transport (protocol 2024-11-05). MCP Studio supports stdio and Streamable HTTP; there is no SSE fallback.`,
        { cause: err },
      );
    }
  }
  const timedOut = isRequestTimeout(err);
  const tail = stderrTail.trim();
  const detail = timedOut
    ? `initialize timed out after ${opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS}ms`
    : errorMessage(err);
  return new StudioError("initialize_failed", `initialize failed: ${detail}${tail ? `\nserver stderr:\n${tail}` : ""}`, {
    cause: err,
  });
}

/**
 * Connects to a server and returns the live Session. Throws a StudioError whose `kind` says what
 * went wrong: config_invalid, spawn_failed, initialize_failed or sse_only_unsupported.
 */
export async function connect(serverId: string, config: ServerConfig, opts: ConnectOptions = {}): Promise<Session> {
  const parsed = ServerConfigSchema.safeParse(config);
  if (!parsed.success) throw new StudioError("config_invalid", `invalid server config for "${serverId}"`);
  const cfg = parsed.data;

  let transport: Transport;
  let stderrChunks = "";
  let stdioTransport: TrackedStdioTransport | undefined;
  if (cfg.transport === "stdio") {
    stdioTransport = buildStdio(cfg, opts);
    stdioTransport.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks = (stderrChunks + chunk.toString("utf8")).slice(-STDERR_TAIL_CHARS);
    });
    transport = stdioTransport;
  } else {
    transport = buildHttp(cfg, opts);
  }

  const client = new Client(CLIENT_INFO);
  const session: Session = {
    serverId,
    kind: cfg.transport,
    client,
    pid: null,
    closed: false,
    closing: false,
    lastTransportError: undefined,
    stderrTail: () => stderrChunks,
    closeListeners: new Set(),
  };
  client.onerror = (err) => {
    session.lastTransportError = err;
  };
  client.onclose = () => {
    session.closed = true;
    for (const listener of session.closeListeners) listener(session);
  };

  try {
    await client.connect(transport, { timeout: opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS });
  } catch (err) {
    await client.close().catch(() => undefined);
    throw await classifyConnectError(err, cfg, opts, stderrChunks);
  }
  // pid is read once, here, because transport.pid goes null as soon as the child exits.
  session.pid = stdioTransport?.spawnedPid ?? null;
  return session;
}
