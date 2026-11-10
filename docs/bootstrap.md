# Set up Stelz from an agent

Bring an existing or new installation to a working browser connection.
Use the requested profile ID, or `work` by default.
Installation lives in [Getting started](getting-started.md). Client registration and verification live in [Connect your agent](clients.md).

## Discover before changing anything

1. Check the [platform and runtime prerequisites](getting-started.md#what-you-need).
2. Find `stelz`, `bun`, `node`, and `npm` on PATH. Check their versions.
3. Select the existing absolute `STELZ_HOME`, or use `~/.local/share/stelz`.
4. For an existing installation, run `stelz --help`, `stelz doctor`, and `stelz status`.
5. Inspect the requested profile and any existing client entry before creating or changing either.

Preserve profile IDs, saved data, secret references, browser installations, and client configuration.
Keep approvals, sandboxing, workspace trust, and authentication checks enabled. Do not edit global harness configuration.
Request intervention for permissions, missing credentials, authentication, or a required client restart.
Do not overwrite a conflicting installation or use `sudo` without authorization.

## Complete only missing steps

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

The human first-use guide creates profiles through the UI.
An agent with registered tools creates and starts profiles as the [browser skill](../skills/stelz-browser/SKILL.md#do-a-browser-task) describes.
For setup before registration, an agent can use the supported CLI:

```sh
stelz profile create work --json
stelz start work
stelz doctor work
```

Omitted network options preserve an existing profile's route and expected IP.
Conflicting options fail without changing the profile.
See [proxy setup](proxies.md) and [profile commands](cli.md#profile-commands) for explicit options.
Never edit profile JSON to bypass a conflict or create another browser to avoid an active controller.
Open `stelz ui --open` when the user requests the manager.

## Connect and verify

Use [Connect your agent](clients.md) to install the canonical skill and register `stelz mcp` once for the selected client.
Use project scope when available. Give required global registration changes to the operator.
Use the same CLI path, service directory, and runtime PATH throughout.
Preserve unrelated client entries. Reuse a matching entry and report conflicts before replacing one.
The 18 fixed tools serve all profiles. New profiles require no new registration.

Complete [Verify the connection](clients.md#verify-the-connection) through the target session's actual MCP tools.
A saved configuration, tool listing, or separate SDK probe is insufficient to report **Verified**.
For failures, follow [Troubleshooting](troubleshooting.md) and the skill's [recovery steps](../skills/stelz-browser/SKILL.md#recover).

## Report readiness and resume

| State | Evidence |
| --- | --- |
| Installed | Compatible dependency versions and a prepared Stelz runtime. |
| Browser ready | The selected profile is running and its control interface responds. |
| Client configured | The canonical skill and one shared MCP entry are installed. |
| Verified | The target agent completed the local interaction and release check. |

Mark incomplete states as pending. Record absolute paths, profile ID, completed steps, and the next action without credentials.
If the client needs a new session, give the exact connection and verification step to resume.
Continue from the first incomplete step with the same profile.

Historical scope and interventions appear in the [onboarding report](development/reports/onboarding-2026-11-05.md).
