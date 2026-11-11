---
title: "Browser lifetime and saved state problems"
description: "Recovery after a timed-out action, an unclean lifetime, unavailable native data, or a pending save or import."
tags: [troubleshooting, recovery, profile]
sources: []
created: 2026-11-06T13:49:16Z
modified: 2026-11-11T14:44:20Z
---

# Browser lifetime and saved state problems

## Browser action or IP check timed out

Known issue: a click or scroll can time out when the browser window is not in front, especially when other windows cover it. A scroll in a tab that is not selected has the same risk.

A timeout blocks further browser actions for that lifetime. The operation can still run. Recheck, release, and resume cannot clear the block. Limits: [Typing](../configuration/typing.md).

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

Run the [fingerprint check](../cli.md#check-a-saved-fingerprint). It does not start a browser.

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
- See [Transactions and recovery](../configuration/profiles.md#transactions-and-recovery).
