---
title: "Set up Stelz from an agent"
description: "Procedure for an agent to install Stelz, register its MCP tools, open the UI, and hand over to the user."
tags: [agent, install, setup, mcp]
sources: []
created: 2026-11-05T17:29:14Z
modified: 2026-11-11T14:13:54Z
---

# Set up Stelz from an agent

Install Stelz, register its tools, open the UI, and tell the user what to do next. Do not create or start profiles.

## Discover

1. Find `stelz`, `bun`, `node`, and `npm` on PATH. Check their versions against the [prerequisites](getting-started.md#what-you-need).
2. Select the existing absolute `STELZ_HOME`, or use `~/.local/share/stelz`.
3. For an existing installation, run `stelz doctor` and `stelz status`.
4. Inspect any existing client entry before you change it.

Preserve profile IDs, saved data, secret references, browser installations, and client configuration.
Keep approvals, sandboxing, workspace trust, and authentication checks enabled. Do not edit global harness configuration.
Request intervention for permissions, missing credentials, authentication, or a required client restart.
Do not overwrite a conflicting installation or use `sudo` without authorization.

## Install and prepare

Follow [Getting started](getting-started.md) to install the package. For a supplied archive, use its absolute path.
If no usable release or archive exists, report that blocker. Do not install a staging placeholder.
Resolve the selected CLI's symlink to find its package directory. Then check what setup needs:

```sh
stelz setup --json
```

If downloads are necessary, this fails with code `confirmation_required`. Its JSON error on stderr lists the downloads.
Show them to the user and ask for approval. Then run `stelz setup --yes --json`. See [CLI](cli.md#installation-and-ui) for the fields.

A runtime directory from an earlier Stelz version blocks setup while profiles run. Report this blocker as pending. Do not stop unrelated profiles.
For a profile with `restartToUpdate: true`, follow the skill's [rules](../skills/stelz-browser/SKILL.md#rules).

## Connect

Follow [Connect your agent](clients.md) to install the skill and register `stelz mcp` once for the selected client.
Use project scope when available. Give required global registration changes to the operator.
Use the same CLI path, service directory, and runtime PATH throughout.
Reuse a matching entry. Report conflicts before you replace one.

## Open the UI and hand over

Start `stelz ui --open` as a background process. Give the user the private URL that it prints.
Report what you installed and registered, with absolute paths and no credentials. Mark incomplete steps as pending. Then tell the user:

1. In the UI, create a profile such as `work` and select **Start**. See [Create and start a profile](ui.md#create-and-start-a-profile).
2. Start a new agent session in this project. Approve the `stelz` server if the client asks.
3. Ask for a browser task, for example: "Open example.com in my Stelz profile `work`."

For failures, see [Troubleshooting](troubleshooting.md).
