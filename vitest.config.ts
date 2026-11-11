import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Memex hit flaky Windows subprocess timeouts at the 5s default; every integration test
    // here spawns a real `node --import tsx` child, so keep this at 20s.
    testTimeout: 20000,
  },
});
