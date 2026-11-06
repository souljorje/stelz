---
name: stelz-browser
description: Set up Stelz, create or reuse a persistent browser profile, connect the current agent, and control the browser through MCP with exclusive control and human authentication.
---

# Instructions for agents

The service contains no reasoning loop. The client harness owns reasoning and conversation history.
Each MCP connection must select one configured profile with `stelz mcp --profile ID`.
Each profile has at most one browser instance. Multiple windows can belong to that browser.

## Procedure

For installation, a missing profile, or missing tools, read [Onboarding](references/bootstrap.md).
Use the authorized CLI setup and start commands when available. Reuse existing state and client settings.
Do not treat MCP registration as proof that tools are available in this session.

1. Call `profile_status`.
2. If the profile is missing or stopped, follow onboarding and run `stelz profile create ID --json` or `stelz start ID` as needed.
3. Call `profile_acquire`.
4. Read the open tabs with `camofox_list_tabs`.
5. Read a fresh `camofox_snapshot` before you select an action.
6. Use the returned element references for clicks and typing.
7. Check the result with a fresh snapshot.
8. Call `profile_release` when the task is complete or another client needs control. Keep the browser available.

An active controller causes another acquisition to fail. Wait for deliberate release or operator handoff.
Do not start another browser to avoid a controller conflict.
If status reports `orphaned`, ask the operator to inspect the profile with `stelz doctor ID`.
If an IP check fails, ask the operator to correct the network. Then call `profile_recheck`.
If the profile remains paused, call `profile_resume` after the recheck succeeds.
After a successful recheck, read a fresh snapshot before the next action.
If an operation exceeds its service deadline, ask the operator to stop and start the profile.

## Authentication and manual work

1. Call `profile_pause` when authentication requires a human.
2. Tell the operator which action is necessary in the same window.
3. Wait for the operator's result.
4. Call `profile_resume`.
5. Read a fresh snapshot before the next action.

Direct the operator to the selected profile's window icon or **Browser windows** list in the local UI.
Ask them to check the full profile ID in the window title prefix.
Showing a window preserves the controller. It does not pause browser actions.
Use the **Browser windows** list in the local UI to find the selected window.

Do not bypass authentication challenges.
Do not close the reserved IP-check tab.

## Tool interface

`profile_status`, `profile_acquire`, `profile_release`, `profile_pause`, `profile_resume`, and `profile_recheck` take no arguments.
The browser tools use the upstream Camofox schemas. Read them through standard MCP `tools/list`.
The `camofox_type` tool also accepts `mode`: `auto`, `keyboard`, or `instant`.
Omit `mode` to use the profile default. The overall default is `auto`.
Automatic mode uses random pauses when the estimated typing duration is at most 10 seconds.
Longer text uses bulk entry. The service selects the method before it changes the field.
Use `keyboard` when the page requires individual key events. This mode adds no artificial delays.
Use `instant` to request bulk entry explicitly. An override applies only to the current call.
The operator can change each profile's default in the UI without restarting its browser.
Do not add profile IDs, controller tokens, or conversation IDs to browser tool arguments.
The connection already selects the profile.

Keep profile IDs, secret references, and native browser data under `STELZ_HOME`.

## Handoff

Release and disconnect do not close pages or change the saved fingerprint configuration.
The next controller sees the same open browser page and browser state.
It does not receive the previous client's conversation or reasoning history.
Only an explicit lifecycle command stops the browser.
Closing the browser window also stops its profile. The next start remains explicit.

See [Recovery](references/recovery.md) for blocked service lifetimes.

This skill provides optional client guidance. The service does not load skills or require an agent harness.
