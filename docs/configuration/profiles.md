---
title: "Profile data"
description: "Profile catalog schema, files under STELZ_HOME, and the journals that block actions until recovery."
tags: [configuration, reference, profile]
sources: []
created: 2026-11-06T13:49:16Z
modified: 2026-11-11T15:01:55Z
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
| `typingMode` | String | Optional typing mode. Overrides the service default. See [Typing](typing.md). |

- Stelz rejects unknown properties. No inline proxy credential field. Reference names match `[A-Za-z_][A-Za-z0-9_]{0,127}`.
- Creation and import pick ports from `9377` through `65535`.

## Files and private state

- Paths are relative to `STELZ_HOME`, except a `CAMOUFOX_EXECUTABLE` override.
- Private directories: mode `0700`. Private state and secret files: mode `0600`.
- Do not replace service state or lock files while an operation is active.

| Path | Contents |
| --- | --- |
| `profiles.json`, `secrets.env` | Profile catalog. Referenced proxy values and optional service settings. |
| `runtime/` | Link to the current prepared runtime in `runtime-generations/`. |
| `runtime-generations/` | Prepared runtimes. Each holds `versions.json`, `camofox-VERSION/`, `geoip/`, and `fpgen/` (fingerprint model). |
| `profiles/ID/browser-data/` | Native persistent Firefox profile, including saved login state. |
| `profiles/ID/native-profile.json` | Native storage marker (`version: 1`). |
| `profiles/ID/fingerprint.json` | Saved device pin (`version: 2`, `engineSha256`, `config`). |
| `profiles/ID/cookies/`, `uploads/` | Saved cookie inputs. Reusable uploads. |
| `profiles/ID/storage/`, `window-addon/` | Upstream service data. The generated window add-on. |
| `profiles/ID/traces/`, `tmp/` | Traces. Temporary files. |
| `profiles/ID/access-key` | Loopback service key. |
| `profiles/ID/running.json`, `status.json` | Process record of a running lifetime. Observed state. |
| `profiles/ID/initialized.json`, `stopped.json` | Initialization receipt. Clean-stop receipt. |
| `profiles/ID/server.log`, `supervisor.log` | Current logs. Rotation can keep a `.1` file. |
| `trash/ID-TOKEN/` | Deleted profile: `profile/` (archived directory) and `profile.json` (its configuration). Shared secret values stay in `secrets.env`. |

- Device pins need the exact executable hash. No engine migration command.
- A changed executable or an invalid `fingerprint.json` blocks Start. Another browser needs a new profile.
- Start refuses to launch without the `fpgen/` fingerprint model. It never downloads it.
- Recovery: [Troubleshooting](../troubleshooting/lifetime-and-state.md).

## Transactions and recovery

| Journal in `STELZ_HOME` | Operation |
| --- | --- |
| `.profile-transaction.json` | Profile creation or deletion. |
| `.network-transaction.json` | Network configuration and secret changes. |
| `.profile-import-transaction.json` | Batch import. |

- Configuration operations and explicit starts complete pending transactions before their next change. Read-only status and doctor do not.
- Conflicting manual edits stop recovery.
- Recovery: [Troubleshooting](../troubleshooting/lifetime-and-state.md#configuration-save-or-import-is-pending).
