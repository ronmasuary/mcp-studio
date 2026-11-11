import { describe, expect, it } from "vitest";
import { ServerConfigSchema } from "./server-config.js";

describe("ServerConfigSchema", () => {
  it("accepts stdio with literal and fromEnv values", () => {
    const parsed = ServerConfigSchema.parse({
      transport: "stdio",
      command: "npx",
      args: ["-y", "some-server"],
      env: { A: "literal", B: { fromEnv: "MY_KEY" } },
      cwd: "/tmp",
    });
    expect(parsed.transport).toBe("stdio");
  });

  it("accepts http with headers", () => {
    const parsed = ServerConfigSchema.parse({
      transport: "http",
      url: "http://127.0.0.1:3000/mcp",
      headers: { Authorization: { fromEnv: "TOKEN" } },
    });
    expect(parsed.transport).toBe("http");
  });

  it.each([
    ["missing command", { transport: "stdio" }],
    ["empty command", { transport: "stdio", command: "" }],
    ["unknown transport", { transport: "sse", url: "http://x.test" }],
    ["non-http url", { transport: "http", url: "file:///etc/passwd" }],
    ["http with stdio fields", { transport: "http", url: "http://x.test", command: "ls" }],
    ["empty fromEnv", { transport: "stdio", command: "x", env: { A: { fromEnv: "" } } }],
    ["numeric env value", { transport: "stdio", command: "x", env: { A: 1 } }],
  ])("rejects %s", (_name, input) => {
    expect(ServerConfigSchema.safeParse(input).success).toBe(false);
  });
});
