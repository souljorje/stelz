---
title: "Architecture"
description: "Service design: request path, browser lifetime, controller ownership, state, transactions, UI session, and source layout, to read before you change service boundaries."
tags: [development, architecture]
sources: []
created: 2026-11-06T13:49:16Z
modified: 2026-11-11T14:27:18Z
---

# Architecture

How Stelz works. For what it is, see [Stelz as a product](../product.md).

## Technology

| Part | Role |
| --- | --- |
| Camoufox | Firefox-based browser build with fingerprint controls. See [Browser executable](../configuration.md#browser-executable). |
| `camoufox` launcher | Official JavaScript launcher. Generates fingerprints and launch options, including GeoIP location settings. |
| Camofox (`@askjo/camofox-browser`) | HTTP automation server. Drives Camoufox through Playwright. Stelz patches it. See [Camofox integration](camofox-integration.md). |
| Playwright (`playwright-core`) | Browser automation library inside Camofox. |
| Stelz | CLI, MCP adapter, supervisor, profile plugin, and local UI. |

- Bun runs the CLI, MCP adapter, supervisor, and local UI server. Node.js runs Camofox and the profile plugin.
- Client: reasoning and conversation history. Service: browser state and exclusive control.

## Request path

- Stelz MCP adapter: routes each call by profile ID.
- Camofox server: automates the Camoufox browser through Playwright.
- Stelz profile plugin: runs inside Camofox. Enforces controller ownership, serializes actions, checks network state, preserves the original browser context.
- `camoufox` launcher: supplies `launchOptions()` before Playwright starts the browser.

A browser tool call:

1. The adapter checks `profileId` and `controlHandle` against that connection's current acquisition and browser lifetime.
2. It forwards the canonical browser arguments and private service control data to `/local-profile/tool`.
3. The plugin checks the tool and controller. It queues the operation for that profile.
4. The plugin checks browser availability and performs any required IP check.
5. The upstream dispatcher calls the corresponding Camofox HTTP route on the same local service.
6. Camofox executes the action through Playwright. The response adapter returns text or image content.

## Browser lifetime and controllers

- Each active profile has its own supervisor and Camofox server, with at most one browser instance.
- The supervisor runs separately from the client. Closing a chat or UI session preserves the browser.
- Startup locks, service instance IDs, and process start records prevent competing starts from replacing an existing browser.
- Each profile has one controller and its own action queue. Separate profiles run actions concurrently, including through one connection.
- The call's profile ID also supplies Camofox's `userId`. The tab group stays `default` across connections.
- Release waits for queued operations before it relinquishes control.
- Disconnect releases control without closing pages.
- After a client crash, acquisition can clear the controller when the client process is dead and no actions remain.
- The next controller receives the same live browser state. Conversation history stays with the previous client.
- Pause blocks browser actions while a human uses the same window. Resume checks required network state first.
- An explicit stop ends the browser lifetime. Closing the browser window also stops the profile.

## Persistent state and device properties

- `STELZ_HOME` selects the service directory. The workspace, client PID, and conversation ID never select browser storage.
- New profiles use native Firefox storage under `profiles/ID/browser-data/`.
- `fingerprint.json` records selected device properties and the browser executable hash.
- On restart, Stelz reuses those properties and keeps the current language, location, and security policy.
- Saved device data cannot replace current add-on paths, session history, or Firefox security preferences.
- A changed executable or invalid fingerprint record blocks startup. Create a new profile for another browser.
- Saved settings do not guarantee identical observable output. For example, canvas hashes can vary.

## Catalog and network transactions

- `prepareProfileConfiguration()` in `src/profiles/profile-configuration.ts` handles every configuration mutation.
- It holds `profiles/admission.lock` under `STELZ_HOME` while it completes pending recovery and the requested mutation.
- Recovery checks the import, catalog, and network journals in that order. See [Transactions and recovery](../configuration.md#transactions-and-recovery).
- An operation that needs a profile lifecycle lock acquires it after the admission lock.
- Explicit start also completes pending configuration recovery before it starts the browser.
- Creation saves new secrets before it publishes the profile in the catalog. The catalog journal stores complete before and after snapshots.
- CLI creation can reuse a compatible profile without changing its ID, port, storage, or secret references.
- Deletion needs a cleanly stopped profile with known process ownership.
  - It archives the profile directory under `trash/ID-TOKEN/profile/` and its configuration in `profile.json`, then removes the profile from the catalog.
  - It retains secrets, because other profiles can reference them.
- A network save needs the current revision and a stopped profile. The backend repeats ownership and configuration checks while it holds both locks.
- Network commit writes configuration and secrets through checked temporary files and atomic replacement.
  - If a write fails, the journal records rollback intent before restoration.
  - Recovery continues the recorded commit or rollback.
  - Manual edits that match neither recorded state block recovery and need inspection.
- Journals can contain credentials. Treat them as private service state.

## Profile transfers

- Export snapshots cleanly stopped profiles under the admission lock and selected lifecycle locks, acquired in profile ID order.
- Export releases those locks before compression. Export never stops a browser.
- Import checks private staging data, assigns unused IDs, ports, and secret references, and installs the batch through a durable journal.
- One catalog replacement publishes the batch. Imported profiles remain stopped. Existing profiles stay unchanged.
- An active UI transfer prevents UI shutdown.
- See [Archive schema and limits](../configuration.md#archive-schema-and-limits).

## MCP contracts

- An HTTP capability reaches a client only when a tool schema, dispatcher, and response adapter expose it.
- Camofox shares its MCP contracts with its OpenClaw plugin. Stelz reuses them through its own adapter and does not run OpenClaw.
- Browser tools keep the canonical Camofox arguments and add `profileId` and `controlHandle`.
- The adapter excludes `camofox_evaluate` and `camofox_import_cookies`. See [Shared MCP tools](../mcp.md).
- `camofox_type` has per-call modes. See [Typing](../configuration.md#typing).
- A new control must use controller checks, the action queue, network checks, and the service time limit.
- An upstream HTTP endpoint alone does not establish Stelz MCP support.

## Failures and network policy

- Each outer layer waits longer than the layer that it calls, so the innermost limit reports first. Limits: [Typing](../configuration.md#typing).
- A timeout blocks subsequent actions, because the original operation may remain active.
- An MCP client timeout does not cancel the service operation.
- After a blocked browser operation, the operator must stop and start the profile. Stelz does not replay interrupted actions. See [Browser action or IP check timed out](../troubleshooting.md#browser-action-or-ip-check-timed-out).
- The plugin rejects replacement browsers and sessions within an existing service lifetime.
- An operator must resolve uncertain ownership before another start. See [Troubleshooting](../troubleshooting.md).
- Browser IP checks share the action queue. A failed check blocks actions until an explicit recheck succeeds.
- The service does not replay the failed action. IP checks provide no host firewall. See [IP check policy](../configuration.md#ip-check-policy).

## Local UI HTTP session

- The Hono API runs on Bun at `127.0.0.1`. The React application uses the same origin.
- Each UI server generates an independent bootstrap token and session secret.
- The launch URL carries the token in the fragment. The UI sends it to `POST /api/session`, then removes the fragment.
- The server consumes the token once. It sets an HttpOnly, `SameSite=Strict` cookie scoped to `/`. The cookie name includes the UI port.
- Every request must use the exact configured host and port.
- API requests reject a supplied foreign origin. API methods other than GET and HEAD require the exact UI origin.
- All API routes except session exchange require the session cookie.
- The session secret and profile access keys are separate credentials.
- Browser service keys and saved proxy credentials stay on the backend.
- UI models redact credentials before they apply display limits.
- `POST /api/shutdown` refuses shutdown while work remains active.
- Successful shutdown invalidates the session, expires the cookie, and stops the UI server. It preserves running browsers.
- Showing a browser window preserves its controller. Human takeover still requires pause. See [Find a profile's windows](../ui.md#find-a-profiles-windows).
- The UI imports types from `src/api/contracts.ts` and `src/api/transfer-contracts.ts`. At runtime it imports only the pure helpers `profileAppearance` and `src/profiles/proxy-input.ts`. Server runtime modules stay on the backend.

## Source layout and runtime updates

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

## Related

- [Testing](testing.md) - Routine checks and CI.
- [Acceptance](acceptance.md) - Commands for browser, package, proxy, and human acceptance checks.
