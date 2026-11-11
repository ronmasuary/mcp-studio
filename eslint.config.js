import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // web/ is deliberately ignored here: it has its own flat config (web/eslint.config.js, with
    // the React hooks plugin) and the root `lint` script runs both, so the UI half is linted.
    ignores: ["dist/**", "node_modules/**", "web/**", ".claude/**"],
  },
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-console": ["error", { allow: ["error"] }],
    },
  },
);
