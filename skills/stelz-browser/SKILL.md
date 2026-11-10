---
name: stelz-browser
description: Control persistent browser profiles through Stelz MCP tools, with exclusive control, verified readiness, and human authentication.
---

# Instructions for agents

Register `stelz mcp` once. Each connection can control multiple profiles through explicit tool arguments.
Each profile has one browser instance, one controller, and one action queue. Separate profiles can execute actions concurrently.
See [Shared MCP tools](../../docs/mcp.md) for the tool contract.

## Setup

For installation, missing profiles, or missing tools, follow [Agent setup](../../docs/bootstrap.md).
Resolve a symlinked skill directory's real path before following relative links.
Reuse existing state and client settings. Check actual tool availability after MCP registration.

Missing runtime or location data requires `stelz setup`. The operator runs it.
When the operator allows downloads, you can run `stelz setup --yes --json` in a terminal.
Never run setup through MCP. MCP calls do not download prerequisites.

## Procedure

1. Call `profile_list({})` for the current catalog.
2. Select the intended stable profile ID.
3. Call `profile_create({profileId})` if that profile is missing. Creation never reconfigures an existing profile.
4. Call `profile_status({profileId})`.
5. Call `profile_start({profileId})` if that browser is stopped.
6. Read the `profile_start` result, or call `profile_status({profileId})`, and apply the readiness gate below.
7. Call `profile_acquire({profileId})`. Retain the returned `controlHandle` with that profile ID.
8. Startup opens one blank page. Use `camofox_list_tabs` to find its `tabId`, then navigate it.
9. Read a fresh `camofox_snapshot` before you select an action. Use its element references for clicks and typing.
10. Check the result with a fresh snapshot.
11. Call `profile_release({profileId, controlHandle})` when finished or before handoff. Leave the browser open.

Readiness gate:

- Require `phase: "ready"`.
- When `verificationRequired` is true (a proxy or an expected IP), require `verificationStatus: "verified"`. Check `exitIp` against the intended route.
- Do not acquire a failed or unverified profile. Report `location` and follow [Recovery](references/recovery.md).

## Control rules

Include `profileId` and its current `controlHandle` in every control and browser call, alongside canonical Camofox arguments.
Follow the handle rules in [Control handles](../../docs/mcp.md#control-handles). Never put handles in configuration, reports, or handoff notes.
Acquisition never starts a browser. Start remains explicit.
Use the CLI or UI for configuration, proxies, deletion, import, stop, recovery, and forced handoff.

An acquisition fails when another controller holds the profile, or when this connection has an active or pending acquisition.
Release your own handle first. For another controller, do not start another browser. Ask the operator for a release or a forced handoff.
Never replay an uncertain or interrupted action. Read a fresh snapshot first.
For orphaned state, IP failures, or service deadlines, follow [Recovery](references/recovery.md) before another action.

`camofox_evaluate` and `camofox_import_cookies` are unavailable.
`camofox_type` accepts a per-call `mode`. Omit it to use the profile default.
The default `auto` mode types with pauses when the estimated duration is at most 10 seconds. See [Typing](../../docs/configuration.md#typing).

## Location

Read `location.evidence` in status: `source`, the build date `builtAt`, and `comparison.result`.
The result is `corroborated`, `uncorroborated`, or `conflicting`.
Under the default `warn` policy, a conflict or stale data is a warning. Report it to the operator.
`verified` means that the exit-IP check passed and the browser applies the prepared timezone and language.
It does not prove a physical location. Never claim one.
Never bypass a location blocker or change a running browser's location settings.

`profile_recheck` repeats the browser IP check. It needs the handle and a running browser.
A successful recheck keeps a pause. If the profile is paused, call `profile_resume` afterwards.

## Authentication and manual work

1. Call `profile_pause({profileId, controlHandle})` when authentication requires a human.
2. Tell the operator what to do in the same window.
3. Wait for the operator's result.
4. Call `profile_resume({profileId, controlHandle})`.
5. Read a fresh snapshot before the next action.

Find the window through the local UI's profile icon or **Browser windows** list.
Check its full profile ID in the title. Showing it preserves control and does not pause actions.
Do not bypass authentication challenges.

## Updates

A profile that shows `restartToUpdate: true` keeps working on its old runtime. Report it.
Restart it only on an explicit operator or user request.
`stelz restart ID` closes the browser and its pages and invalidates handles. Release first, and acquire again afterwards.

## Handoff

Release explicitly before a planned handoff. Disconnect also releases control without stopping browsers.
Release and disconnect preserve pages, browser state, and saved fingerprint settings.
The next controller acquires a new handle. Conversation and reasoning history stay with the previous client.
An explicit lifecycle command or closing the browser window stops the profile.
Preserve profile IDs, saved data, and secret references.

This skill is optional client guidance. Stelz does not load skills.
