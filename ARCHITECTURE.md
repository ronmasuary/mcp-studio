# Architecture

Stub. This is filled in properly in Phase 7. The plan of record is [docs/BUILD-PLAN.md](docs/BUILD-PLAN.md);
decisions live in [docs/adr/](docs/adr/).

## Shape

Local-first CLI plus local web UI. One Node process owns the MCP sessions and serves a JSON API
and the built UI. No cloud, no database, no account.

## Source tree

```
src/
  mcp/        client, transports, session registry, connect, listTools, callTool
  mcp/__fixtures__/echo-server.ts   a real MCP server, used by tests
  schema/     JSON Schema -> form model (pure, no React)
  collections/ load, save, run, assert
  config.ts   config file schema + resolution
  slug.ts     ported from Memex: safe filenames
  api.ts      node:http JSON API + static serving
  cli.ts      mcp-studio serve
web/          React + Vite, own package.json, own tsconfig, own vitest config
```

Phase 0 only has `src/cli.ts` and `web/`; the rest arrives phase by phase.

## Rules

- Tests are colocated as `src/**/*.test.ts`. There is no top-level `test/` directory: vitest
  collects only `src/**/*.test.ts` and `tsconfig.json` sets `rootDir: src`, so anything outside
  `src/` would be neither run nor typechecked.
- `src/mcp/` and `src/schema/` never import React and never import the API layer.
- `web/` is linted with its own flat config and tested with its own vitest config (jsdom).
