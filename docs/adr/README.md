# Architecture decision records

One file per decision, named `NNNN-short-title.md`. Each is written in the phase noted below.

| ID | Decision | Written in |
|---|---|---|
| 0001 | Transports: stdio and streamable HTTP, no SSE-only fallback | Phase 2 (2.12) |
| 0002 | Collections as JSON files, no database, minimal assertion set | Phase 6 (6.8) |
| 0003 | JSON Schema subset, depth cap, escape hatch, Ajv2020 over the SDK wrapper | Phase 3 (3.8) |
| 0004 | `node:http` and a flat `src/` | Phase 4 (4.9) |
| 0005 | stdio lifecycle, env inheritance, Windows process-tree kill | Phase 2 (2.12) |
| 0006 | Connect is RCE by design: the loopback gate, and secrets never echoed | Phase 4 (4.9) |
| 0007 | Config file location and format, and why secrets never persist | Phase 2 (2.12) |
| 0008 | UI state: Zustand plus TanStack Query | Phase 5 (5.3) |
