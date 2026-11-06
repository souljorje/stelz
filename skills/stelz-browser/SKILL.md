---
name: stelz-browser
description: Install and connect Stelz. Control persistent browser profiles through shared MCP tools with exclusive control and human authentication.
---

# Instructions for agents

Stelz needs no agent and contains no reasoning loop. The client owns reasoning and conversation history.
Register `stelz mcp` once. Each connection can control multiple profiles through explicit tool arguments.
Each profile permits one browser instance with multiple windows and one controller.
Each profile has its own action queue. Separate profiles can execute actions concurrently.

## Procedure

For installation, missing profiles, or missing tools, follow [Setup](../../docs/bootstrap.md).
Resolve a symlinked skill directory's real path before following relative links.
Reuse existing state and client settings. Check actual tool availability after MCP registration.

1. Call `profile_list({})` for the current catalog.
2. Select the intended stable profile ID.
3. Call `profile_create({profileId})` if that profile is missing.
4. Call `profile_status({profileId})`.
5. Call `profile_start({profileId})` if that browser is stopped.
6. Call `profile_acquire({profileId})`.
7. Retain the returned `controlHandle` with that profile ID.
8. Read open tabs with `camofox_list_tabs({profileId, controlHandle})`.
9. Read a fresh `camofox_snapshot` before selecting an action.
10. Use the returned element references for clicks and typing.
11. Check the result with a fresh snapshot.
12. Call `profile_release({profileId, controlHandle})` when finished or before handoff. Leave the browser open.

Include `profileId` and its current `controlHandle` in every browser call, alongside canonical Camofox arguments.
Creation makes a direct profile or safely reuses an existing profile unchanged. It never reconfigures existing profiles.
Acquisition never starts a browser. Start remains explicit.
Use the CLI or UI for configuration, proxies, deletion, import, stop, recovery, and forced handoff.

An existing controller requires deliberate release or operator handoff. Never start another browser to avoid this conflict.
For orphaned state, IP failures, or service deadlines, follow [Recovery](references/recovery.md) before another action.

## Authentication and manual work

1. Call `profile_pause({profileId, controlHandle})` when authentication requires a human.
2. Tell the operator what to do in the same window.
3. Wait for the operator's result.
4. Call `profile_resume({profileId, controlHandle})`.
5. Read a fresh snapshot before the next action.

Find the window through the local UI's profile icon or **Browser windows** list.
Check its full profile ID in the title. Showing it preserves control and does not pause actions.

Do not bypass authentication challenges.
Do not close the reserved IP-check tab.

## Tool interface

MCP exposes 18 fixed tools even when the catalog is empty. New profiles require no new registration.
Read current argument schemas through MCP `tools/list`. Read current profiles through `profile_list({})`.

| Tools | Required arguments |
| --- | --- |
| `profile_list` | None. Use `{}`. |
| `profile_create`, `profile_start`, `profile_status`, `profile_acquire` | `profileId`. |
| `profile_release`, `profile_pause`, `profile_resume`, `profile_recheck` | `profileId` and `controlHandle`. |
| All nine `camofox_*` tools | `profileId`, `controlHandle`, and the tool's canonical browser arguments. |

See [Shared MCP tools](../../docs/mcp.md) for all tool names and their effects.
Previously planned browser additions remain deferred. JavaScript evaluation and cookie import remain excluded.

Every successful acquisition returns status and a fresh opaque public `controlHandle`.
Use the newest returned handle only for that connection, profile, and browser lifetime.
Keep a separate current handle for each acquired profile. Never derive handles from IDs or controller summaries.
Release an existing acquisition before acquiring that profile again. Do not acquire while another acquisition is pending.
Status and list omit handles. Never put handles in configuration, reports, or handoff notes.
After release, disconnect, browser restart, or forced handoff, acquire again before further control calls.
Do not add agent identities, process IDs, or conversation IDs to tool arguments.

`camofox_type` accepts a per-call `mode`. Omit it to use the profile default. The overall default is `auto`.
The UI can change profile defaults without restarting the browser.

| Mode | Behavior |
| --- | --- |
| `auto` | Random pauses for estimated typing ≤10 seconds, otherwise bulk entry. The service chooses before changing the field. |
| `keyboard` | Individual key events without artificial delays. |
| `instant` | Bulk entry. |

Keep profile IDs, secret references, and native browser data under `STELZ_HOME`.

## Handoff

Release explicitly before a planned handoff. Disconnect also releases control without stopping browsers.
Release and disconnect preserve pages, browser state, and saved fingerprint settings.
The next controller acquires a new handle for the existing browser state.
Conversation and reasoning history stay with the previous client.
An explicit lifecycle command or closing the browser window stops the profile. Restart remains explicit.

For the removed MCP `--profile` option, follow [Migration](../../docs/clients.md#migrate-an-existing-registration).
Keep the same `STELZ_HOME`. Prepare the updated runtime and explicitly restart old browser services.
Preserve profile IDs, saved data, and secret references. Do not edit global harness configuration.
Profile-import `--profile` selectors remain supported.

This skill is optional client guidance. Stelz does not load skills.
