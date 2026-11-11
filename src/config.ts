// The on-disk config file: server definitions only. A literal secret is stripped before every
// write and the written shape cannot even express one (see ADR-0007).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  EnvRefSchema,
  HttpServerConfigSchema,
  StdioServerConfigSchema,
  isEnvRef,
  type SecretValue,
  type ServerConfig,
} from "./mcp/server-config.js";

/** Same as ServerConfig, except `env` and `headers` may hold only `{ fromEnv }` references. */
const PersistedRecord = z.record(z.string(), EnvRefSchema).optional();
export const PersistedServerConfigSchema = z.discriminatedUnion("transport", [
  StdioServerConfigSchema.extend({ env: PersistedRecord }),
  HttpServerConfigSchema.extend({ headers: PersistedRecord }),
]);
export type PersistedServerConfig = z.infer<typeof PersistedServerConfigSchema>;

export const CONFIG_VERSION = 1;
export const ConfigFileSchema = z.strictObject({
  version: z.literal(CONFIG_VERSION),
  /** Keyed by serverId. The caller of connect() supplies these ids. */
  servers: z.record(z.string().min(1), PersistedServerConfigSchema),
});
export type ConfigFile = z.infer<typeof ConfigFileSchema>;

export class ConfigError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ConfigError";
  }
}

export interface ResolveConfigPathInput {
  /** Value of the `--config` flag. */
  flag?: string | undefined;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
}

/** `--config` beats `MCP_STUDIO_CONFIG` beats `~/.mcp-studio/config.json`. Empty strings do not count. */
export function resolveConfigPath(input: ResolveConfigPathInput = {}): string {
  const env = input.env ?? process.env;
  if (input.flag) return path.resolve(input.flag);
  if (env.MCP_STUDIO_CONFIG) return path.resolve(env.MCP_STUDIO_CONFIG);
  return path.join(input.homedir ?? os.homedir(), ".mcp-studio", "config.json");
}

function keepRefs(values: Record<string, SecretValue> | undefined, stripped: string[], label: string) {
  if (!values) return undefined;
  const kept: Record<string, { fromEnv: string }> = {};
  for (const [key, value] of Object.entries(values)) {
    if (isEnvRef(value)) kept[key] = value;
    else stripped.push(`${label}.${key}`);
  }
  return kept;
}

/**
 * Drops every literal `env` and `headers` value, keeping only `{ fromEnv }` references. Returns the
 * persistable config plus the dotted names that were removed, so a caller can tell the user.
 */
export function stripSecrets(config: ServerConfig): { config: PersistedServerConfig; stripped: string[] } {
  const stripped: string[] = [];
  if (config.transport === "stdio") {
    const { env, ...rest } = config;
    const kept = keepRefs(env, stripped, "env");
    return { config: { ...rest, ...(kept ? { env: kept } : {}) }, stripped };
  }
  const { headers, ...rest } = config;
  const kept = keepRefs(headers, stripped, "headers");
  return { config: { ...rest, ...(kept ? { headers: kept } : {}) }, stripped };
}

/** A missing file is an empty config. A present but invalid file is a ConfigError, never silently reset. */
export function loadConfigFile(file: string): ConfigFile {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: CONFIG_VERSION, servers: {} };
    throw new ConfigError(`cannot read config file ${file}`, { cause: err });
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`config file ${file} is not valid JSON`, { cause: err });
  }
  const parsed = ConfigFileSchema.safeParse(json);
  if (!parsed.success) throw new ConfigError(`config file ${file} is invalid: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export interface SaveResult {
  /** serverId to the dotted names of literal values that were not written. */
  stripped: Record<string, string[]>;
}

/**
 * Writes the definitions to `file`, stripping literal secrets first. The result is parsed through
 * the persisted schema as a second line of defence, so a literal cannot reach disk even if
 * stripSecrets regressed. Atomic: temp file then rename. The file is owner-only on POSIX.
 */
export function saveConfigFile(file: string, servers: Record<string, ServerConfig>): SaveResult {
  const stripped: Record<string, string[]> = {};
  const persisted: Record<string, PersistedServerConfig> = {};
  for (const [id, cfg] of Object.entries(servers)) {
    const res = stripSecrets(cfg);
    persisted[id] = res.config;
    if (res.stripped.length > 0) stripped[id] = res.stripped;
  }
  const body: ConfigFile = ConfigFileSchema.parse({ version: CONFIG_VERSION, servers: persisted });
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return { stripped };
}
