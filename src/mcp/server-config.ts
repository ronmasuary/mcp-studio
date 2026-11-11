// What a user types to describe an MCP server. Pure data plus zod; no I/O, no React, no API layer.
import { z } from "zod";

/**
 * An `env` or `headers` value. A literal string is memory-only: it is used for the session it was
 * typed into and is never written to disk (see config.ts and ADR-0007). `{ fromEnv: "NAME" }` is a
 * reference to a variable in the host environment, resolved at connect time, and is safe to persist.
 */
export const EnvRefSchema = z.strictObject({ fromEnv: z.string().min(1) });
export const SecretValueSchema = z.union([z.string(), EnvRefSchema]);
export type EnvRef = z.infer<typeof EnvRefSchema>;
export type SecretValue = z.infer<typeof SecretValueSchema>;

export const StdioServerConfigSchema = z.strictObject({
  transport: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), SecretValueSchema).optional(),
  cwd: z.string().min(1).optional(),
});

export const HttpServerConfigSchema = z.strictObject({
  transport: z.literal("http"),
  url: z.url({ protocol: /^https?$/ }),
  headers: z.record(z.string(), SecretValueSchema).optional(),
});

export const ServerConfigSchema = z.discriminatedUnion("transport", [
  StdioServerConfigSchema,
  HttpServerConfigSchema,
]);

export type StdioServerConfig = z.infer<typeof StdioServerConfigSchema>;
export type HttpServerConfig = z.infer<typeof HttpServerConfigSchema>;
export type ServerConfig = z.infer<typeof ServerConfigSchema>;

export function isEnvRef(v: SecretValue): v is EnvRef {
  return typeof v === "object";
}
