---
name: stelz-browser
description: Install and connect Stelz. Control a persistent browser profile through MCP with exclusive control and human authentication.
---

# Instructions for agents

Stelz needs no agent and contains no reasoning loop. The client owns reasoning and conversation history.
Each MCP connection selects one configured profile: `stelz mcp --profile ID`.
Each profile permits at most one browser instance with multiple windows.

## Procedure

For installation, missing profiles, or missing tools, follow [Setup](../../docs/bootstrap.md).
Resolve a symlinked skill directory's real path before following relative links.
Reuse existing state and client settings. Check actual tool availability after MCP registration.

1. Call `profile_status`.
2. Create or start a missing or stopped profile through the authorized setup commands.
3. Call `profile_acquire`.
4. Read the open tabs with `camofox_list_tabs`.
5. Read a fresh `camofox_snapshot` before selecting an action.
6. Use the returned element references for clicks and typing.
7. Check the result with a fresh snapshot.
8. Call `profile_release` when finished or before handoff. Leave the browser open.

An existing controller requires deliberate release or operator handoff. Never start another browser to avoid this conflict.
For orphaned state, IP failures, or service deadlines, follow [Recovery](references/recovery.md) before another action.

## Authentication and manual work

1. Call `profile_pause` when authentication requires a human.
2. Tell the operator what to do in the same window.
3. Wait for the operator's result.
4. Call `profile_resume`.
5. Read a fresh snapshot before the next action.

Find the window through the local UI's profile icon or **Browser windows** list.
Check its full profile ID in the title. Showing it preserves control and does not pause actions.

Do not bypass authentication challenges.
Do not close the reserved IP-check tab.

## Tool interface

`profile_status`, `profile_acquire`, `profile_release`, `profile_pause`, `profile_resume`, and `profile_recheck` take no arguments.
Read upstream Camofox tool schemas through MCP `tools/list`.
Do not add profile IDs, controller tokens, or conversation IDs to arguments. The connection selects the profile.

`camofox_type` accepts a per-call `mode`. Omit it to use the profile default. The overall default is `auto`.
The UI can change profile defaults without restarting the browser.

| Mode | Behavior |
| --- | --- |
| `auto` | Random pauses for estimated typing ≤10 seconds, otherwise bulk entry. The service chooses before changing the field. |
| `keyboard` | Individual key events without artificial delays. |
| `instant` | Bulk entry. |

Keep profile IDs, secret references, and native browser data under `STELZ_HOME`.

## Handoff

Release and disconnect preserve pages, browser state, and saved fingerprint settings.
The next controller receives that state, not the previous client's conversation or reasoning history.
An explicit lifecycle command or closing the browser window stops the profile. Restart remains explicit.

This skill is optional client guidance. Stelz does not load skills.
