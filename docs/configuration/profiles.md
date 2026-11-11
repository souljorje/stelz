---
title: "Profile data"
description: "Profile catalog schema, files under STELZ_HOME, and the journals that block actions until recovery."
tags: [configuration, reference, profile]
sources: []
created: 2026-11-06T13:49:16Z
modified: 2026-11-11T14:44:20Z
---

# Profile data

## Profile catalog schema

`profiles.json`: one top-level property, `profiles`, an array. Prefer the UI or `stelz profile create` to manual edits.

| Field | Type | Requirement |
| --- | --- | --- |
| `id` | String | Required. Matches `[a-z][a-z0-9-]{0,63}`. Unique. `all` is reserved. |
| `port` | Integer | Required. From `1024` to `65535`. Unique. The browser service binds to loopback. |
| `name` | String | Optional display name. From 1 to 80 UTF-16 code units. No surrounding whitespace, control characters, or directional controls. |
| `storage` | String | Optional for existing entries. Only `native` is valid. New profiles set it. |
| `proxyEnv`, `expectedIPEnv` | String | Optional secret references. `proxyEnv` present: proxy. Absent: direct networking. `expectedIPEnv` sets an expected exit IP for direct and proxy connections. |
| `typingMode` | String | Optional `balanced`, `keyboard`, or `instant`. Overrides the service default. |

- Unknown properties are rejected. No inline proxy credential field. Reference names match `[A-Za-z_][A-Za-z0-9_]{0,127}`.
- A missing or invalid configured proxy never changes a profile to direct networking.
- Creation and import pick ports from `9377` through `65535`. No global limit on saved profiles or active browsers.

## Files and private state

- Paths are relative to `STELZ_HOME`, except a `CAMOUFOX_EXECUTABLE` override.
- Private directories: mode `0700`. Private state and secret files: mode `0600`.
- Do not replace service state or lock files while an operation is active.

| Path | Contents |
| --- | --- |
| `profiles.json`, `secrets.env` | Profile catalog. Referenced proxy values and optional service settings. |
| `runtime/`, `runtime-generations/` | `runtime/` links to the current prepared runtime in `runtime-generations/`. A runtime holds `versions.json`, `camofox-VERSION/`, `geoip/`, and `fpgen/` (fingerprint model). |
| `profiles/ID/browser-data/` | Native persistent Firefox profile, including saved login state. |
| `profiles/ID/native-profile.json`, `fingerprint.json` | Native storage marker (`version: 1`). Saved device pin (`version: 2`, `engineSha256`, `config`). |
| `profiles/ID/cookies/`, `uploads/`, `storage/`, `traces/`, `tmp/`, `window-addon/` | Saved cookie inputs, reusable uploads, upstream service data, traces, temporary files, and the generated window add-on. |
| `profiles/ID/access-key`, `running.json`, `status.json`, `initialized.json`, `stopped.json` | Loopback service key, process record of a running lifetime, observed state, and initialization and clean-stop receipts. |
| `profiles/ID/server.log`, `supervisor.log` | Current logs. Rotation can keep a `.1` file. |
| `trash/ID-TOKEN/` | Deleted profile configuration and archived directory. Shared secret values stay in `secrets.env`. |

- A marked native profile that loses `browser-data/`: restore that original directory before you start it. Do not delete the marker to get a substitute profile.
- Device pins need the exact executable hash. No engine migration command.

## Transactions and recovery

| Journal in `STELZ_HOME` | Operation |
| --- | --- |
| `.profile-transaction.json` | Profile creation or deletion. |
| `.network-transaction.json` | Network configuration and secret changes. |
| `.profile-import-transaction.json` | Batch import. |

- Configuration operations and explicit starts complete pending transactions before their next change. Read-only status and doctor do not.
- Conflicting manual edits stop recovery. Keep journals and their staging directories while recovery is pending.
- `stelz recover ID` archives an unclean browser lifetime. It does not repair these journals. See [Troubleshooting](../troubleshooting/lifetime-and-state.md#configuration-save-or-import-is-pending).
