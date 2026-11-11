import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ConfigError, loadConfigFile, resolveConfigPath, saveConfigFile, stripSecrets } from "./config.js";
import type { ServerConfig } from "./mcp/server-config.js";

const dir = mkdtempSync(path.join(os.tmpdir(), "mcp-studio-config-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SECRET = "sk-live-do-not-persist-12345";
const stdio: ServerConfig = {
  transport: "stdio",
  command: "node",
  args: ["server.js"],
  env: { API_KEY: SECRET, FROM_HOST: { fromEnv: "MY_KEY" } },
};
const http: ServerConfig = {
  transport: "http",
  url: "http://127.0.0.1:9/mcp",
  headers: { Authorization: `Bearer ${SECRET}`, "X-Ref": { fromEnv: "TOKEN" } },
};

describe("resolveConfigPath", () => {
  const env = { MCP_STUDIO_CONFIG: "/from/env.json" };
  it("prefers the flag", () => {
    expect(resolveConfigPath({ flag: "/from/flag.json", env, homedir: "/h" })).toBe(path.resolve("/from/flag.json"));
  });
  it("falls back to MCP_STUDIO_CONFIG", () => {
    expect(resolveConfigPath({ env, homedir: "/h" })).toBe(path.resolve("/from/env.json"));
  });
  it("falls back to the home directory", () => {
    expect(resolveConfigPath({ env: {}, homedir: "/h" })).toBe(path.join("/h", ".mcp-studio", "config.json"));
  });
  it("ignores empty values", () => {
    expect(resolveConfigPath({ flag: "", env: { MCP_STUDIO_CONFIG: "" }, homedir: "/h" })).toBe(
      path.join("/h", ".mcp-studio", "config.json"),
    );
  });
});

describe("stripSecrets", () => {
  it("removes literal env values and keeps fromEnv refs", () => {
    const res = stripSecrets(stdio);
    expect(res.stripped).toEqual(["env.API_KEY"]);
    expect(res.config).toMatchObject({ env: { FROM_HOST: { fromEnv: "MY_KEY" } } });
    expect(JSON.stringify(res.config)).not.toContain(SECRET);
  });
  it("removes literal headers", () => {
    const res = stripSecrets(http);
    expect(res.stripped).toEqual(["headers.Authorization"]);
    expect(JSON.stringify(res.config)).not.toContain(SECRET);
  });
});

describe("saveConfigFile / loadConfigFile", () => {
  it("never writes a literal secret to disk and round-trips the rest", () => {
    const file = path.join(dir, "nested", "config.json");
    const res = saveConfigFile(file, { a: stdio, b: http });
    expect(res.stripped).toEqual({ a: ["env.API_KEY"], b: ["headers.Authorization"] });
    expect(readFileSync(file, "utf8")).not.toContain(SECRET);
    const loaded = loadConfigFile(file);
    expect(loaded.servers.a).toMatchObject({ command: "node", env: { FROM_HOST: { fromEnv: "MY_KEY" } } });
    expect(loaded.servers.b).toMatchObject({ headers: { "X-Ref": { fromEnv: "TOKEN" } } });
  });

  it("leaves no temp file behind", () => {
    const file = path.join(dir, "clean", "config.json");
    saveConfigFile(file, { a: stdio });
    expect(readdirSync(path.dirname(file))).toEqual(["config.json"]);
  });

  it("treats a missing file as empty", () => {
    expect(loadConfigFile(path.join(dir, "absent.json"))).toEqual({ version: 1, servers: {} });
  });

  it("refuses a file that contains a literal secret", () => {
    const file = path.join(dir, "hand-edited.json");
    const body = { version: 1, servers: { a: { transport: "stdio", command: "x", env: { K: SECRET } } } };
    writeFileSync(file, JSON.stringify(body));
    expect(() => loadConfigFile(file)).toThrow(ConfigError);
  });

  it("refuses invalid JSON and unknown versions", () => {
    const bad = path.join(dir, "bad.json");
    writeFileSync(bad, "{nope");
    expect(() => loadConfigFile(bad)).toThrow(/not valid JSON/);
    const v2 = path.join(dir, "v2.json");
    writeFileSync(v2, JSON.stringify({ version: 2, servers: {} }));
    expect(() => loadConfigFile(v2)).toThrow(ConfigError);
  });
});
