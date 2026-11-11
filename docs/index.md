---
title: "Stelz documentation"
description: "Entrypoint that lists every Stelz guide, reference page, and contributor document by task."
tags: [documentation]
sources: []
created: 2026-11-02T15:09:08Z
modified: 2026-11-11T14:27:18Z
---

# Stelz documentation

Stelz runs persistent browser profiles that a coding agent controls through MCP.

## Start

- [Stelz as a product](product.md) — what Stelz is, its rules, and its limits.
- [Getting started](getting-started.md) — install Stelz, run setup, and start your first profile.
- [Agent setup](bootstrap.md) — let a coding agent install Stelz and connect its tools.

## Use

- [Connect your agent](clients.md) — register Codex, Claude Code, or Hermes, and install the browser skill.
- [Manage profiles](ui.md) — create, start, rename, and delete profiles, find their windows, and take over manually.
- [Configure a proxy](proxies.md) — route a profile through a proxy, or require an exit IP.
- [Transfer profiles](profile-transfer.md) — export and import saved browser data.
- [Troubleshooting](troubleshooting/index.md) — symptom table and lifecycle actions.
  - [Setup](troubleshooting/setup.md) · [Control](troubleshooting/control.md) · [Network](troubleshooting/network.md) · [Lifetime and state](troubleshooting/lifetime-and-state.md) · [UI and transfer](troubleshooting/ui-and-transfer.md)

## Reference

- [CLI](cli.md) — commands, options, outputs, and exit status.
- [Configuration](configuration/index.md) — settings and saved data.
  - [Environment](configuration/environment.md) · [Profile data](configuration/profiles.md) · [Typing](configuration/typing.md) · [IP checks and location](configuration/network.md) · [Archive format](configuration/archive.md)
- [Shared MCP tools](mcp.md) — the 18 tools and the control-handle contract.
- [Browser skill](../skills/stelz-browser/SKILL.md) — how an agent uses the tools.

## Contribute

- [Development](development/index.md) — for contributors.
  - [Architecture](development/architecture.md) · [Testing](development/testing.md) · [Acceptance](development/acceptance.md) · [Camofox integration](development/camofox-integration.md) · [Releasing](development/releasing.md)
- [Contributing](../CONTRIBUTING.md) — how to prepare and submit a change.
