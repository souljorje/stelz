---
title: "Troubleshooting"
description: "Symptoms, diagnosis, and recovery procedures for installation, control, network, and browser-lifetime failures."
tags: [troubleshooting, recovery]
sources: []
created: 2026-11-06T13:49:16Z
modified: 2026-11-11T14:27:18Z
---

# Troubleshooting

Examples use profile `work` and the `STELZ_HOME` of the affected profile.
Inspect one profile before you change its lifecycle.

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
| Agent tools are absent | Status shows a ready browser. The client needs one `stelz mcp` entry with the correct service home. | [Verify the connection](clients.md#verify-the-connection) |
| Tool call rejects the handle, or `controller` names another client | Status | [Missing or stale control handle](#missing-or-stale-control-handle) |
| Actions stop during authentication | `phase: "paused"` | [Profile is paused](#profile-is-paused) |
| Start is blocked by location | `stelz status work --json`: `location` reports a failed check | [Location alignment blocks Start](#location-alignment-blocks-start) |
| IP verification fails, or `verificationFresh` is false | `verification_failed`, an unexpected IP, or an expired cached result | [IP verification failed](#ip-verification-failed) |
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

- Never create another profile to avoid a controller conflict or to hide broken saved state.
- Start reports a changed configuration: stop the profile, correct the settings with the same IDs and references, then start it.
- Display names and typing preferences need no restart.

## Installation or runtime fails

1. Missing command: run `command -v stelz bun node`. Install the missing executable (see [What you need](getting-started.md#what-you-need)) or add its `bin` directory to PATH. Use the same paths in the agent's MCP environment.
2. Run `stelz doctor` with the intended `STELZ_HOME`. Check `home`, `setup`, `node`, and `browserExecutable`.
3. If the CLI, UI, and MCP connection select different directories, correct their environments. See [Service directory precedence](configuration.md#service-directory-and-precedence).
4. Run `stelz setup` with the same service directory. It prepares a missing browser, runtime, or plugin and keeps existing profiles.
5. Run `stelz status` to find existing IDs. Create a missing `work` profile through [Getting started](getting-started.md).

- Setup does not recover profiles in another service directory.
- Do not remove profiles or reinstall Camoufox to repair a missing Bun command.
- Unsupported Camoufox build: check `CAMOUFOX_EXECUTABLE` in the process environment and in `STELZ_HOME/secrets.env`. The process environment takes precedence. Remove it or point it to the paired build, then run `stelz setup`. See [Browser executable](configuration.md#browser-executable).

## Setup fails

| Message or code | Action |
| --- | --- |
| `confirmation_required` | See [Installation and UI](cli.md#installation-and-ui). |
| Another stelz setup is running | Let it finish (a second setup waits up to one hour). Run `stelz setup` again. |
| Stop running profiles from an earlier Stelz version | Run `stelz status`, stop those profiles, run `stelz setup` again. |
| A release or integrity check failed | Check the network connection. Run `stelz setup` again. An interrupted setup keeps the active runtime. |

## Restart to update

Run `stelz restart work`, or `stelz restart all`. Restart closes the browser and pages and ends control. If the start fails, the profile stays stopped: run `stelz start work`.
See [Update Stelz](getting-started.md#update-stelz).

## Missing or stale control handle

1. Call `profile_status({profileId})`. Check whether the browser stopped, restarted, or changed controller.
2. Another client holds control: ask it to call `profile_release({profileId, controlHandle})`. For an operator handoff, run `stelz release work` or select **Release** in the UI and confirm. Require `controller: null` in live status.
3. Start a stopped browser explicitly.
4. Call `profile_acquire({profileId})` on the intended connection. Keep the new `controlHandle` with that profile ID.

- Handle lost: arrange an operator release and reconnect the client.
- Other rules: see [Control handles](mcp.md#control-handles).

## Profile is paused

1. Find the window: [Find a profile's windows](ui.md#find-a-profiles-windows).
2. Complete authentication or manual work in that window.
3. Run `stelz resume work` or call `profile_resume({profileId, controlHandle})`.
4. Require `phase: "ready"`.

- Resume fails verification: see [IP verification failed](#ip-verification-failed).
- Release does not resume a paused profile.

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

- Stopped profile: `stelz recheck work` runs preflight without starting a browser.
- Do not remove the fingerprint or native data to repair location alignment.

## IP verification failed

1. Run `stelz doctor work` and `stelz status work`. Read `configuration`, `error`, and `checkFailure`.
2. Correct the proxy or provider connection when the configured route is still correct.
3. Run `stelz recheck work`. Require `verificationStatus: "verified"` and the intended `exitIp`.
4. `phase` is `paused`: complete manual work, then run `stelz resume work`.

- Missing secret, invalid URL, changed credentials, or incorrect expected IP: stop `work`, save the corrected settings (see [Configure a proxy](proxies.md)), then start `work`. Recheck does not load changed network settings into a running browser.
- `verificationFresh: false` with `verificationStatus: "verified"`: the cached result expired. The next browser action checks again. `stelz recheck work` checks now.
- See [IP verification fields](configuration.md#ip-verification-fields) and [IP check policy](configuration.md#ip-check-policy).

## Browser action or IP check timed out

Known issue: a click or scroll can time out when the browser window is not in front, especially when other windows cover it. A scroll in a tab that is not selected has the same risk.

A timeout blocks further browser actions for that lifetime. The operation can still run. Recheck, release, and resume cannot clear the block. Limits: [Typing](configuration.md#typing).

1. Run `stelz status work` and `stelz logs work --lines 200`. Look for `blocked`, a time-limit error, or refusal of a replacement browser or context.
2. Run `stelz stop work`. Require `phase: "stopped"`. If stopping fails, see [Inspect an unclean lifetime](#inspect-an-unclean-lifetime).
3. Run `stelz start work`.
4. Acquire control again from the intended client.

## Inspect an unclean lifetime

1. Run `stelz doctor work` and `stelz logs work --lines 200`. Read `phase`, `supervisorPid`, `serverPid`, and both `ownership` verdicts.
2. `orphaned` with an owned server: run `stelz stop work`, then `stelz doctor work` again.
3. Inspect browser processes for this profile that outlived the recorded service.
4. After they exit and recorded ownership is resolved, run `stelz recover work`. Require `recovered: true`.
5. Run `stelz start work`.

- `different`: another process holds the PID. Do not signal it.
- `unverified`: stop for operator inspection.
- Keep process records and lock files while inspection is pending.
- Recovery cannot check surviving browser descendants.
- Do not signal unknown PIDs, delete native browser locks blindly, or replace the saved profile.

## Native data or fingerprint is unavailable

Run the [fingerprint check](cli.md#check-a-saved-fingerprint). It does not start a browser.

- `fingerprint_uninitialized`: no pin exists. This is not an invalid identity.
- `fingerprint_invalid`, or an unreadable or corrupt pin: restore the matching pin and data from a trusted backup.
- `fingerprint_engine_mismatch` or `fingerprint_engine_unavailable`: restore the matching Camoufox executable path.
- Missing `browser-data/`: restore the original matching directory while the profile is stopped.
- Do not remove the native marker or fingerprint to generate a replacement identity.
- No command repairs a fingerprint or migrates an engine.

## Configuration save or import is pending

1. Run `stelz doctor work` to read the network or import recovery message.
2. Keep `profiles.json`, `secrets.env`, the named journal, and its staging directories.
3. Interrupted save: retry the save with fresh UI state, or run `stelz start work` when you intend to start that profile.
4. Pending import: an explicit start or another configuration operation attempts journal recovery first.
5. Check the catalog before you import again. The first batch can already be present.

- Conflicting edits: inspect the named files first.
- Network journal: the profile must be cleanly stopped.
- `stelz recover work` handles browser process records, not these journals.
- See [Transactions and recovery](configuration.md#transactions-and-recovery).

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

See [Transfer profiles](profile-transfer.md).
