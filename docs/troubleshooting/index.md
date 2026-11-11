---
title: "Troubleshooting"
description: "Entrypoint for failures: the symptom table, the lifecycle actions, and links to each recovery procedure."
tags: [troubleshooting, recovery]
sources: []
created: 2026-11-06T13:49:16Z
modified: 2026-11-11T14:55:54Z
---

# Troubleshooting

Examples use profile `work` and the `STELZ_HOME` of the affected profile.
Inspect one profile before you change its lifecycle.

- [Installation and setup problems](setup.md) — recovery when installation, the runtime, or setup fails, and how to apply an update to running profiles.
- [Control problems](control.md) — recovery when a control handle is missing or stale, or when a profile stays paused.
- [Network problems](network.md) — recovery when location alignment blocks Start or the browser IP check fails.
- [Browser lifetime and saved state problems](lifetime-and-state.md) — recovery after a timed-out action, an unclean lifetime, unavailable native data, or a pending save or import.
- [UI and transfer problems](ui-and-transfer.md) — recovery when the UI session, a browser window control, or a profile transfer fails.

## Read the evidence

```sh
stelz doctor work
stelz status work
stelz logs work --lines 100
```

Exit status: [CLI output and exit status](../cli.md#errors-and-exit-status).

| Symptom | Check | Go to |
| --- | --- | --- |
| No profiles, or `Unknown profile` | `stelz doctor`: wrong `home`, or no entry for `work` | [Installation or runtime fails](setup.md#installation-or-runtime-fails) |
| Missing `stelz` or `bun` | `command -v stelz bun node` | [Installation or runtime fails](setup.md#installation-or-runtime-fails) |
| `setup: false` | `stelz doctor`: `initialized: false` | [Installation or runtime fails](setup.md#installation-or-runtime-fails) |
| Missing executable or plugin | `stelz doctor`: `browserExecutable` | [Installation or runtime fails](setup.md#installation-or-runtime-fails) |
| Setup fails | The setup error | [Setup fails](setup.md#setup-fails) |
| **Restart to update** | `restartToUpdate: true` in status | [Restart to update](setup.md#restart-to-update) |
| Agent tools are absent | Status shows a ready browser | [Verify the connection](../clients.md#verify-the-connection) |
| Tool call rejects the handle, or `controller` names another client | Status | [Missing or stale control handle](control.md#missing-or-stale-control-handle) |
| Actions stop during authentication | `phase: "paused"` | [Profile is paused](control.md#profile-is-paused) |
| Start is blocked by location | `stelz status work --json`: `location` reports a failed check | [Location alignment blocks Start](network.md#location-alignment-blocks-start) |
| IP verification fails, or `verificationFresh` is false | `verification_failed`, an unexpected IP, or an expired cached result | [IP verification failed](network.md#ip-verification-failed) |
| Operation timed out | `phase: "blocked"`, plus a deadline, typing timeout, or lost context in the logs | [Browser action or IP check timed out](lifetime-and-state.md#browser-action-or-ip-check-timed-out) |
| Start refuses an old lifetime | `stelz doctor`: `orphaned`, `unclean`, or `ownership_unknown` | [Inspect an unclean lifetime](lifetime-and-state.md#inspect-an-unclean-lifetime) |
| Saved browser data or fingerprint fails | Logs: missing native data, corrupt pin, or changed executable hash | [Native data or fingerprint is unavailable](lifetime-and-state.md#native-data-or-fingerprint-is-unavailable) |
| Save or import remains pending | `stelz doctor`: recovery message or pending journal | [Configuration save or import is pending](lifetime-and-state.md#configuration-save-or-import-is-pending) |
| UI, window, or transfer fails | The error | [UI session, window, or transfer fails](ui-and-transfer.md) |

## Choose the lifecycle action

| Action | Use it for |
| --- | --- |
| Pause, then resume | Human authentication or manual work in the same window. |
| Release | Deliberate controller handoff. |
| Recheck | Failed or expired IP evidence after network repair. |
| Stop | Explicitly end the browser lifetime. |
| Recover | Archive an unclean record after process inspection. |

Command effects: [CLI](../cli.md#browser-lifecycle-and-diagnostics).

- Never create another profile to avoid a controller conflict or to hide broken saved state.
- Start reports a changed configuration: stop the profile, correct the settings with the same IDs and references, then start it.
