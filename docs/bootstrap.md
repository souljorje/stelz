# Set up Stelz from an agent

Install Stelz, connect your browser tools, open the Stelz UI, and tell the user what to do next.
Do not create or start profiles during setup. The user does that in the UI.
Installation lives in [Getting started](getting-started.md). Client registration lives in [Connect your agent](clients.md).

## Discover before changing anything

1. Check the [platform and runtime prerequisites](getting-started.md#what-you-need).
2. Find `stelz`, `bun`, `node`, and `npm` on PATH. Check their versions.
3. Select the existing absolute `STELZ_HOME`, or use `~/.local/share/stelz`.
4. For an existing installation, run `stelz --help`, `stelz doctor`, and `stelz status`.
5. Inspect any existing client entry before you change it.

Preserve profile IDs, saved data, secret references, browser installations, and client configuration.
Keep approvals, sandboxing, workspace trust, and authentication checks enabled. Do not edit global harness configuration.
Request intervention for permissions, missing credentials, authentication, or a required client restart.
Do not overwrite a conflicting installation or use `sudo` without authorization.

## Install and prepare

Follow [Getting started](getting-started.md) for missing dependencies and package installation.
For a supplied archive, use its absolute path in that guide's install command.
If no usable release or archive exists, report that blocker. Do not install a staging placeholder.
Resolve the selected CLI's symlink to find its package directory.

Check what setup needs first:

```sh
stelz setup --json
```

If downloads are necessary, this fails with code `confirmation_required`. Its JSON error on stderr lists the downloads, which can include a browser of over 1 GB.
Each download has a `name`, `size`, `purpose`, and `source` link. Show these to the user and ask for approval. Then run:

```sh
stelz setup --yes --json
```

Setup creates missing service files and preserves existing configuration. Running profiles continue to run.
`--json` never prompts. On success, stdout contains one JSON report: the browser source, each location dataset, the fingerprint model, and the runtime.
A runtime directory from an earlier Stelz version blocks setup while profiles run. Report this blocker as pending. Do not stop unrelated profiles.
For a profile that shows `restartToUpdate: true`, follow the skill's [rules](../skills/stelz-browser/SKILL.md#rules).

## Connect

Use [Connect your agent](clients.md) to install the canonical skill and register `stelz mcp` once for the selected client.
Use project scope when available. Give required global registration changes to the operator.
Use the same CLI path, service directory, and runtime PATH throughout.
Preserve unrelated client entries. Reuse a matching entry and report conflicts before replacing one.
The 18 fixed tools serve all profiles. New profiles require no new registration.
Most clients load new tools only in a new session.

## Open the UI and hand over

Start `stelz ui --open` as a background process. It serves the UI until it stops.
Give the user the private URL that it prints, in case no browser tab opens.

Report what you installed and registered, with absolute paths and no credentials. Mark any incomplete step as pending.
Then tell the user the next steps:

1. In the UI, create a profile, for example `work`, and select **Start**. See [Create and start a profile](ui.md#create-and-start-a-profile).
2. Start a new agent session in this project, so that the client loads the Stelz tools. Approve the `stelz` server if the client asks.
3. Ask the agent for a browser task in that profile, for example: "Open example.com in my Stelz profile `work`."

If the UI closes, for example when your session ends, run `stelz ui --open` to open it again.
For failures, follow [Troubleshooting](troubleshooting.md).
