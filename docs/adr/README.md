# Architecture decision records

One file per decision, named `NNNN-short-title.md`. Each is written in the phase noted below.
Status is `accepted` once the file exists and the code it describes is on `beta`, and `planned`
while there is no file yet. Only accepted entries link anywhere.

| ID | Decision | Written in | Status |
|---|---|---|---|
| [0001](0001-transports.md) | Transports: stdio and streamable HTTP, no SSE-only fallback | Phase 2 (2.12) | accepted |
| 0002 | Collections as JSON files, no database, minimal assertion set | Phase 6 (6.8) | planned |
| [0003](0003-schema-subset.md) | JSON Schema subset, depth cap, escape hatch, Ajv2020 over the SDK wrapper | Phase 3 (3.8) | accepted |
| 0004 | `node:http` and a flat `src/` | Phase 4 (4.9) | planned |
| [0005](0005-stdio-lifecycle.md) | stdio lifecycle, env inheritance, Windows process-tree kill | Phase 2 (2.12) | accepted |
| 0006 | Connect is RCE by design: the loopback gate, and secrets never echoed | Phase 4 (4.9) | planned |
| [0007](0007-config-and-secrets.md) | Config file location and format, and why secrets never persist | Phase 2 (2.12) | accepted |
| 0008 | UI state: Zustand plus TanStack Query | Phase 5 (5.3) | planned |
