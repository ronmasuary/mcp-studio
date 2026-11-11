# MCP Studio: build plan v3 (ready to build)

Postman for MCP. Connect to any MCP server, browse its tools, fill an auto-generated
form from each tool's JSON Schema, fire the call, read the response. Save calls into
Collections with pass/fail checks.

- **Repo:** `ronmasuary/mcp-studio`, public from the start
- **Stack:** TypeScript, Node 20+, ESM, `node:http`, React + Vite, Vitest
- **SDK:** `@modelcontextprotocol/sdk@^1.32.2` (the version Memex already runs)
- **Shape:** local-first CLI plus local web UI. No cloud, no database, no account.

> v3 after two review passes. Every SDK signature, config path and dependency below was
> checked against `node_modules` and Memex's real files on this machine, not from memory.

## v0.1 scope

In scope:
- Connect to an MCP server over stdio and over streamable HTTP
- List tools (paginated), show name, description, schema, annotations
- Auto-generate a form per tool from its JSON Schema, plus a raw JSON escape hatch
- Execute a call, show response, status, duration, and cancel it mid-flight
- Collections: save a call, re-run it, assert on the result, pass/fail badge

Deferred, and said out loud in the README:
- CI runner (`mcp-studio test` in GitHub Actions)
- Server scaffolding generator, mock and record/replay
- OAuth for HTTP servers (static headers only in v0.1)
- `tools/list_changed` live refresh (v0.1 has a manual refresh button)
- Playwright end-to-end suite

README "known limits" must also state: two browser tabs driving one session, and
connecting the same server definition twice, are undefined in v0.1.

**If time pressure hits, cut streamable HTTP, not Collections.** Stdio covers every
local server and the whole demo. Collections is what makes this more than an SDK sample.

## Architecture

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

Two rules that pay off later:
- Tests are colocated as `src/**/*.test.ts`, matching Memex. Do **not** add a top-level
  `test/` dir: Memex's `vitest.config.ts` collects `src/**/*.test.ts` and its `tsconfig.json`
  sets `rootDir: src`, so anything outside `src/` is neither run nor typechecked.
- `src/mcp/` and `src/schema/` never import React and never import the API layer. That is the
  code Firewall and Vault reuse. Keep the boundary clean now, extract to a package when
  Firewall actually needs it.

## Key decisions made up front

These were open questions in earlier drafts. They are decided, so no task carries them forward.

- **Secrets never persist to disk.** The config file stores server definitions, but `env` and
  `headers` values are either typed into the connect modal (memory only, for that session) or
  referenced by environment-variable *name*, for example `{ "env": { "API_KEY": { "fromEnv": "MY_KEY" } } }`,
  resolved at connect time. A literal secret is never written to the config. Recorded as ADR-0007.
- **No editor dependency.** The raw JSON escape hatch is a `<textarea>` with `JSON.parse`
  validation on blur. No CodeMirror.
- **No virtualisation dependency.** Large responses are capped with a truncation marker and a
  "show more" expansion. No `react-window`.
- **JSON-path assertions use a ~15-line dot-path resolver.** No dependency.
- **A saved call whose server is not connected fails the row** with a named reason. No implicit
  auto-connect.
- **`web/` is linted**, with its own flat config and `eslint-plugin-react-hooks`. Memex's root
  eslint config ignores `web/**`; leaving the half of the codebase that holds every bit of UI
  logic unlinted is not defensible in a repo built to be read.

## Phases

Each task is one commit. Each phase ends green and reviewable.

### Phase 0: groundwork (1 day)

- [ ] 0.1 Create repo `mcp-studio`, **public immediately**. CodeQL is free only on public repos, and an empty green repo is nothing to hide
- [ ] 0.2 Copy Memex's skeleton: `eslint.config.js`, `.editorconfig`, `.gitattributes`, `.gitignore`, LICENSE (MIT)
- [ ] 0.3 Copy `tsconfig.json` and `tsconfig.build.json`. Keep `rootDir: src` and `include: ["src/**/*.ts"]`. Confirm `tsconfig.build.json` excludes `**/*.test.ts` and `**/__fixtures__/**` from emit
- [ ] 0.4 `vitest.config.ts`: `include: ["src/**/*.test.ts"]`, `testTimeout: 20000`. Memex hit flaky Windows subprocess timeouts at the 5s default; do not relearn this
- [ ] 0.5 Root `package.json`: ESM, Node >=20, bin `mcp-studio`, scripts `build`, `build:web`, `build:all`, `setup`, `typecheck`, `lint`, `test`, `test:web`. Add `files: ["dist","web/dist"]` and a `prepack` running `build:all`, or the published package ships without a UI
- [ ] 0.6 Check `mcp-studio` is free on npm. If taken, pick the name now, not at release
- [ ] 0.7 Dependencies, in full:
      - root deps: `@modelcontextprotocol/sdk`, `zod`, `ajv`, `ajv-formats` (direct, not transitively through the SDK)
      - root dev: `vitest`, `typescript`, `eslint`, `typescript-eslint`, `tsx`, `@types/node`, `@eslint/js`. The last two are not optional: `src/` is entirely `node:http` / `node:crypto` / `process`, so typecheck fails on the first file without `@types/node`, and the `eslint.config.js` copied in 0.2 imports `@eslint/js` on its first line
      - `web/` deps: `react`, `react-dom`, `zustand`, `@tanstack/react-query`
      - `web/` dev: `vite`, `typescript`, `@types/react`, `@types/react-dom`, `@vitejs/plugin-react`, `tailwindcss@^4`, `@tailwindcss/vite`, **`vitest`**, `jsdom`, `@testing-library/react`, `@testing-library/user-event`, `eslint-plugin-react-hooks`
      - Memex's `web/` has no vitest, so copying its `package.json` leaves `test:web` with nothing to run
- [ ] 0.8 Branches `main` and `beta`. Protect `main` with a **ruleset** (classic protection on private repos needs Pro; rulesets avoid the question)
- [ ] 0.9 CI: `npm ci` **and `npm --prefix web ci`**, then typecheck, lint, test, `test:web`, `build:all`. **Node 20 and 24** (20 is the floor, 24 is the dev machine; testing neither is how you debug a version you never run). Add `.nvmrc` pinned to 24. Ubuntu and Windows on every PR; **macOS only on pushes to `beta`/`main`** (macOS minutes bill at 10x)
- [ ] 0.10 `ARCHITECTURE.md` stub with the tree above, `docs/adr/` dir

Gate: CI green on an empty-but-real repo, including the `web` legs, before any feature work.

### Phase 1: the fixture server first (1 day)

Build the test target before the thing under test. Everything downstream gets real.

- [ ] 1.1 `src/mcp/__fixtures__/echo-server.ts`: a real stdio MCP server. Spawned as `process.execPath` with `args: ["--import","tsx", fixtureUrl]`. Vitest transpiles test files in-process but not a path handed to `child_process.spawn`, and Node 20 cannot run `.ts` natively. **Resolve `fixtureUrl` from `import.meta.url` against the source tree, never from `dist/`**, since `tsconfig.build.json` excludes fixtures from emit. Node's loader ExperimentalWarning goes to stderr, so it does not corrupt the stdio protocol stream
- [ ] 1.2 Tools covering the schema spectrum: flat strings, numbers with min/max, booleans, enums, optional vs required, nested objects, arrays of objects, a tool returning `isError: true`, a tool that sleeps ~1s, a tool returning a large text blob, a tool returning a base64 image
- [ ] 1.3 A tool with a hostile schema (`oneOf`, deep nesting, `prefixItems`) to pin down what the form refuses to render
- [ ] 1.4 Enough tools to cross one `tools/list` page boundary, so pagination is actually exercised
- [ ] 1.5 One tool with `annotations: { destructiveHint: true }`
- [ ] 1.6 Smoke test: spawn, initialize, `tools/list`, assert the tool set

Gate: `npm test` spawns a real MCP server and talks to it.

### Phase 2: MCP client core, headless (3 days)

- [ ] 2.1 `ServerConfig` + zod schema: `stdio { command, args?, env?, cwd? }` and `http { url, headers? }`. `env`/`headers` values may be a literal (memory only) or `{ fromEnv: "NAME" }` (persistable)
- [ ] 2.2 `config.ts`: config-file zod schema, resolution order `--config` > `MCP_STUDIO_CONFIG` > `os.homedir()/.mcp-studio/config.json`. Literal secrets are stripped before write, per the decision above
- [ ] 2.3 `connect(serverId, config)`: build the transport, initialize, register the session. **The caller supplies `serverId`; `connect` does not mint one**
      - stdio: `env: { ...getDefaultEnvironment(), ...resolved }`. A bare `env` **replaces** the environment and the child loses `PATH`, `SystemRoot`, `APPDATA`, `COMSPEC`, which breaks every `npx` server on Windows
      - http: headers go in `opts.requestInit.headers`. `StreamableHTTPClientTransport` has no `headers` option
      - An SSE-only URL fails with a named error, not a crash. No silent fallback
- [ ] 2.4 `SessionRegistry: Map<serverId, { config, status, session?, lastError? }>` owned by the API process, so connections survive a browser refresh. `status` is `connected | connecting | failed | disconnected`, because the UI renders all four
- [ ] 2.5 `listTools(session)`: **loop on `nextCursor`** until exhausted, with a hard page cap. Normalise to `ToolDef = { name, title?, description?, inputSchema, outputSchema?, annotations? }`
- [ ] 2.6 `callTool(session, name, args, { callId, signal, timeout })` returns `{ content, structuredContent?, isError, ms }`. `ms` is measured by us; the SDK returns no timing. There is no `ok` field: `isError` is the single truth, and `isError: true` is a *successful* JSON-RPC response, not a throw. Pass an explicit `timeout` (default ~30s); the SDK default is 60s, which would outlive the 20s vitest budget
- [ ] 2.7 `normaliseContent(content)`: `content` is a union of `text | image | audio | resource | resource_link`. Emit a render model with explicit cases, base64 size caps and a truncation marker. Without this, 5.11 renders a 3MB base64 blob into the DOM and hangs the tab
- [ ] 2.8 Cancellation: **the client generates `callId` (crypto UUID) and sends it with the request.** The server registers an `AbortController` under it *before* issuing `callTool`. A server-minted id is useless, because `POST /call` does not resolve until the tool returns, so there would be nothing left to cancel
- [ ] 2.9 `disconnect` and cleanup. On win32, `kill('SIGTERM')` is a hard terminate that does not reach grandchildren, so an `npx` server leaks orphans: track the pid and use `taskkill /pid <pid> /T /F`. Best-effort cleanup in `afterAll` and on `process.on("exit")`
- [ ] 2.10 Error taxonomy, each distinguishable: spawn failed, initialize failed, transport dropped, tool returned `isError`, timeout, cancelled. Response-size cap configurable (stdio `maxBufferSize` defaults to 10MB and the transport errors and closes above it)
- [ ] 2.11 Integration tests against the fixture for every path above, including pagination, the slow tool, cancellation and the image tool
- [ ] 2.12 Write `ADR-0001` (transports), `ADR-0005` (stdio lifecycle, env inheritance, Windows kill), `ADR-0007` (config file and secret handling)

Gate: connect, list (paginated), call and cancel a real server from a test, with zero UI.

### Phase 3: schema to form model (1.5 days)

Pure functions, no React. This is where the product lives or dies.

- [ ] 3.1 `FormField` union: string, number, integer, boolean, enum, array, object, unsupported
- [ ] 3.2 `toFormModel(jsonSchema)`: walk the schema, emit ordered fields, carry `required`, `default`, `description`, constraints
- [ ] 3.3 Nested objects and arrays of objects, with a depth cap
- [ ] 3.4 Anything outside the subset becomes `{ kind: "unsupported", reason, path, rawSchema }`, rendered as raw JSON. The `reason` and `path` are what make it an escape hatch instead of a dead end ("oneOf at `/filters/0`, edit as raw JSON"). Never throw, never block the user
- [ ] 3.5 `toArgs(formState)`: build the payload, drop empty optionals, coerce types
- [ ] 3.6 Validation with **`Ajv2020` from `ajv/dist/2020`**, `{ allErrors: true, strict: false }`, plus `ajv-formats`. Read `validate.errors[].instancePath` to map each error back to its field. Do **not** use the SDK's `AjvJsonSchemaValidator`: it returns `{ valid, data, errorMessage: string }` with no `errors[]` and no `instancePath`, so per-field messages are impossible. And plain `new Ajv()` is draft-07, which throws on MCP's 2020-12 schemas and on `prefixItems`
- [ ] 3.7 Table-driven tests, one case per schema shape, driven off the fixture's tools
- [ ] 3.8 Write `ADR-0003`: the subset, the depth cap, the escape hatch, and Ajv2020 over the SDK wrapper

Gate: every fixture tool yields either a sane form model or an explicit `unsupported` with a reason.

### Phase 4: API + CLI (2 days)

- [ ] 4.1 **Port Memex's `writeGate` from `src/serve.ts:121`** and apply it to every mutating route: loopback TCP peer, loopback `Host` header (defeats DNS rebinding), same-origin `Origin`, `application/json` only, body-size cap. `POST /api/servers/:id/connect` spawns arbitrary child processes, so it is remote code execution by design; binding loopback does not stop a web page the owner visits from POSTing to it
- [ ] 4.2 Routes. Note `POST /api/servers` exists so a first connection is possible at all, and that disconnect and delete are separate verbs:
      - `GET /api/servers` (definitions plus `status`)
      - `POST /api/servers` (validate a `ServerConfig`, persist per 2.2, return `{ serverId }`)
      - `POST /api/servers/:id/connect`
      - `POST /api/servers/:id/disconnect`
      - `DELETE /api/servers/:id` (remove the definition, disconnecting first)
      - `GET /api/servers/:id/tools`
      - `POST /api/servers/:id/call` (body carries the client-generated `callId`)
      - `DELETE /api/servers/:id/call/:callId`
- [ ] 4.3 `toHttpError(err)`: one place mapping the 2.10 taxonomy to status codes
- [ ] 4.4 Serve `web/dist` from the API with an SPA fallback. Without this the installed binary serves a 404 and the product does not exist outside dev mode
- [ ] 4.5 Import an existing `mcpServers` block from a `claude_desktop_config.json` or `.mcp.json`. Twenty lines, large demo payoff
- [ ] 4.6 `cli.ts`: `mcp-studio serve [--port] [--config]`, plus `help`. Bind `127.0.0.1` only
- [ ] 4.7 Stdout for results, stderr for diagnostics. No `console.*` in `src/`, lint-enforced, same as Memex
- [ ] 4.8 API tests via direct handler calls, including **one test per `writeGate` rejection reason**
- [ ] 4.9 Write `ADR-0004` (`node:http`, flat `src/`) and `ADR-0006` (connect is RCE by design, the gate is the containment, and neither `env` nor headers are ever logged or echoed). ADR-0004 must argue *this* project's case, one process that spawns children and holds long-lived sessions, not restate Memex's ADR-0005, or a reviewer reading both repos sees a copy

Gate: `mcp-studio serve` runs, curl creates a server, connects, calls a tool, and a cross-origin POST is refused.

### Phase 5: UI shell and the 3 panes (4 days)

Dark-first, matching Memex's visual language so the portfolio reads as one body of work.

- [ ] 5.1 Vite + React + TS in `web/`, with its **own tsconfig** (the root one sets `lib: ["ES2022"]` with no DOM, which is correct only because `web/` keeps its own, as Memex does). Add `server.proxy` for `/api` in `web/vite.config.ts`, or the Phase 5 gate fails on CORS. Design tokens copied from Memex (tailwind v4 via `@tailwindcss/vite`)
- [ ] 5.2 `web/vitest.config.ts` with `environment: "jsdom"`, wired to `test:web` and CI. Per the decision above, `web/` gets its own flat eslint config with `eslint-plugin-react-hooks`, and the `lint` script covers it
- [ ] 5.3 State: **Zustand** for selection and form drafts, **TanStack Query** for server state (tools, collections). With N connections, per-tool form state and in-flight calls, this is worth naming rather than discovering. Record as `ADR-0008`
- [ ] 5.4 3-pane layout: left servers/tools tree, middle form, right response
- [ ] 5.5 Connect-server modal: transport toggle, stdio fields, http fields, validation, friendly spawn errors from a copy table keyed off the 2.10 taxonomy. Posts to `POST /api/servers` then `/connect`
- [ ] 5.6 Server list with the four `status` values from 2.4, plus disconnect and delete
- [ ] 5.7 Tool tree: searchable, shows description, shows `annotations` badges, manual refresh button
- [ ] 5.8 **Confirm dialog before firing any tool with `destructiveHint: true`.** For a Postman-like tool this is the one safety affordance a reviewer looks for
- [ ] 5.9 `FormRenderer`: one component per `FormField` kind, driven entirely by the Phase 3 model, recursive for nested objects and arrays. Per-field errors from `instancePath`
- [ ] 5.10 Raw JSON toggle: a `<textarea>` with `JSON.parse` validation on blur. Always available, always the escape hatch
- [ ] 5.11 Response pane: renders the 2.7 model (text, image, audio, resource), collapsible JSON viewer, status pill, duration, error rendering. Above the cap, show a truncation marker with "show more"
- [ ] 5.12 Cancel button for in-flight calls, sending the `callId` from 2.8
- [ ] 5.13 Accessibility: `<label for>` on every generated field, `aria-describedby` for description and error, `aria-invalid`, focus trap and `Escape` on the modal, roving tabindex on the tree, `aria-live` on the response status. Half a day, and for a product that *is* a generated form it is the cheapest credibility available
- [ ] 5.14 `Ctrl/Cmd+Enter` executes. Loading and empty states for all three panes
- [ ] 5.15 Component tests for `FormRenderer` across field kinds, plus the destructive-confirm gate

Gate (**manual walkthrough**, since v0.1 has no E2E layer): connect to the fixture in a browser, call a nested-object tool, cancel the slow tool, read an image response.

### Phase 6: Collections and checks (2 days)

- [ ] 6.1 Storage: one JSON file per collection under the 2.2 config dir. **Port Memex's `src/slug.ts`** (`slugify`, `assertSafeFilename`, Windows `RESERVED` names, `FORBIDDEN_CHARS`): collection ids are slugs, validated on every route. Unvalidated, `:id` from an HTTP path is a path-traversal write and delete primitive on a loopback server that already spawns processes
- [ ] 6.2 Save the current call (serverId, tool, args) into a collection. Secrets are not part of a saved call
- [ ] 6.3 Collections endpoints, **all mutating ones through the 4.1 `writeGate`**: `GET /api/collections`, `POST /api/collections`, `DELETE /api/collections/:id`, `POST /api/collections/:id/run`. Note the `:id` on delete: an unscoped `DELETE /api/collections` would wipe every collection. These live here, not in Phase 4, because the module they call does not exist until now
- [ ] 6.4 Collections drawer: list, select, load a saved call back into the form
- [ ] 6.5 Assertion model, deliberately small: `isError` is false, a JSON path equals a value, response contains text, duration under N ms. **JSON-path assertions run against `{ content, structuredContent, isError }`**, and `structuredContent` is the interesting target for a server with an `outputSchema`. Resolver is ~15 lines, no dependency
- [ ] 6.6 Run one saved call, show pass/fail naming the failing assertion. Run all, show a summary row. A saved call whose server is not connected **fails the row with a named reason**, no implicit auto-connect
- [ ] 6.7 Assertion evaluator unit tests, a failing case per assertion kind, plus **one slug-rejection test** per 6.1
- [ ] 6.8 Write `ADR-0002`: collections as JSON files, no database, and why the assertion set stays this small

Gate: save a call, break the server, re-run, see a red badge naming the assertion.

### Phase 7: ship it (2 days)

- [ ] 7.1 README: what it is, one screenshot, install, quickstart, the features, the deferred roadmap, the known limits, link to ARCHITECTURE. Three lines on dev setup instead of a `CONTRIBUTING.md`
- [ ] 7.2 Demo GIF: connect, pick a tool, fill the form, call, pass/fail in a collection
- [ ] 7.3 `ARCHITECTURE.md` filled in properly. For a portfolio repo, README and ARCHITECTURE are the product
- [ ] 7.4 Secrets pass: a test proving `env` values and HTTP headers never appear in API responses, logs or saved collections
- [ ] 7.5 Release workflow: tag to GitHub release plus npm publish. The job must run `npm --prefix web ci` too, because `prepack` runs `build:all`; verify the pack contains `web/dist`
- [ ] 7.6 CodeQL workflow
- [ ] 7.7 Merge `beta` into `main`, tag `v0.1.0`

## Git flow

- Feature branches `feat/...` or `fix/...`, PR into `beta`
- `beta` to `main` only for releases, via PR
- One PR per phase, or per task when a phase runs long
- Conventional commit subjects
- Identity: Ron Masuary <ronmas2@gmail.com>. No Claude attribution trailers on any commit or PR
- `main` protected by ruleset: CI must pass

## Testing strategy

| Layer | How | Why |
|---|---|---|
| `src/mcp` | integration against `src/mcp/__fixtures__/echo-server.ts` | a mocked MCP client proves nothing |
| `src/schema` | table-driven unit tests | the risky logic, cheapest to test |
| `src/collections` | unit tests per assertion kind, plus slug rejection | must fail correctly, not just pass |
| API | direct handler calls, plus one per gate rejection | the gate is the security story |
| UI | Vitest + jsdom + Testing Library on `FormRenderer` | the only UI logic worth testing |

Rule: no mocking of the MCP protocol anywhere. The fixture server is cheap, so use it.
End-to-end is deliberately out of v0.1, and the Phase 5 gate is a labelled manual walkthrough:
promising a Playwright suite and not scheduling it is worse than scoping it out.

## ADR index

| ID | Decision | Written in |
|---|---|---|
| 0001 | Transports: stdio + streamable HTTP, no SSE-only fallback | 2.12 |
| 0002 | Collections as JSON files, no database, minimal assertion set | 6.8 |
| 0003 | JSON Schema subset, depth cap, escape hatch, Ajv2020 over the SDK wrapper | 3.8 |
| 0004 | `node:http` and a flat `src/`, no framework, argued for this project | 4.9 |
| 0005 | stdio lifecycle, env inheritance, Windows process-tree kill | 2.12 |
| 0006 | Connect is RCE by design: the loopback gate, and secrets never echoed | 4.9 |
| 0007 | Config file location and format, and why secrets never persist | 2.12 |
| 0008 | UI state: Zustand plus TanStack Query | 5.3 |

ADR-0001 must be precise: what was deprecated is the HTTP+SSE transport of protocol
revision 2024-11-05, superseded by Streamable HTTP in 2025-03-26. "SSE" as a mechanism is
not deprecated (Streamable HTTP uses it for the server-to-client stream, and `client/sse.js`
still ships). A reviewer who knows MCP will notice the difference.

## How to build this fast and well

1. **Steal Memex's skeleton, but read it first.** Copy the configs and CI, and check what they
   include: `vitest.config.ts` collects only `src/**/*.test.ts`, `tsconfig.json` sets
   `rootDir: src`, and `web/` has no vitest at all. Copying blind is how you get a test suite
   that silently collects nothing.
2. **Fixture server before features.** Phase 1 before Phase 2 is the highest-leverage ordering
   choice here. It makes every later test real and fast.
3. **Headless before pixels.** Finish Phases 2 and 3 with zero UI. When the UI arrives it renders
   real data on day one, so there is no throwaway mock layer.
4. **Timebox the schema work.** Phase 3 is the only place that can swallow a week. The
   `unsupported` plus raw-JSON hatch is what keeps it bounded. Ship the subset.
5. **Read the SDK's types before planning around them.** `callTool` returns
   `{ content, structuredContent?, isError? }`, not a convenient `{ ok, ms }`, and the bundled
   ajv wrapper cannot give per-field errors. Assuming both shapes was the biggest error in v1.
6. **Port the loopback gate on day one of Phase 4.** It already exists in Memex. It is also the
   strongest "this person thinks about security" signal in the whole repo.
7. **One PR per phase.** Reviewable units, and the git history reads as a deliberate build.
8. **Say no in public.** Put the deferred roadmap and the known limits in the README. Scope
   discipline reads as seniority.
9. **Dark-first, one theme.** Memex went dark-only after a triage pass. Do not relitigate it.

## Memex dogfood

Log each ADR and each phase completion to Memex under project `mcp-studio`, with a stable
`key` for single-value facts (`transport-choice`, `collections-storage`, `schema-subset`).
Cross-project decisions, above all the `src/mcp` boundary contract that Firewall and Vault
will inherit, go under project `hype-projects`.

## Estimate

**16 to 18 focused days** to a tagged, public v0.1. The per-phase table below sums to 16.5,
and the ADR writing is the balance. Earlier drafts of this plan said 7 to 8, then 13 to 16,
while the table already said otherwise. The table is the honest number.

| Phase | Days |
|---|---|
| 0 groundwork | 1 |
| 1 fixture server | 1 |
| 2 client core | 3 |
| 3 schema to form | 1.5 |
| 4 API + CLI | 2 |
| 5 UI | 4 |
| 6 collections | 2 |
| 7 ship | 2 |

Phase 2 is three days, not two: Windows process-tree kill, content normalisation across five
kinds, the end-to-end cancellation path and a twelve-path integration suite where every case
spawns a real `node --import tsx` child are each half-day-class on their own. Phase 5 is four
days because a recursive form renderer, a validated modal, an annotated tree, five content
kinds and accessibility is not a day and a half.

**The eight ADRs are roughly one extra day of writing, spread across phases.** That is priced
into the range above rather than absorbed silently.
