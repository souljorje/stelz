---
title: "Set up Stelz from an agent"
description: "Procedure for an agent to install Stelz, register its MCP tools, open the UI, and hand over to the user."
tags: [agent, install, setup, mcp]
sources: []
created: 2026-11-05T17:29:14Z
modified: 2026-11-11T14:27:18Z
---

# Set up Stelz from an agent

Install Stelz, register its tools, open the UI, and hand over. Do not create or start profiles.

## Discover

1. Find `stelz`, `bun`, `node`, and `npm` on PATH. Check their versions against the [prerequisites](getting-started.md#what-you-need).
2. Select the existing absolute `STELZ_HOME`, or use `~/.local/share/stelz`.
3. Existing installation: run `stelz doctor` and `stelz status`.
4. Inspect any existing client entry before you change it.

Rules:

- Preserve profile IDs, saved data, secret references, browser installations, and client configuration.
- Keep approvals, sandboxing, workspace trust, and authentication checks enabled.
- Do not edit global harness configuration.
- Do not overwrite a conflicting installation. Do not use `sudo` without authorization.
- Request intervention for permissions, missing credentials, authentication, or a required client restart.

## Install and prepare

1. Install the package. See [Getting started](getting-started.md). Supplied archive: use its absolute path.
2. No usable release or archive: report that blocker. Do not install a staging placeholder.
3. Run `stelz setup --json`.
4. Setup needs downloads: show them to the user and ask. See [Installation and UI](cli.md#installation-and-ui). After approval, run `stelz setup --yes --json`.

Blockers:

- A runtime from an earlier Stelz version blocks setup while profiles run. Report it as pending. Do not stop unrelated profiles.
- A profile with `restartToUpdate: true`: follow the skill's [rules](../skills/stelz-browser/SKILL.md#rules).

## Connect

1. Resolve the selected CLI's symlink to find its package directory. This is `$STELZ_PACKAGE` in [Connect your agent](clients.md).
2. Install the skill. Register `stelz mcp` once for the selected client.
3. Use project scope when available. Give required global registration changes to the operator.
4. Use the same CLI path, service directory, and runtime PATH throughout.
5. Reuse a matching entry. Report conflicts before you replace one.

## Open the UI and hand over

1. Start `stelz ui --open` as a background process. Give the user the private URL that it prints.
2. Report what you installed and registered, with absolute paths and no credentials. Mark incomplete steps as pending.
3. Tell the user:
   1. In the UI, create a profile such as `work` and select **Start**. See [Create and start a profile](ui.md#create-and-start-a-profile).
   2. Start a new agent session in this project. Approve the `stelz` server if the client asks.
   3. Ask for a browser task, for example: "Open example.com in my Stelz profile `work`."

For failures, see [Troubleshooting](troubleshooting.md).
