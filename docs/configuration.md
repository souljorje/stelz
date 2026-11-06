# Configuration reference

Use [the local UI](ui.md) for routine profile changes.
Use [Proxy tasks](proxies.md) for network changes and [Transfer profiles](profile-transfer.md) for moving saved data.
This page describes supported settings, file formats, and limits.

## Service directory and precedence

`STELZ_HOME` selects the service directory. Its default is `~/.local/share/stelz`.
Supply an absolute path to keep each CLI, UI, and MCP connection on the same service.
A relative value resolves against the process's current directory.
The current project and client PID do not select profile storage.
The installed CLI disables automatic project `.env` loading.

For settings that use `secrets.env`, resolution follows this order:

1. The process environment value, including an empty string.
2. The assignment in `STELZ_HOME/secrets.env`.
3. The setting's default.

`STELZ_HOME` and transfer limits use only the process environment.
They do not read assignments from `secrets.env`.
An empty `STELZ_HOME` uses the default directory.
An empty effective `CAMOUFOX_EXECUTABLE` uses its default path.
Empty typing and IP interval values are invalid.
Supply an absolute executable path. Stelz does not expand a literal `~` in that setting.

`secrets.env` uses dotenv-style assignments parsed with Node's `parseEnv`.
It is a data file, not a shell script.
Keep credentials out of client configuration and reports.
Preserve existing secret reference names when changing a value.

## Environment settings

| Setting | Source | Accepted value and default |
| --- | --- | --- |
| `STELZ_HOME` | Process only | Service directory. Default: `~/.local/share/stelz`. |
| `CAMOUFOX_EXECUTABLE` | Process, then `secrets.env` | Existing Camoufox executable path. Default: `~/Library/Caches/camoufox/Camoufox.app/Contents/MacOS/camoufox`. |
| `STELZ_TYPING_MODE` | Process, then `secrets.env` | `auto`, `keyboard`, or `instant`. Default: `auto`. |
| `STELZ_IP_CHECK_INTERVAL_MS` | Process, then `secrets.env` | Decimal integer from `0` to `120000`, without leading zeros. Default: `120000`. |
| Name in `proxyEnv` | Process, then `secrets.env` | Complete HTTP(S) or unauthenticated SOCKS5 URL. Missing or empty values block a configured proxy. |
| Name in `expectedIPEnv` | Process, then `secrets.env` | Exact IPv4 or IPv6 address. Missing or empty values omit the expected-address constraint. |
| `STELZ_TRANSFER_ARCHIVE_BYTES` | Process only | Positive safe integer. Default: `10737418240` bytes, or 10 GiB. |
| `STELZ_TRANSFER_EXPANDED_BYTES` | Process only | Positive safe integer. Default: `10737418240` bytes, or 10 GiB. |
| `STELZ_TRANSFER_ENTRIES` | Process only | Positive safe integer. Default: `100000` entries. |
| `STELZ_TRANSFER_MANIFEST_BYTES` | Process only | Positive safe integer. Default: `67108864` bytes, or 64 MiB. |

A configured proxy always requires verification, even without an expected IP.
See [Supported proxy URLs](proxies.md#supported-proxy-urls) for exact input restrictions.
Expected IP values cannot contain a port, CIDR prefix, hostname, or IPv6 zone suffix.

Stop and start the affected profile to apply executable, network, service typing, or IP interval changes.
The running browser receives these settings at launch.
Start refuses a changed launch configuration while its previous lifetime remains active.
Profile display names and profile typing preferences can change while the browser runs.
Set transfer limits before invoking a CLI transfer or starting the UI.

The supervisor supplies internal `STELZ_PROFILE_*`, `STELZ_EXPECTED_IP`, `CAMOFOX_*`, and `PROXY_*` values.
These values are not user configuration inputs.
Generic `HTTP_PROXY` or `HTTPS_PROXY` variables do not select a profile's browser route.

## Profile catalog schema

`profiles.json` accepts one top-level property: `profiles`, an array.
Init creates `{ "profiles": [] }`. Prefer the UI or `stelz profile create work` to manual creation.

```json
{
  "profiles": [
    { "id": "work", "port": 9377, "storage": "native" }
  ]
}
```

| Field | Type | Requirement |
| --- | --- | --- |
| `id` | String | Required. Matches `[a-z][a-z0-9-]{0,63}`. Unique in the catalog. Creation and transfer reserve `all`. |
| `port` | Integer | Required. From `1024` to `65535`. Unique in the catalog. The browser service binds to loopback. |
| `name` | String | Optional display name. From 1 to 80 UTF-16 code units. No surrounding whitespace, control characters, or directional controls. |
| `storage` | String | Optional for existing entries. The only accepted value is `native`. New profiles set it explicitly. |
| `proxyEnv` | String | Optional secret reference. Its presence selects a proxy. Its absence selects direct networking. |
| `expectedIPEnv` | String | Optional reference for an expected exit IP. Applies to direct or proxy connections. |
| `typingMode` | String | Optional `auto`, `keyboard`, or `instant`. Overrides the service typing default. |

The catalog rejects unknown properties at both levels.
Reference names match `[A-Za-z_][A-Za-z0-9_]{0,127}`.
There is no connection-mode field and no inline proxy credential field.
A missing or invalid configured proxy never changes a profile to direct networking.

Creation and import search for available ports from `9377` through `65535`.
An existing profile retains its ID, port, data directory, and secret references during compatible reuse.
The UI can change a display name without changing the stable ID.
There is no global limit on saved profiles or active browsers.
Each profile permits one browser instance. Memory, disk, and available loopback ports constrain capacity.

## Typing

Typing selection follows this order:

1. The `camofox_type` call's explicit `mode`.
2. The selected profile's `typingMode`.
3. The service's effective `STELZ_TYPING_MODE` at launch.
4. `auto`.

| Mode | Behavior |
| --- | --- |
| `auto` | Uses variable keystroke timing and random pauses for estimated durations of at most 10 seconds. Longer input uses bulk entry. |
| `keyboard` | Sends individual key events without artificial delays. |
| `instant` | Uses Playwright `fill()` to enter the complete value. |

The service selects the automatic method before changing the field.
Typing replaces existing contents. Empty text clears the field.
Unicode text and native newline normalization remain intact.
Date and similar inputs retain specialized input behavior.
The service does not deliberately insert errors.

The UI saves a profile preference for future actions without a browser restart.
A call override applies only to that call.
Typing retains the tab lock until it completes.
A timeout blocks further actions and requires an explicit stop and start of that profile.
For incomplete input without a timeout, read a fresh snapshot before another action.
The service does not replay partially entered text.

## IP verification fields

See [IP check policy](#ip-check-policy) for providers, timing, and failure behavior.
Live CLI or MCP status can report these fields:

| Field | Meaning |
| --- | --- |
| `verificationRequired` | True for a proxy or a nonempty expected IP. False for direct networking without an expected IP. |
| `verificationIntervalMs` | Maximum reusable age of a successful check for this browser lifetime. |
| `verificationStatus` | Last verdict: `unverified`, `verified`, or `verification_failed`. Separate from browser phase. |
| `verificationFresh` | Whether the next action can reuse the successful result. Expiry alone does not change the last verdict. |
| `checkedAt` | Time of the last successful check. A later failure can retain this timestamp. |
| `exitIp` | Last successful exit IP. A failed check clears it. |
| `expectedIp` | Required address reported after a successful check, or `null` when no address is required. |
| `fixedIpVerified` | True only after a successful proxied check with a nonempty expected IP. |
| `checkFailure` | Bounded failure detail, such as an unexpected IP or unavailable providers. |

A direct profile without an expected IP does not need a successful check or `verificationFresh: true`.
A stopped profile can retain old status fields. Check `phase` and process ownership first.

## IP check policy

Every proxy requires a successful browser-side IP check. An expected IP adds an exact address requirement.
A direct profile requires a check only when its effective expected IP is nonempty.
Checks use the selected persistent browser and its configured route, including the proxy.
Keep the service's reserved IP-check tab open.

The first provider is ipify. Cloudflare trace is the independent fallback for failed requests or invalid responses.
After fallback succeeds, later checks try that successful provider first.
A valid unexpected IP fails immediately. The service does not try another provider after a mismatch.

Startup, resume, and explicit recheck require a fresh check when verification is required.
Other browser actions reuse success for at most `STELZ_IP_CHECK_INTERVAL_MS`, with a default of two minutes.
The accepted interval is an integer from `0` to `120000` milliseconds.
Value `0` requires a fresh check before each browser action.
Idle browsers do not poll IP providers. The first action after expiry must check again.

Recognized browser proxy, DNS, or connection failures invalidate cached verification.
The same action queue performs a fresh check. It does not replay the failed browser action.
A failed check blocks browser actions and records `verification_failed`.
An expired successful verdict remains visible, but `verificationFresh` becomes false.
See [Verification fields](#ip-verification-fields).

Proxy policy disables direct failover and WebRTC. It enables DNS resolution through SOCKS proxies.
Only the configured loopback bypass hosts, `127.0.0.1` and `localhost`, bypass the proxy.
The route remains mandatory during cached verification.
External requests fail when the proxy route fails. Local snapshots or tab lists can still succeed during that interval.

Verification measures network health at check time. It does not guarantee continuous IP stability or provide a host network kill switch.
Stelz does not install host firewall or container egress rules.
Saved device properties cannot override the current proxy security policy.
Proxy locale uses the current GeoIP country's default language, unless an explicit upstream locale list takes precedence.
See [Camofox integration](development/camofox-integration.md) for launch and locale details.

## Files and private state

Paths below are relative to `STELZ_HOME`, except the separately installed Camoufox executable.
Managed private directories use mode `0700`. Managed private state and secret files use mode `0600`.
Do not replace service state or lock files while an operation is active.

| Path | Contents |
| --- | --- |
| `profiles.json` | Profile catalog. |
| `secrets.env` | Referenced proxy values and optional service settings. |
| `runtime/versions.json` | Prepared runtime versions, executable path, and `executableSha256`. |
| `runtime/camofox-VERSION/` | Prepared upstream server, contracts, dependencies, and local plugin. |
| `profiles/ID/browser-data/` | Native persistent Firefox profile, including saved login state. |
| `profiles/ID/native-profile.json` | Native storage marker with `version: 1`. |
| `profiles/ID/fingerprint.json` | Saved device pin with `version: 2`, `engineSha256`, and `config`. |
| `profiles/ID/cookies/`, `profiles/ID/uploads/` | Saved cookie inputs and reusable uploads. |
| `profiles/ID/storage/`, `profiles/ID/traces/`, `profiles/ID/tmp/` | Upstream service storage, traces, and temporary files. |
| `profiles/ID/window-addon/` | Generated add-on for profile labels and window controls. |
| `profiles/ID/access-key` | Private authentication key for the profile's loopback service. |
| `profiles/ID/running.json` | Supervisor/server PIDs, process birth stamps, instance ID, port, and launch configuration hash. |
| `profiles/ID/status.json`, `profiles/ID/initialized.json`, `profiles/ID/stopped.json` | Observed state, completed initialization, and clean-stop receipt. |
| `profiles/ID/server.log`, `profiles/ID/supervisor.log` | Current logs. Rotation can preserve a `.1` file. |
| `profiles/admission.lock`, `profiles/ID/lifecycle.lock` | Kernel-backed operation locks. Their continued presence does not establish a live owner. |
| `trash/ID-TOKEN/profile.json`, `trash/ID-TOKEN/profile/` | Deleted profile configuration and archived directory. Shared secret values remain in `secrets.env`. |
| `.profile-transfers/` | Private CLI/UI archive and extraction staging. |
| `profiles/.profile-import-TOKEN/` | Journal-owned staging for an import batch. |

If a marked native profile loses `browser-data/`, restore that original directory before starting it.
Do not delete the marker to obtain a substitute profile.
Device pins require the exact executable hash. This release has no engine migration command.
Current locale, location, and security policies remain independent of saved device properties.
See [Camofox integration](development/camofox-integration.md) for pin and launch behavior.

## Archive schema and limits

Profile transfer uses ZIP with ZIP64 support and a UTF-8 `manifest.json`.
The archive contains no encryption. Encrypted ZIP entries are unsupported.
Readers accept stored or deflated regular files and directories.

| Manifest field | Format |
| --- | --- |
| `format`, `version` | `"stelz-profiles"`, `1`. |
| `createdAt` | UTC ISO timestamp. |
| `source` | `stelzVersion`, `platform`, `arch`, and lowercase SHA-256 `engineSha256`. |
| `profiles` | Nonempty array of portable profile records. |
| `directories` | Array of relative directory paths. |
| `files` | Array of `{ path, size, sha256 }` records. Sizes are nonnegative safe integers. |

Portable records require `id` and `storage: "native"`.
Optional fields are `name`, `typingMode`, `proxy`, and `expectedIp`.
Export records the effective typing mode, including an inherited service default.
Import stores this mode as a profile preference.

An absent `proxy` means direct networking.
`proxy: { "url": "..." }` contains the available proxy URL and credentials.
`proxy: {}` preserves proxy intent when credentials were unavailable at export.
Import assigns a new secret reference without a value for that case. Startup remains blocked until its proxy is configured.
`expectedIp` contains a literal address or an empty string.

Durable entries are under `profiles/ID/`: `fingerprint.json`, `native-profile.json`, `browser-data/`, `cookies/`, and `uploads/`.
Native SQLite sidecar files remain included.
Export excludes root browser locks `.parentlock`, `parent.lock`, and `lock` from `browser-data/`.
It excludes runtime records, keys, logs, generated add-ons, traces, and temporary files.
The executable, global service settings, and client configuration are not archive contents.

Import rejects unsafe paths, links, special files, duplicate or conflicting paths, undeclared entries, invalid sizes, and failed hashes.
Compatibility requires the same operating system, CPU architecture, and exact local executable SHA-256.
Saved fingerprints must match that engine. Import does not migrate storage or browser versions.

| Limit | Default | Scope |
| --- | --- | --- |
| Compressed archive | 10 GiB | Complete ZIP file. |
| Expanded data | 10 GiB | Expanded files, including the manifest. |
| Entries | 100,000 | Files and directories, including `manifest.json`. |
| Manifest | 64 MiB | Serialized manifest bytes. |
| Native marker | 64 KiB | Each transferred `native-profile.json`. |
| Fingerprint pin | 16 MiB | Each transferred `fingerprint.json`. |
| Secrets | 1 MiB | Complete service secrets file after import. |

Transfer overrides accept decimal integers from `1` through `9007199254740991`, without leading zeros.
These are per-transfer limits, not saved-profile count limits.
Catalog files and their transaction journals have no fixed byte ceiling.
Ordinary UI JSON requests retain a 16 KiB limit. Bulk transfer metadata uses a separate 16 MiB limit.
Allow disk space for the ZIP, expanded files, and the staged snapshot or import batch.
Inactive UI transfers expire after 30 minutes. An active import does not expire during commit.

## Transactions and recovery

| Journal | Operation |
| --- | --- |
| `.profile-transaction.json` | Profile creation or deletion. |
| `.network-transaction.json` | Network configuration and related secret changes. |
| `.profile-import-transaction.json` | Batch import, including staged data, secrets, and catalog publication. |

Configuration operations and explicit starts complete pending transactions before their next change.
Read-only status and doctor calls do not complete them.
Import stages and checks data before publishing the selected batch through one catalog replacement.
Recovery follows the journal's saved commit or rollback direction.
Conflicting manual edits stop recovery for inspection.
Keep journals and their staging directories while recovery is pending.

`stelz recover ID` archives an unclean browser lifetime. It is not a command to repair configuration journals.
Use [Troubleshooting](troubleshooting.md#configuration-save-or-import-is-pending) for the applicable next action.
For implementation details, read [Architecture](development/architecture.md), [Testing](development/testing.md),
[Releasing](development/releasing.md), and [Camofox integration](development/camofox-integration.md).
