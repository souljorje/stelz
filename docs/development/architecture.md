---
title: "Architecture"
description: "Components, request path, browser lifetime, saved state, MCP contracts, and failure layering, to read before you change service boundaries."
tags: [development, architecture]
sources: []
created: 2026-11-06T13:49:16Z
modified: 2026-11-11T14:55:54Z
---

# Architecture

How Stelz works. For what it is, see [Stelz as a product](../product.md). Also: [transactions](transactions.md), [UI session](ui-session.md), [source layout](source-layout.md).

## Technology

| Part | Role |
| --- | --- |
| Camoufox | Firefox-based browser build with fingerprint controls. See [Browser executable](../configuration/environment.md#browser-executable). |
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

1. The adapter validates the handle ([Control handles](../mcp.md#control-handles)).
2. It forwards the canonical browser arguments and private service control data to `/local-profile/tool`.
3. The plugin checks the tool and controller. It queues the operation for that profile.
4. The plugin checks browser availability and performs any required IP check.
5. The upstream dispatcher calls the corresponding Camofox HTTP route on the same local service.
6. Camofox executes the action through Playwright. The response adapter returns text or image content.

## Browser lifetime and controllers

- Each active profile has its own supervisor and Camofox server, with at most one browser instance.
- The supervisor runs separately from the client. Closing a chat or UI session preserves the browser.
- Startup locks, service instance IDs, and process start records prevent competing starts from replacing an existing browser.
- Controller and action queue per profile: [Control handles](../mcp.md#control-handles).
- The call's profile ID also supplies Camofox's `userId`. The tab group stays `default` across connections.
- After a client crash, acquisition can clear the controller when the client process is dead and no actions remain.
- Pause blocks browser actions while a human uses the same window.
- An explicit stop ends the browser lifetime.

## Persistent state and device properties

- Storage selection: [Service directory and precedence](../configuration/environment.md#service-directory-and-precedence).
- Storage paths, the fingerprint record, and startup checks: [Files and private state](../configuration/profiles.md#files-and-private-state).
- On restart, Stelz reuses saved device properties and keeps the current language, location, and security policy.
- Saved device data cannot replace current add-on paths, session history, or Firefox security preferences.
- Saved settings do not guarantee identical observable output. For example, canvas hashes can vary.

## MCP contracts

- An HTTP capability reaches a client only when a tool schema, dispatcher, and response adapter expose it.
- Browser tools keep the canonical Camofox arguments and add `profileId` and `controlHandle`.
- The adapter excludes some upstream controls. See [Shared MCP tools](../mcp.md).
- `camofox_type` has per-call modes. See [Typing](../configuration/typing.md).
- A new control must use controller checks, the action queue, network checks, and the service time limit.
- An upstream HTTP endpoint alone does not establish Stelz MCP support.

## Failures and network policy

- Each outer layer waits longer than the layer that it calls, so the innermost limit reports first. Limits and timeout effects: [Typing](../configuration/typing.md).
- IP check effects: [IP check policy](../configuration/network.md#ip-check-policy).
- The plugin rejects replacement browsers and sessions within an existing service lifetime.
- An operator must resolve uncertain ownership before another start. See [Troubleshooting](../troubleshooting/index.md).
