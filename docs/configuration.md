---
title: "Configuration reference"
description: "Settings, precedence, browser executable, paths, schemas, typing modes, IP verification, location data, and archive limits, to read when you check an exact value or file."
tags: [configuration, reference]
sources: []
created: 2026-11-06T13:49:16Z
modified: 2026-11-11T14:27:18Z
---

# Configuration reference

Profile changes: see [the local UI](ui.md) and [Configure a proxy](proxies.md).

## Service directory and precedence

- `STELZ_HOME` selects the service directory. Default: `~/.local/share/stelz`.
- Use an absolute path, so that each CLI, UI, and MCP connection uses the same service. The current project and client PID do not select profile storage.
- Order for settings that use `secrets.env`: process environment value (an empty string counts), then `STELZ_HOME/secrets.env`, then the default. `STELZ_HOME` and transfer limits use only the process environment.
- Empty `STELZ_HOME` or `CAMOUFOX_EXECUTABLE`: uses its default. Empty typing, IP interval, or location policy value: invalid.
- `secrets.env` is a dotenv-style data file, not a shell script. Keep credentials out of client configuration and reports.

## Environment settings

| Setting | Source | Accepted value and default |
| --- | --- | --- |
| `STELZ_HOME` | Process only | Service directory. Default: `~/.local/share/stelz`. |
| `CAMOUFOX_EXECUTABLE` | Process, then `secrets.env` | Absolute path to the paired Camoufox build. Stelz does not expand `~`. See [Browser executable](#browser-executable). |
| `STELZ_TYPING_MODE` | Process, then `secrets.env` | `balanced`, `keyboard`, or `instant`. Default: `keyboard`. |
| `STELZ_IP_CHECK_INTERVAL_MS` | Process, then `secrets.env` | Decimal integer from `0` to `120000`, without leading zeros. Default: `120000`. |
| `STELZ_LOCATION_POLICY` | Process, then `secrets.env` | `warn` or `strict`. Default: `warn`. See [Managed location data](#managed-location-data). |
| Name in `proxyEnv` | Process, then `secrets.env` | Proxy URL. Missing or empty: blocks the proxy. See [Supported proxy URLs](proxies.md#supported-proxy-urls). |
| Name in `expectedIPEnv` | Process, then `secrets.env` | Expected IP. Missing or empty: no constraint. See [Supported proxy URLs](proxies.md#supported-proxy-urls). |
| `STELZ_TRANSFER_*` | Process only | Transfer limits. See [Archive schema and limits](#archive-schema-and-limits). |

- A running browser gets the executable, network, service typing, and IP interval settings at launch. A change needs stop and start of the profile. Start refuses a changed launch configuration while the previous lifetime is active.
- `HTTP_PROXY` and `HTTPS_PROXY` do not select a profile's route.

## Browser executable

Supported build: only the one that the launcher pairs with, currently `156.0.1-beta.36`.
Setup uses the first available source:

1. The executable in `CAMOUFOX_EXECUTABLE`, if set.
2. Stelz's own copy in `STELZ_HOME/browsers/<version>-<build>/`.
3. The paired build in the upstream Camoufox cache. Setup copies it into `STELZ_HOME/browsers/` and does not change the cache.
4. A download of the paired release. Setup verifies the published SHA-256 digest.

- Another installation of the paired build: set `CAMOUFOX_EXECUTABLE` to the absolute path of the executable inside `Camoufox.app/Contents/MacOS/`, not the `camoufox` command on PATH. Otherwise leave it unset.
- A file that is not the paired build: setup fails and tries no other source. Start also rejects other builds. Stelz does not upgrade a profile's browser.

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

## Typing

Mode order: the `camofox_type` call's `mode`, the profile's `typingMode`, the service's `STELZ_TYPING_MODE` at launch, `keyboard`.

| Mode | Behavior |
| --- | --- |
| `balanced` | Paced typing when the estimated duration, including corrections, is at most 10 seconds. Longer input uses bulk entry. |
| `keyboard` | Variable keystroke timing and random pauses. Never uses bulk entry, even for long text. |
| `instant` | Playwright `fill()` enters the complete value. |

| Action | Limit | Service waits |
| --- | --- | --- |
| Click, navigation, scroll, snapshot, screenshot | 30 seconds | 60 seconds |
| One `camofox_type` call | 3 minutes | 3.5 minutes |

- Keyboard text that cannot finish within 3 minutes fails before the field changes. Use `balanced` or `instant`.
- A timeout blocks further actions. It needs an explicit stop and start of that profile. The service does not replay partially entered text.
- Typing replaces existing contents. Empty text clears the field. `auto` is not a valid mode.

## IP verification fields

Live CLI and MCP status report these fields.

| Field | Meaning |
| --- | --- |
| `verificationRequired` | True for a proxy or a nonempty expected IP. False for direct networking without an expected IP. |
| `verificationStatus` | Last verdict: `unverified`, `verified`, or `verification_failed`. Separate from browser phase. |
| `verificationFresh` | Whether the next action can reuse the successful result. Expiry alone does not change the last verdict. |
| `checkedAt`, `exitIp` | Time and exit IP of the last successful check. A later failure can keep `checkedAt`. A failed check clears `exitIp`. |
| `fixedIpVerified` | True only after a successful proxied check with a nonempty expected IP. |
| `checkFailure` | Bounded failure detail, such as an unexpected IP or unavailable providers. |

A stopped profile can keep old fields. Check `phase` first.

## IP check policy

- Preflight: every new proxied lifetime first checks its route and managed location data. See [Location checks](proxies.md#location-checks). It never authorizes a later start from cached evidence.
- Browser-side check: each browser then needs a successful check. It runs in the browser background through the configured route and opens no visible page.
- A configured proxy always requires verification. A direct profile requires it only with an expected IP. An expected IP adds an exact address requirement.
- Providers: ipify, then Cloudflare trace as fallback for a failed request or invalid response. After a fallback succeeds, later checks try it first. A valid unexpected IP fails at once, with no other provider tried.
- Startup, resume, and explicit recheck need a fresh check. Other actions reuse a success for at most `STELZ_IP_CHECK_INTERVAL_MS`. `0`: fresh check before each action. Idle browsers do not poll providers.
- A recognized proxy, DNS, or connection failure invalidates the cache. The same action queue runs a fresh check. It does not replay the failed action.
- A failed check in an existing session blocks browser actions and records `verification_failed`. A failed initial location check closes only that startup attempt. Its `location` diagnostic stays.
- Proxy policy: no direct failover, no WebRTC, DNS through SOCKS proxies. Only `127.0.0.1` and `localhost` bypass the proxy.
- Proxy route down: external requests fail. Local snapshots and tab lists can still succeed. Stelz installs no host firewall or kill switch.

## Managed location data

`stelz setup` prepares two databases under `runtime/geoip/` for all profiles.

- GeoIP AIO selects the location. No city or accuracy.
- GeoLite2 City is the comparison. City and accuracy radius for many addresses.
- Build at most 8 days old: setup reuses it without contacting its download service. Older build: setup downloads the latest release only when it differs. Offline, setup keeps the validated older build.
- An interrupted download preserves the active databases. Start does not download missing data.

Each preflight compares the selected location with the comparison record for the exit IP:

| Result | Meaning |
| --- | --- |
| `corroborated` | A city-level record (accuracy radius at most 100 km) has the same UTC offsets in January and July. |
| `uncorroborated` | The record is broader, has no timezone, or is missing. Missing metadata is not evidence against the selection. |
| `conflicting` | A city-level record has different UTC offsets. |

- A build older than 30 days is stale.
- `STELZ_LOCATION_POLICY=warn`: Start reports a conflict or stale data and continues. `strict`: Start blocks it before launch.
- A rotated exit gets its own comparison. `strict` blocks it on a conflict.
- Before Ready, Stelz checks that the browser applies the prepared timezone and language. A passed check does not confirm a physical location.
- Stelz does not grant websites location permission.

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

## Archive schema and limits

- Format: ZIP (ZIP64 supported) with a UTF-8 `manifest.json`.
- No encryption. Encrypted ZIP entries are unsupported.

| Manifest field | Format |
| --- | --- |
| `format`, `version` | `"stelz-profiles"`, `1`. |
| `createdAt`, `source` | UTC ISO timestamp. `stelzVersion`, `platform`, `arch`, and lowercase SHA-256 `engineSha256`. |
| `profiles` | Nonempty array of portable records: `id` and `storage: "native"`, plus optional `name`, `typingMode`, `proxy`, `expectedIp`. |
| `directories`, `files` | Relative directory paths. `{ path, size, sha256 }` records with nonnegative safe-integer sizes. |

- `proxy` absent: direct. `proxy: { "url": "..." }`: proxy URL and credentials. `proxy: {}`: proxy intent without credentials. Import assigns a secret reference without a value. Start stays blocked until you configure the proxy.
- `expectedIp`: literal address or empty string.
- Per profile: `fingerprint.json`, `native-profile.json`, `browser-data/` (without root locks `.parentlock`, `parent.lock`, `lock`), `cookies/`, `uploads/`. Excluded: runtime records, keys, logs, add-ons, traces, temporary files, the executable, global settings, client configuration.
- Import rejects unsafe paths, links, special files, duplicate paths, undeclared entries, invalid sizes, and failed hashes.
- Import needs the same operating system, CPU architecture, and exact local executable SHA-256. It does not migrate storage or browser versions.

| Limit | Default | Override (process environment) |
| --- | --- | --- |
| Compressed archive | 10 GiB | `STELZ_TRANSFER_ARCHIVE_BYTES` (bytes) |
| Expanded data, including the manifest | 10 GiB | `STELZ_TRANSFER_EXPANDED_BYTES` (bytes) |
| Entries, including `manifest.json` | 100,000 | `STELZ_TRANSFER_ENTRIES` |
| Manifest | 64 MiB | `STELZ_TRANSFER_MANIFEST_BYTES` (bytes) |
| Each `native-profile.json`, each `fingerprint.json` | 64 KiB, 16 MiB | None |
| Service secrets file after import | 1 MiB | None |

- Override: decimal integer from `1` through `9007199254740991`, no leading zeros. Set it before a CLI transfer or UI start.
- Inactive UI transfers expire after 30 minutes. An active import does not expire during commit.

## Transactions and recovery

| Journal in `STELZ_HOME` | Operation |
| --- | --- |
| `.profile-transaction.json` | Profile creation or deletion. |
| `.network-transaction.json` | Network configuration and secret changes. |
| `.profile-import-transaction.json` | Batch import. |

- Configuration operations and explicit starts complete pending transactions before their next change. Read-only status and doctor do not.
- Conflicting manual edits stop recovery. Keep journals and their staging directories while recovery is pending.
- `stelz recover ID` archives an unclean browser lifetime. It does not repair these journals. See [Troubleshooting](troubleshooting.md#configuration-save-or-import-is-pending).
