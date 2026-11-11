import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

// Linted by the root `npm run lint` via `eslint --config web/eslint.config.js web`.
// @eslint/js and typescript-eslint resolve from the root node_modules.
export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
);
