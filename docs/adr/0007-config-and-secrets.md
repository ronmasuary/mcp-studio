# ADR-0007: Config file location and format, and why secrets never persist

Status: accepted (Phase 2, task 2.12)

## Context

MCP Studio remembers server definitions between runs, and a server definition often needs a
secret: an API key in a stdio server's `env`, a bearer token in an HTTP server's `headers`. A config
file in a home directory is routinely synced, backed up, pasted into bug reports and committed by
accident. A tool whose whole job is connecting to other people's servers should not be a place
where those secrets pile up in plain text.

## Decision

### What `env` and `headers` values can be

A value is one of two things.

- **A literal string**, typed into the connect modal. It lives in memory for that session. It is
  never written to disk.
- **`{ "fromEnv": "NAME" }`**, a reference to an environment variable by name. It is resolved at
  connect time against the host environment and is safe to persist, because the file holds a
  variable name and not a value.

```json
{
  "version": 1,
  "servers": {
    "github": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "some-github-server"],
      "env": { "GITHUB_TOKEN": { "fromEnv": "GITHUB_TOKEN" } }
    }
  }
}
```

### Stripping, enforced twice

1. `stripSecrets` removes every literal from `env` and `headers` before a write, and reports the
   dotted names it removed (`env.API_KEY`) so a caller can tell the user that a value was not saved.
2. The write then validates the result against a **persisted** schema in which `env` and `headers`
   can only hold `{ fromEnv }`. A literal cannot be expressed in that shape, so even a regression in
   step 1 fails the write with an exception instead of putting a secret on disk.

The same schema validates on read. A hand-edited file with a literal in it is rejected with a
`ConfigError`, not accepted and re-saved. A file that is invalid is never silently reset to empty.

### Location

Resolved in this order, first non-empty wins:

1. the `--config` command line flag,
2. the `MCP_STUDIO_CONFIG` environment variable,
3. `os.homedir()/.mcp-studio/config.json`.

A missing file is an empty config. The directory is created on first write. Writes are atomic
(temp file, then rename) and the file is created with mode `0600` on POSIX.

### Format

`{ version, servers }`, where `servers` is keyed by `serverId`. The caller of `connect` supplies the
id, and the config file keys on the same id. `version` is 1. An unknown version is an error rather
than a guess.

## Consequences

- A user who types a token into the modal gets a working session and no saved token. After a
  restart the server is listed but needs the value again, or a `fromEnv` reference. That is the
  intended trade: convenience for the session, safety at rest.
- Only `env` and `headers` are treated as secret-bearing. `args` and `url` are persisted verbatim,
  so a token passed as `--token abc` or as a URL query string would be written. The connect UI
  (Phase 5) should steer secrets into `env` and `headers`, and the README says plainly that `args`
  and `url` are not scrubbed.
- Collections (Phase 6) store a call's server, tool and arguments, never connection secrets.
- The API layer (Phase 4) must not echo `env` or header values in responses or logs. That is
  ADR-0006's concern and is tested in Phase 7. `SessionRegistry` entries hold the resolved-at-use
  config in memory, including literals, so any code that serialises an entry has to go through a
  redacting step.
- Tests write real files into a temp directory and assert on the bytes on disk, including that a
  literal secret string appears nowhere in the written file.
