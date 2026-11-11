---
title: "Source layout and runtime updates"
description: "Source directories and the runtime generation model, to read before you move code or change setup activation."
tags: [development, architecture, runtime]
sources: []
created: 2026-11-11T14:53:45Z
modified: 2026-11-11T15:01:55Z
---

# Source layout and runtime updates

| Directory | Responsibility |
| --- | --- |
| `src/cli/` | Command parsing and user operations. |
| `src/profiles/` | Configuration, profile archives, transactions, and secret references. |
| `src/runtime/` | Process ownership, locks, lifecycle operations, and supervision. |
| `src/mcp/` | MCP transport, tool policy, and controller ownership. |
| `src/browser/` | Camofox integration, persistent contexts, device properties, typing, and IP checks. |
| `src/api/` | UI endpoints, models, and transfer jobs. |
| `ui/src/` | The React interface. |

- Setup stages the prepared dependencies and plugin as a runtime generation under `STELZ_HOME/runtime-generations/`.
- Setup does not clone upstream source, apply patches, or modify a configured Camoufox app.
- The generation ID comes from the setup inputs, so setup reuses an unchanged generation.
- Setup switches the `runtime` link atomically under the admission lock. It holds that lock only to create service files and to switch the link.
- Start rejects an installed plugin that differs from the current package.
- Start pins each service to its generation through `STELZ_RUNTIME` and records the generation, so a running browser never sees a newer runtime.
- Status reports `restartToUpdate` for a service on an older generation.
- Setup removes generations that no running service uses.
- An earlier plain `runtime/` directory blocks setup while any profile runs.
- See [Camofox integration](camofox-integration.md) and [Run Stelz from a checkout](../../CONTRIBUTING.md#run-stelz-from-a-checkout).
