---
title: "Troubleshooting"
description: "Symptom lookup, diagnosis, and recovery procedures for installation, control, network, and browser-lifetime failures. Read it when Stelz or a browser misbehaves."
tags: [troubleshooting, recovery]
sources: []
created: 2026-11-06T13:49:16Z
modified: 2026-11-11T14:13:54Z
---

# Troubleshooting

Use the existing profile and its usual `STELZ_HOME`. Inspect one affected profile before you change its lifecycle.
The examples use `work`. Substitute the actual profile ID.

## Read the evidence

```sh
stelz doctor work
stelz status work
stelz logs work --lines 100
```

Exit status `0` does not show browser readiness. Read the returned fields. See [CLI output and exit status](cli.md#errors-and-exit-status).

| Symptom | Check | Go to |
| --- | --- | --- |
| No profiles, `Unknown profile`, missing `stelz` or `bun`, `setup: false`, or a missing executable or plugin | `stelz doctor`: wrong `home`, `initialized: false`, or no entry for `work` | [Installation or runtime fails](#installation-or-runtime-fails) |
| Setup fails | The setup error | [Setup fails](#setup-fails) |
| **Restart to update** | `restartToUpdate: true` in status | [Restart to update](#restart-to-update) |
| Agent tools are absent | Status shows a ready browser. Check that the client has one `stelz mcp` entry with the correct service home. | [Verify the connection](clients.md#verify-the-connection) |
| Tool call rejects the handle, or `controller` names another client | Status | [Missing or stale control handle](#missing-or-stale-control-handle) |
| Actions stop during authentication | `phase: "paused"` | [Profile is paused](#profile-is-paused) |
| Start is blocked by location | `stelz status work --json`: `location` reports a failed check | [Location alignment blocks Start](#location-alignment-blocks-start) |
| IP verification fails or `verificationFresh` is false | `verification_failed`, an unexpected IP, or an expired cached result | [IP verification failed](#ip-verification-failed) |
| Operation timed out | `phase: "blocked"`, plus a deadline, typing timeout, or lost context in the logs | [Browser action or IP check timed out](#browser-action-or-ip-check-timed-out) |
| Start refuses an old lifetime | `stelz doctor`: `orphaned`, `unclean`, or `ownership_unknown` | [Inspect an unclean lifetime](#inspect-an-unclean-lifetime) |
| Saved browser data or fingerprint fails | Logs: missing native data, corrupt pin, or changed executable hash | [Native data or fingerprint is unavailable](#native-data-or-fingerprint-is-unavailable) |
| Save or import remains pending | `stelz doctor`: recovery message or pending journal | [Configuration save or import is pending](#configuration-save-or-import-is-pending) |
| UI, window, or transfer fails | The error | [UI session, window, or transfer fails](#ui-session-window-or-transfer-fails) |

## Choose the lifecycle action

| Action | Use it for | Result |
| --- | --- | --- |
| Pause, then resume | Human authentication or manual work in the same window. | Browser and controller stay. Resume performs any required fresh IP check. |
| Release | Deliberate controller handoff. | Browser and pages stay open. A pause remains a pause. |
| Recheck | Failed or expired IP evidence after network repair. | Same browser and controller. A successful recheck preserves a pause. |
| Stop | Explicitly end the browser lifetime. | Current actions drain. Saved data remains. Start remains explicit. |
| Recover | Archive an unclean record after process inspection. | Does not stop processes. Refuses live recorded processes and unknown ownership. |

Never create another profile to avoid a controller conflict or to hide broken saved state.
To change launch settings when Start reports a changed configuration, stop the profile, correct the settings with the same IDs and references, then start it. Display names and typing preferences need no restart.

## Installation or runtime fails

1. If the command does not start, run `command -v stelz bun node`. For a missing executable, install it through [What you need](getting-started.md#what-you-need) or add its `bin` directory to PATH. Use the same paths in your agent's MCP environment.
2. Run `stelz doctor` with the intended `STELZ_HOME`. Check `home`, `setup`, `node`, and `browserExecutable`.
3. If the CLI, UI, and MCP connection select different directories, correct their environments. See [Service directory precedence](configuration.md#service-directory-and-precedence).
4. Run `stelz setup` with the same service directory. It prepares a missing browser, runtime, or plugin and keeps existing profiles.
5. Run `stelz status` to find existing IDs. Create a missing `work` profile through [Getting started](getting-started.md).

Setup does not recover profiles in another service directory.
Do not remove profiles or reinstall Camoufox to repair a missing Bun command.
For an unsupported Camoufox build, check `CAMOUFOX_EXECUTABLE` in the process environment and in `STELZ_HOME/secrets.env`. Remove it or point it to the paired build. Then run `stelz setup`. The process environment takes precedence. See [Browser executable](configuration.md#browser-executable).

## Setup fails

| Message or code | Action |
| --- | --- |
| `confirmation_required` | Run `stelz setup` in a terminal and confirm, or run `stelz setup --yes`. |
| Another stelz setup is running | Let the first setup finish. A second setup waits up to one hour. Then run `stelz setup` again. |
| Stop running profiles from an earlier Stelz version | Run `stelz status` and stop those profiles. Then run `stelz setup` again. |
| A release or integrity check failed | Check the network connection. Then run `stelz setup` again. An interrupted setup keeps the active runtime. |

## Restart to update

The profile keeps its earlier runtime until it restarts.
Run `stelz restart work` when you can close its browser and pages, or `stelz restart all` for all running profiles.
Restart ends control, so clients must acquire the profile again.
If the start fails, the profile stays stopped. Read the evidence, then run `stelz start work`.

## Missing or stale control handle

1. Call `profile_status({profileId})`. Check whether the browser stopped, restarted, or changed controller.
2. If another client holds control, ask it to call `profile_release({profileId, controlHandle})`. For an operator handoff, run `stelz release work` or select **Release** in the UI and confirm. Require `controller: null` in live status.
3. Start a stopped browser explicitly.
4. Call `profile_acquire({profileId})` on the intended connection. Keep the new `controlHandle` with that profile ID.

An existing acquisition blocks another on the same connection, so release its handle first. If the handle is lost, arrange an operator release and reconnect the client.
Do not reuse a handle after release, disconnect, browser restart, or forced handoff. Never copy handles.

## Profile is paused

1. Find the window with [Find a profile's windows](ui.md#find-a-profiles-windows).
2. Complete authentication or manual work in that same window.
3. Run `stelz resume work` or call `profile_resume({profileId, controlHandle})`.
4. Require `phase: "ready"`.

If resume fails verification, see [IP verification failed](#ip-verification-failed). Release does not resume a paused profile.

## Location alignment blocks Start

Read **Location alignment** in the profile details, or run `stelz status work --json`. The `location` result gives the phase, time, reason, and recovery action.

| Problem | Action |
| --- | --- |
| Location data is missing, damaged, or incompatible | Run `stelz setup`, then select **Check again**. |
| Location data is stale (`GEOIP_DATA_STALE`, strict policy) | Run `stelz setup` with network access, then check again. |
| Location databases disagree (`LOCATION_CONFLICT`, strict policy) | Use another proxy exit. To start anyway, set `STELZ_LOCATION_POLICY=warn`. |
| Proxy credentials are missing or rejected | Edit the proxy credentials, then check again. |
| Proxy connection fails or times out, or IP detection fails | Check the provider connection and the IP services, then check again. |
| Expected IP does not match | Check the proxy route and expected IP setting. |
| Exit IP has no complete location | Check the provider's exit location. Setup does not repair a missing location record. |
| Browser location does not match | Check the route, then start again. Inspect logs if the failure repeats. |

For a stopped profile, `stelz recheck work` runs preflight without starting a browser.
Do not remove the fingerprint or native data to repair location alignment.

## IP verification failed

1. Run `stelz doctor work` and `stelz status work`. Read `configuration`, `error`, and `checkFailure`.
2. Correct the proxy or provider connection when the configured route is still correct.
3. Run `stelz recheck work`. Require `verificationStatus: "verified"` and the intended `exitIp`.
4. If `phase` is `paused`, complete manual work before you run `stelz resume work`.

For a missing secret, invalid URL, changed credentials, or incorrect expected IP, stop `work` before you edit.
Save the corrected settings through [Configure a proxy](proxies.md). Then start `work` explicitly. Recheck does not load changed network settings into a running browser.

If `verificationFresh` is false with `verificationStatus: "verified"`, the cached result expired. The next browser action checks again. Run `stelz recheck work` to check now.
See [IP verification fields](configuration.md#ip-verification-fields) and [IP check policy](configuration.md#ip-check-policy).

## Browser action or IP check timed out

Known issue: a click or scroll can time out when the browser window is not in front, especially when other windows cover it. A scroll in a tab that is not selected has the same risk.

1. Run `stelz status work` and `stelz logs work --lines 200`. Look for `blocked`, a time-limit error, or refusal of a replacement browser or context.
2. Run `stelz stop work`. Require `phase: "stopped"`. If stopping fails, inspect an unclean lifetime.
3. Run `stelz start work`.
4. Acquire control again from the intended client.

Each short action has a 30-second limit and typing has 3 minutes. See [Typing](configuration.md#typing).
The service waits 30 seconds longer than each limit, so a timeout appears after 60 seconds or 3.5 minutes.
The timed-out operation can still run, and a client timeout does not cancel it.
So the service blocks further browser actions for that lifetime. Recheck, release, and resume cannot clear this block.

## Inspect an unclean lifetime

1. Run `stelz doctor work` and `stelz logs work --lines 200`. Read `phase`, `supervisorPid`, `serverPid`, and both `ownership` verdicts.
2. For `orphaned` with an owned server, run `stelz stop work`, then `stelz doctor work` again.
3. Inspect browser processes for this profile that outlived the recorded service.
4. After they exit and recorded ownership is resolved, run `stelz recover work`. Require `recovered: true`.
5. Run `stelz start work` explicitly.

Ownership verdicts: `owned` means the PID and process birth stamp match. `different` means another process now holds the PID, so do not signal it. `unverified` means ownership cannot be established, so stop for operator inspection.
Recovery cannot check surviving browser descendants. Keep process records and lock files while inspection is pending.
Do not signal unknown PIDs, delete native browser locks blindly, or replace the saved profile.

## Native data or fingerprint is unavailable

Run the [fingerprint check](cli.md#check-a-saved-fingerprint). It does not start a browser.

- `fingerprint_uninitialized`: no pin exists. This is not an invalid identity.
- `fingerprint_invalid`, or an unreadable or corrupt pin: restore the matching pin and data from a trusted backup.
- `fingerprint_engine_mismatch` or `fingerprint_engine_unavailable`: restore the matching Camoufox executable path.
- Missing `browser-data/`: restore the original matching directory while the profile is stopped.

Do not remove the native marker or fingerprint to generate a replacement identity. No command repairs a fingerprint or migrates an engine.

## Configuration save or import is pending

1. Run `stelz doctor work` to read the network or import recovery message.
2. Keep `profiles.json`, `secrets.env`, the named journal, and its staging directories.
3. For an interrupted save, retry the save with fresh UI state, or run `stelz start work` when you intend to start that profile.
4. For a pending import, an explicit start or another configuration operation attempts journal recovery first.
5. Check the catalog before you import again. The first batch can already be present.

If recovery reports conflicting edits, inspect the named files first. A network journal needs the profile cleanly stopped.
`stelz recover work` handles browser process records, not these journals. See [Transactions and recovery](configuration.md#transactions-and-recovery).

## UI session, window, or transfer fails

| Symptom | Next action |
| --- | --- |
| UI refuses an old session URL (token consumed, or cookie from another UI session) | Reload the authenticated browser. If unavailable, end only the UI command and run `stelz ui --open`. |
| UI port `9380` is occupied | Use the existing UI, or run `stelz ui --port 9381 --open`. Leave the unknown listener intact. |
| Show window fails (page closed, lifetime changed, or activation failed) | Select a fresh entry in **Browser windows**. On macOS, select that browser manually, then retry. |
| Transfer rejects active profiles (running, unclean, or unknown ownership) | Stop only the export profiles. Inspect unclean lifetimes first. |
| Import rejects compatibility (OS, architecture, or executable hash differs) | Use a matching destination. Do not edit the manifest. |
| Catalog changed during import preview, or export output exists | Reload the preview and review the mappings, or use a new output filename. |
| `too_large`, size or entry limit, or insufficient disk | Free disk space or select fewer profiles. Change [transfer limits](configuration.md#archive-schema-and-limits) before a new session if appropriate. |

See [Transfer profiles](profile-transfer.md) for cancellation, reload, and import steps.
