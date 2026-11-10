# Troubleshooting

Use the existing profile and its usual `STELZ_HOME`.
Inspect one affected profile before changing its lifecycle.
The examples use `work`. Substitute the actual stable ID when necessary.

## Stelz or Bun is missing from PATH

If the command itself cannot start, check the executables before running Stelz diagnostics:

```sh
command -v stelz
command -v bun
command -v node
```

An empty result means that executable is unavailable on this shell's PATH.
Add your existing installation's `bin` directory, or install the missing prerequisite through [Getting started](getting-started.md#what-you-need).
For a custom npm prefix, its `bin` directory must also be on PATH.
Keep the same runtime paths in your agent's MCP environment.
Do not remove profiles or reinstall Camoufox to repair a missing Bun command.

## Read the evidence

```sh
stelz doctor work
stelz status work
stelz logs work --lines 100
```

Doctor reports installation availability, configuration, and recorded process ownership.
Status adds live controller and verification details when the service responds.
Logs contain bounded server and supervisor tails.
Exit status `0` does not establish browser readiness. Read the returned fields.
See [CLI output and exit status](cli.md#errors-and-exit-status).

| Symptom | Diagnostic command | Meaningful result | Recovery |
| --- | --- | --- | --- |
| No profiles, or `Unknown profile` | `stelz doctor` and `stelz status` | Wrong `home`, `initialized: false`, or no entry for `work`. | [Check installation and home](#installation-or-service-directory-is-wrong). |
| Start requires setup or a matching plugin | `stelz doctor` and `stelz logs work` | `setup: false`, missing executable, or plugin mismatch. | [Prepare the runtime](#runtime-or-browser-executable-is-unavailable). |
| Setup fails | The setup error | `confirmation_required`, another setup, or an earlier runtime. | [Repair setup](#setup-fails). |
| **Restart to update** | `stelz status work` | `restartToUpdate: true`. | [Apply the update](#restart-to-update). |
| Agent tools are absent | `stelz status work` | Browser can be ready while the intended client has no connection. | [Check the client](#agent-tools-are-missing). |
| Controller is busy | `stelz status work` | `controller` identifies an active client. | [Arrange a handoff](#another-client-controls-the-profile). |
| Actions stop during authentication | `stelz status work` | `phase: "paused"`, with the controller retained. | [Complete manual work](#profile-is-paused). |
| IP verification fails | `stelz status work` and `stelz doctor work` | `verification_failed`, an unexpected IP, provider failure, or a configuration error. | [Repair the route](#ip-verification-failed). |
| Verification freshness is false | `stelz status work` | Last verdict is `verified`, but the cached result expired. | [Check freshness](#verification-is-no-longer-fresh). |
| Operation timed out | `stelz status work` and `stelz logs work` | `phase: "blocked"` with a deadline, typing timeout, or lost original context. | [Stop and start this profile](#browser-action-or-ip-check-timed-out). |
| Start refuses an old lifetime | `stelz doctor work` | `orphaned`, `unclean`, or `ownership_unknown`. | [Inspect the lifetime](#inspect-an-unclean-lifetime). |
| Start reports changed configuration | `stelz doctor work` and `stelz status work` | Active lifetime conflicts with launch settings. | [Apply configuration explicitly](#running-configuration-changed). |
| Saved browser data or fingerprint fails | `stelz logs work --lines 200` | Missing native data, corrupt pin, or changed executable hash. | [Restore matching state](#native-data-or-fingerprint-is-unavailable). |
| Save or import remains pending | `stelz doctor work` | Recovery message or pending import/network journal. | [Recover the transaction](#configuration-save-or-import-is-pending). |

## Choose the lifecycle action

| Action | Use it for | Browser and controller result |
| --- | --- | --- |
| Pause, then resume | Human authentication or manual work in the same window. | Browser stays open. Controller stays assigned. Resume performs any required fresh IP check. |
| Release | Deliberate controller handoff. | Browser and pages stay open. A pause remains a pause. Another client can acquire control. |
| Recheck | Failed or expired IP evidence after network repair. | Same browser and controller. A successful recheck preserves a pause. |
| Stop | Explicitly end the affected browser lifetime. | Current actions drain. Saved data remains. Start remains explicit. |
| Recover | Archive an unclean record after process inspection. | Does not stop processes or open a browser. Refuses live recorded processes and unknown ownership. |

Reading status does not acquire control.
An MCP disconnect preserves the browser and pages.
Never create another profile to avoid a controller conflict or to conceal broken saved state.

## Installation or service directory is wrong

1. Run `stelz doctor` with the intended `STELZ_HOME`.
2. Check the absolute `home` in its result.
3. Correct the environment for the CLI, UI, and MCP connection if they select different directories.
4. Run `stelz setup` only if that intended directory is not initialized.
5. Run `stelz status` to find existing IDs.
6. Create a missing `work` profile through [Getting started](getting-started.md).

Setup preserves existing entries. It does not recover profiles stored under another service directory.
See [Service directory precedence](configuration.md#service-directory-and-precedence).

## Runtime or browser executable is unavailable

1. Run `stelz doctor`.
2. Check `setup`, `node`, and `browserExecutable`.
3. Check dependency versions against [What you need](getting-started.md#what-you-need).
4. Run `stelz setup` with the same service directory. It prepares a missing browser, runtime, or plugin.
5. Run `stelz start work` when you need that browser.

If Start or setup reports an unsupported Camoufox build, check `CAMOUFOX_EXECUTABLE` in the process environment and `STELZ_HOME/secrets.env`.
Remove the setting, or point it to the paired build. Then run `stelz setup`.
The process environment takes precedence. See [How setup finds the browser](getting-started.md#how-setup-finds-the-browser).
For source or release preparation, see [Releasing](development/releasing.md).

## Setup fails

| Message or code | Action |
| --- | --- |
| `confirmation_required` | Setup needs downloads that nobody allowed. Run `stelz setup` in a terminal and confirm, or run `stelz setup --yes`. |
| Another stelz setup is running | A second setup waits up to one hour for the first one. Let the first setup finish. Then run `stelz setup` again. |
| Stop running profiles from an earlier Stelz version | Run `stelz status`. Stop those profiles when you can, then run `stelz setup` again. This applies once, to a runtime from an earlier version. |
| A release or integrity check failed | Check the network connection. Then run `stelz setup` again. An interrupted setup keeps the active runtime. |

## Restart to update

Setup prepared a new runtime while this profile was running. The profile continues to use its earlier runtime.
Run `stelz restart work` when you can close its browser and pages. Run `stelz restart all` for all running profiles.
Restart ends control. Clients must acquire the profile again.
If the start fails, the profile stays stopped. Follow [Read the evidence](#read-the-evidence), then run `stelz start work`.

## Agent tools are missing

1. Run `stelz status work` to establish the browser state separately.
2. Inspect the intended client's single MCP entry for `stelz mcp` and the correct service home.
3. Follow [Client connection verification](clients.md#verify-the-connection).
4. Reconnect or restart only that client when its registration requires it.

A saved MCP entry or a separate probe does not establish that the target session can control the browser.
Complete the fixture interaction and release check through the target client's actual tools.
Use [Bootstrap](bootstrap.md) for agent orchestration.

## Missing or stale control handle

1. Call `profile_status({profileId})` for the affected profile.
2. Check whether its browser stopped, restarted, or changed controller.
3. Resolve any controller conflict through the handoff procedure below.
4. Start a stopped browser explicitly when necessary.
5. Call `profile_acquire({profileId})` on the intended connection.
6. Retain the new `controlHandle` with that profile ID.
7. Read fresh tabs and snapshots with both fields before selecting an action.

Every successful acquisition returns a fresh handle for that connection, profile, and browser lifetime.
Status and list contain controller summaries without handles.
An existing acquisition blocks another acquisition on the same connection. Release its current handle before acquiring again.
If the handle is lost, arrange an operator release and reconnect the affected client.
Do not reuse handles after release, disconnect, browser restart, or forced handoff.
Never copy handles between connections or profiles. Do not replay an interrupted action automatically.

## Another client controls the profile

1. Run `stelz status work`.
2. Identify the active controller before taking control.
3. Ask that client to call `profile_release({profileId, controlHandle})` after its current action completes.
4. For an intended operator handoff, run `stelz release work` or select **Release controller** in the UI.
5. Check that `controller` is `null` in live status.
6. Call `profile_acquire({profileId})` from the next client's existing shared connection.
7. Use its new handle for that profile's control and browser calls.

Release keeps the browser, pages, storage, and current phase.
It does not transfer the previous client's reasoning or conversation history.

## Profile is paused

1. Keep the same browser window open.
2. Find it through the UI's window control and full profile title prefix.
3. Complete authentication or manual work in that window.
4. Run `stelz resume work` or call `profile_resume({profileId, controlHandle})` from the controller.
5. Require `phase: "ready"`.
6. Read a fresh snapshot before the next browser action.

Do not automate authentication challenges.
Showing a window does not pause actions. Pause before manual work.
If resume fails verification, use the next procedure. Release does not resume a paused profile.

## Location alignment blocks Start

Read **Location alignment** in the profile details, or run `stelz status work --json`.
The `location` result includes the check phase, time, reason, and recovery action.
A failed check remains visible after its startup attempt closes.

| Problem | Action |
| --- | --- |
| Location data is missing, damaged, or incompatible | Run `stelz setup`, then select **Check again**. |
| Location data is stale (`GEOIP_DATA_STALE`, strict policy) | Run `stelz setup` with network access, then check again. |
| Location databases disagree (`LOCATION_CONFLICT`, strict policy) | Use another proxy exit. To start anyway, set `STELZ_LOCATION_POLICY=warn`. |
| Proxy credentials are missing or rejected | Edit the proxy credentials, then check again. |
| Proxy connection fails or times out | Check the provider connection, then check again. |
| IP detection fails | Check again after the IP services respond. |
| Expected IP does not match | Check the proxy route and expected IP setting. |
| Exit IP has no complete location | Check the provider's exit location. Setup does not repair a missing location record. |
| Browser location does not match | Check the route, then start again. Inspect logs if the failure repeats. |

For a stopped profile, `stelz recheck work` runs preflight without starting a browser.
A successful check shows **Ready to start**. Start repeats the check before launch.
Do not delete the fingerprint or native data to repair location alignment.

## IP verification failed

1. Run `stelz doctor work` and `stelz status work`.
2. Read `configuration`, `error`, and `checkFailure`.
3. Correct the proxy or provider connection when the configured route is still correct.
4. Run `stelz recheck work`.
5. Require `verificationStatus: "verified"` and the intended `exitIp`.
6. If `phase` is `paused`, complete manual work before running `stelz resume work`.
7. Read a fresh snapshot before the next action.

A valid unexpected IP fails immediately. Another provider does not override that mismatch.
For a missing secret, invalid URL, changed credentials, or incorrect expected IP, stop `work` before editing.
Save the corrected settings through [Proxy tasks](proxies.md). Start `work` explicitly afterward.
Recheck does not load changed network settings into an existing browser.
A configured proxy never permits direct fallback.

## Verification is no longer fresh

Run `stelz status work`. Check `verificationRequired`, `verificationStatus`, `verificationFresh`, and `checkedAt`.
For a ready profile, `verified` with false freshness means the next required check cannot reuse cached evidence.
The next browser action performs a fresh required check. Use `stelz recheck work` for an explicit check now.
No polling occurs while the browser is idle.
A direct profile without an expected IP does not require verification.
See [IP check policy](configuration.md#ip-check-policy).

## Browser action or IP check timed out

1. Run `stelz status work` and `stelz logs work --lines 200`.
2. Look for `blocked`, a time-limit error, or refusal of a replacement browser/context.
3. Run `stelz stop work`.
4. Require `phase: "stopped"`. Inspect an unclean lifetime if stopping fails.
5. Run `stelz start work`.
6. Reacquire control from the intended client.
7. Read a fresh snapshot before deciding the next action.

The service bounds each browser action or IP check to 60 seconds.
A timed-out operation can remain active. The service blocks further browser actions for that lifetime.
Recheck, release, or resume cannot clear this terminal block.
An MCP client timeout does not cancel the service operation.
Do not replay an interrupted click, submission, or partially entered text automatically.

## Inspect an unclean lifetime

1. Run `stelz doctor work` and `stelz logs work --lines 200`.
2. Read `phase`, `supervisorPid`, `serverPid`, and both `ownership` verdicts.
3. For `orphaned` with an owned server, run `stelz stop work`.
4. Run `stelz doctor work` again after shutdown.
5. Inspect browser processes for this profile that outlived the recorded service.
6. After those processes exit and recorded ownership is resolved, run `stelz recover work`.
7. Require `recovered: true` and the archived record path when an old record existed.
8. Run `stelz start work` explicitly when ready.

`owned` means the recorded PID and process birth stamp match.
`different` means the PID now belongs to another process. Do not signal it.
`unverified` means ownership cannot be established. Stop here for process inspection by the operator.
A clean-stop receipt does not override unknown live ownership.
Recovery refuses recorded live processes and cannot check surviving browser descendants.
Keep process records and lock files while inspection is pending.

If the old record lacks a server identity or is invalid, automatic recovery can refuse it.
Inspect its state with the operator before manual repair.
Do not signal unknown PIDs, delete native browser locks blindly, or replace the saved profile.
See [Architecture](development/architecture.md) for ownership rules.

## Running configuration changed

Run `stelz doctor work` and `stelz status work` to check the active lifetime.
Run `stelz stop work` before changing launch settings.
Correct the intended settings while preserving IDs and references. Then run `stelz start work`.
Display names and profile typing preferences can change without this stop/start sequence.
See [Configuration](configuration.md).

## Native data or fingerprint is unavailable

Use `stelz logs work --lines 200` to distinguish missing native data from a fingerprint or engine mismatch.
Run the [fingerprint check](cli.md#check-a-saved-fingerprint) without starting a browser.
`fingerprint_uninitialized` means no pin exists. This does not indicate an invalid identity.
`fingerprint_invalid` reports static pin errors. `fingerprint_engine_mismatch` requires the matching executable.
`fingerprint_engine_unavailable` means the command could not read the configured executable.
For missing `browser-data/`, restore the original matching directory while the profile is stopped.
For an executable mismatch, restore the matching Camoufox executable path.
For a corrupt or missing pin with saved native data, restore the matching pin and data from a trusted backup.
Do not remove the native marker or fingerprint to generate replacement identity.
There is no fingerprint repair or engine migration command.

## Configuration save or import is pending

1. Run `stelz doctor work` to read any network or import recovery message.
2. Preserve `profiles.json`, `secrets.env`, the named journal, and its staging directories.
3. For a normal interrupted configuration save, retry the intended save with fresh UI state.
4. Alternatively, run `stelz start work` when you intend to start that profile.
5. For a pending import, an explicit start or another configuration operation attempts journal recovery first.
6. Check the catalog after recovery before importing again, because the first batch may already be present.

Read-only diagnostics do not complete transactions.
If recovery reports conflicting edits, inspect the named files before another mutation.
For a network journal, the affected profile must be cleanly stopped before recovery.
`stelz recover work` handles browser process records, not these journals.
See [Transaction reference](configuration.md#transactions-and-recovery) and [Testing](development/testing.md).

## UI session, window, or transfer fails

| Symptom | Diagnostic command or observation | Meaningful result | Exact next action |
| --- | --- | --- | --- |
| UI refuses an old session URL | Check the UI terminal and session browser. | Bootstrap token was already consumed, or the cookie belongs to another UI session. | Reload the authenticated browser. If unavailable, end only the UI command and run `stelz ui --open` for a new URL. |
| UI port is occupied | Run `stelz ui`. | Bind error on port `9380`. | Use the existing intended UI or run `stelz ui --port 9381 --open`. Leave the unknown listener intact. |
| Show window fails | Refresh **Browser windows** in Overview. | The page closed, the lifetime changed, or foreground activation failed. | Select a fresh entry. On macOS, select that browser manually before **Show window** again. |
| Transfer rejects active profiles | Run `stelz doctor work`. | Profile is running, unclean, or ownership is unknown. | Stop only selected export profiles. Inspect unclean lifetimes before retrying. |
| Import rejects compatibility | Read its preview or CLI error. | OS, architecture, or exact executable hash differs. | Use a matching destination installation. Do not edit the manifest to bypass the check. |
| Export output exists | Read the CLI error. | Destination archive path is occupied. | Use a new output filename. |
| Transfer exceeds a limit or lacks disk | Read the transfer error. | `too_large`, size/entry limit, or insufficient free space. | Free disk space or select fewer profiles. Change [transfer limits](configuration.md#archive-schema-and-limits) before a new CLI/UI session if appropriate. |

Use [Transfer profiles](profile-transfer.md) for cancellation, reload, and import steps.
