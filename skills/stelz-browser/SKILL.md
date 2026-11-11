---
name: stelz-browser
description: Do browser tasks in persistent Stelz profiles through the Stelz MCP tools (`profile_*` and `camofox_*`), with exclusive control, verified readiness, and human authentication. Also use it to install Stelz when a user sends a link to this skill.
---

# Stelz browser

Stelz runs persistent browser profiles. You control them through the tools of one `stelz mcp` connection.
[Shared MCP tools](https://github.com/souljorje/stelz/blob/main/docs/mcp.md) is the tool contract, including the control-handle rules.
Requires Stelz 0.5.0 or later. Check with `stelz --version`.

## Install

When a user sends a link to this file and asks you to install it:

1. Save this file as `stelz-browser/SKILL.md` in your client's skill folder. See [Connect your agent](https://github.com/souljorje/stelz/blob/main/docs/clients.md).
2. If `stelz` is missing or older than 0.5.0, or the Stelz MCP tools are missing, follow [Agent setup](https://github.com/souljorje/stelz/blob/main/docs/bootstrap.md).

Run `stelz setup` only in a terminal. MCP tools do not download prerequisites.

## Do a browser task

1. Call `profile_list({})`. Select the profile ID that the task needs.
2. If that profile is missing, call `profile_create({profileId})`.
3. If its browser is stopped, call `profile_start({profileId})`.
4. Check readiness in the start result or in `profile_status({profileId})`:
   - `phase` is `"ready"`.
   - If `verificationRequired` is true, `verificationStatus` is `"verified"` and `exitIp` agrees with the intended route.

   If a check fails, do not acquire. Report `location` to the user and go to [Recover](#recover).
5. Call `profile_acquire({profileId})`. Keep the returned `controlHandle` with its profile ID. Never write it in reports, configuration, or handoff notes.
   Send both fields in each later call for that profile.
6. Call `camofox_list_tabs` to find the startup page. Navigate that tab.
7. Before each action, read a fresh `camofox_snapshot`. Use its element references to click and type.
8. After each action, read a fresh snapshot to check the result.
9. When you finish, or before another agent takes over, call `profile_release({profileId, controlHandle})`. Leave the browser open.

## Rules

- Never repeat an action that may have reached the page or that stopped before it finished. Read a fresh snapshot first.
- If another controller holds the profile, do not start another browser or create another profile. Ask the operator to release it.
- For changes that the tools cannot make, ask the operator to use the CLI or UI.
- Before you type long text, read [Typing](https://github.com/souljorje/stelz/blob/main/docs/configuration/typing.md) to select a `camofox_type` mode.
- Tell the operator about location warnings in `location.evidence`. Never claim a physical location from status, and never bypass a location blocker. See [Managed location data](https://github.com/souljorje/stelz/blob/main/docs/configuration/network.md#managed-location-data).
- If status shows `restartToUpdate: true`, tell the user. Restart only when the user asks. Release before the restart, and acquire again after it. See [Restart to update](https://github.com/souljorje/stelz/blob/main/docs/troubleshooting/setup.md#restart-to-update).

## Human authentication

1. When a page needs a person, for example to sign in, call `profile_pause({profileId, controlHandle})`.
2. Tell the operator what to do in that browser window. [Find a profile's windows](https://github.com/souljorje/stelz/blob/main/docs/ui.md#find-a-profiles-windows) tells them how to find it.
3. Wait for the operator. Then call `profile_resume({profileId, controlHandle})`.
4. Read a fresh snapshot before the next action.

Do not try to bypass an authentication challenge.

## Recover

After an error, call `profile_status({profileId})` before another browser action. Then use the procedure for the problem:

- [IP verification failed](https://github.com/souljorje/stelz/blob/main/docs/troubleshooting/network.md#ip-verification-failed). After the operator repairs the route, call `profile_recheck({profileId, controlHandle})`.
- [Missing or stale control handle](https://github.com/souljorje/stelz/blob/main/docs/troubleshooting/control.md#missing-or-stale-control-handle).
- [Browser action or IP check timed out](https://github.com/souljorje/stelz/blob/main/docs/troubleshooting/lifetime-and-state.md#browser-action-or-ip-check-timed-out).
- Other problems: [Troubleshooting](https://github.com/souljorje/stelz/blob/main/docs/troubleshooting/index.md).

Diagnostics, stop, and recovery are operator actions. Never send signals to processes or work around uncertain process ownership.
