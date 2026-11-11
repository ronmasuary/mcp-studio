# ADR-0005: stdio lifecycle, environment inheritance and the Windows process-tree kill

Status: accepted (Phase 2, task 2.12)

## Context

A stdio connection is a child process. Three things about that go wrong in practice, and two of
them only on Windows, which is half of the CI matrix.

1. **`env` replaces the environment.** `StdioServerParameters.env`, when given, is the child's whole
   environment. A user who adds one variable, `{ API_KEY: "..." }`, silently strips `PATH`,
   `SystemRoot`, `APPDATA` and the rest of the SDK's inherited allow-list, and every `npx`-launched
   server stops starting on Windows.
2. **Killing the parent does not kill the tree.** `npx some-server` is `npx`, then `node`, then the
   server. On win32, `child.kill("SIGTERM")` is an unconditional terminate of that one pid and does
   not reach descendants, so closing a connection leaves the real server running as an orphan.
3. **Nothing is guaranteed to run at the end.** If the API process exits without disconnecting,
   children keep running unless something reaps them.

The SDK's `transport.pid` is also null once the child has exited, which is exactly when cleanup
needs it.

## Decision

### Environment

The child's environment is always `{ ...getDefaultEnvironment(), ...resolved }`, where
`getDefaultEnvironment()` is the SDK's allow-list of safe inherited variables (`PATH`, `HOME`,
`SystemRoot`, `APPDATA` and so on) and `resolved` is the user's `env` after resolving
`{ fromEnv: "NAME" }` references against the host environment (`resolveValues`). A reference to an
unset variable fails `connect` with `config_invalid`; the message names the variable and never a
value. A literal that the user typed is passed straight through for that session (ADR-0007).

On win32 that allow-list is `APPDATA`, `HOMEDRIVE`, `HOMEPATH`, `LOCALAPPDATA`, `PATH`,
`PROCESSOR_ARCHITECTURE`, `SYSTEMDRIVE`, `SYSTEMROOT`, `TEMP`, `USERNAME`, `USERPROFILE` and
`PROGRAMFILES`. It does not include `COMSPEC`: cross-spawn reads that from the parent process's own
environment rather than the child's, so `.cmd` shims such as `npx` still resolve without it.

The host's full environment is deliberately not inherited. Passing everything would hand the child
every credential in the user's shell, which is the opposite of what a tool that runs arbitrary
servers should do.

### Spawn and handshake

- Before spawning, the command is resolved on the child's `PATH` (with `PATHEXT` on Windows). The
  SDK spawns through cross-spawn, and on Windows a missing command surfaces as a `cmd.exe` child that
  prints "not recognized" and exits, which looks like a failed handshake. The pre-check keeps
  `spawn_failed` (nothing started: missing command, bad `cwd`) distinguishable from
  `initialize_failed` (a process started but did not complete MCP `initialize`) on every platform.
- The initialize request has its own deadline (15 seconds by default) instead of the SDK's 60.
- stderr is piped and its last 4 KiB is kept. It is appended to `initialize_failed` and
  `transport_dropped` messages, because "the server printed a stack trace" is the single most useful
  fact when a handshake fails.
- The pid is recorded the moment the process spawns, by a subclass of `StdioClientTransport`, and
  tracked in a set for the exit hook.

### Disconnect

`closeSession` does, in order:

1. Mark the session `closing`, so the registry knows this was not a drop.
2. Close the SDK client, which ends the child's stdin. A well-behaved server exits.
3. Wait up to 1.5 seconds for that. If the child is still alive, kill its **whole tree**:
   `taskkill /pid <pid> /T /F` on win32, and SIGKILL down a `pgrep -P` walk of descendants on POSIX.
4. Untrack the pid.

`killTree` is synchronous so that it can run inside a `process.on("exit")` handler, where nothing
asynchronous runs. The same function runs for every tracked pid on process exit, and after a failed
or timed-out connect.

### Why the graceful step comes first

`taskkill /T` finds descendants by walking parent pids from a live process. If the parent has
already exited, its children are no longer reachable that way. Ending stdin first lets a cooperative
server shut down cleanly with its own cleanup, and the tree kill is the backstop for the launcher
that ignores it, which is the case where the parent is still alive and the tree is intact.

## Consequences

- On Windows, libuv assigns ordinary children to a job object that is killed when the parent node
  process exits. That covers a crash of the API process for children that are not detached, but not
  a disconnect while the API keeps running, and not a grandchild that escaped the job. The
  tree kill is what covers those, and the lifecycle tests use a detached grandchild so that they
  cannot pass on the job object alone.
- If a launcher exits on its own while leaving a detached grandchild behind, the pid chain is broken
  and the grandchild cannot be found from the recorded pid. This is a limit of pid-based tracking.
  It is accepted: the common launchers (`npx`, `uvx`, `node`, `python`) outlive their server.
- `process.on("exit")` does not run on SIGKILL or a hard crash of the API process itself. On POSIX
  that can leave children behind; their stdin closes, which ends well-behaved servers.
- Tests cover each claim against real processes: a fixture launcher that ignores stdin closing and
  keeps a detached grandchild, a probe process that exits without disconnecting, a hung handshake
  that must not leak its child, and an unset-variable reference. Mutating `killTree` or the exit hook
  out makes the corresponding test fail.
