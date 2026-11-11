---
title: "Installation and setup problems"
description: "Recovery when installation, the runtime, or setup fails, and how to apply an update to running profiles."
tags: [troubleshooting, setup]
sources: []
created: 2026-11-06T13:49:16Z
modified: 2026-11-11T15:01:55Z
---

# Installation and setup problems

## Installation or runtime fails

1. Missing command: run `command -v stelz bun node`. Install the missing executable (see [What you need](../getting-started.md#what-you-need)) or add its `bin` directory to PATH. Use the same paths in the agent's MCP environment.
2. Run `stelz doctor` with the intended `STELZ_HOME`. Check `home`, `setup`, `node`, and `browserExecutable`.
3. If the CLI, UI, and MCP connection select different directories, correct their environments. See [Service directory precedence](../configuration/environment.md#service-directory-and-precedence).
4. Run `stelz setup` with the same service directory. It prepares a missing browser, runtime, or plugin and keeps existing profiles.
5. Run `stelz status` to find existing IDs. Create a missing `work` profile through [Getting started](../getting-started.md).

- Setup does not recover profiles in another service directory.
- Do not remove profiles or reinstall Camoufox to repair a missing Bun command.
- Unsupported Camoufox build: check `CAMOUFOX_EXECUTABLE` in the process environment and in `STELZ_HOME/secrets.env`. Remove it or point it to the paired build, then run `stelz setup`. See [Browser executable](../configuration/environment.md#browser-executable).

## Setup fails

| Message or code | Action |
| --- | --- |
| `confirmation_required` | See [Installation and UI](../cli.md#installation-and-ui). |
| Another stelz setup is running | Let it finish (a second setup waits up to one hour). Run `stelz setup` again. |
| Stop running profiles from an earlier Stelz version | Run `stelz status`, stop those profiles, run `stelz setup` again. See [Source layout and runtime updates](../development/source-layout.md#source-layout-and-runtime-updates). |
| A release or integrity check failed | Check the network connection. Run `stelz setup` again. An interrupted setup keeps the active runtime. |

## Restart to update

Run `stelz restart work` or `stelz restart all`. If the start fails: `stelz start work`. See [Update Stelz](../getting-started.md#update-stelz).
