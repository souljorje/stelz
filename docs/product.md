---
title: "Stelz as a product"
description: "What Stelz is, who it serves, what it does, and what it deliberately does not do."
tags: [product, overview]
sources: []
created: 2026-11-11T14:27:18Z
modified: 2026-11-11T14:27:18Z
---

# Stelz as a product

Persistent browser profiles that a coding agent controls and a person can take over.

## For whom

- People who run a local coding agent, such as Claude Code, Codex, or Hermes, and need it to use websites.
- Tasks that need a lasting identity: logins, cookies, saved device settings, a fixed network route.

## What it does

- **Profile:** one persistent browser identity. Logins, storage, saved device settings, optional proxy.
- **One browser per profile:** a visible window on the desktop.
- **Agent control:** one `stelz mcp` registration. 18 fixed tools. One connection controls many profiles.
- **Exclusive control:** one controller per profile. Handoff by release. The browser and its pages stay open.
- **Human takeover:** the agent pauses. A person works in the same window. The agent resumes.
- **Network:** optional proxy or expected exit IP. Location settings follow the exit. Checked before the agent gets control. No direct fallback.
- **People's tools:** a local UI and a CLI to create, start, stop, configure, transfer, and recover profiles.
- **Transfer:** export and import profiles between matching installations.

## Rules

- Standalone: runs without an agent harness or model credentials. Reasoning and conversation history stay in the client.
- No agent framework, reasoning loop, plugin framework, or fleet platform.
- No global limits on browsers, saved profiles, or agents.
- Explicit lifecycle. Only Start opens a browser. Only Stop, a restart, or closing the window ends it. Release and disconnect keep it running.
- Agents cannot change configuration or proxies, delete, import, stop, recover, or force a handoff. People do that in the UI or CLI.
- Agents act on fresh observations and never repeat an uncertain action.
- People complete authentication in the same window. Stelz does not bypass challenges.
- No website-specific task scripts.
- Downloads happen only in `stelz setup`, never during Start or an MCP call.
- No compatibility with earlier Stelz versions or their data.

## Not

- Not an agent. It does not decide what to do.
- Not a promise that websites cannot detect automation.
- Not a remote or multi-machine service. Browsers run on the local desktop. Browser Start requires macOS.

## Related

- [Architecture](development/architecture.md) — how the components implement these rules.
