# CLI reference

Use [Getting started](getting-started.md) for installation and the first profile.
Use [the local UI](ui.md) for profile management.
This page describes the installed `stelz` command.

## Command conventions

`ID` is a stable profile ID, such as `work`. A display name does not select a profile.
Use the same `STELZ_HOME` for the CLI, UI, and each MCP connection.
See [Configuration](configuration.md) for environment settings and paths.

Only `profile create`, `profile export`, and `profile import` accept `--json`. There is no global `--json` option.
Help is available through `stelz --help`, `stelz help`, and the listed profile help commands.

## Installation and UI

| Command | Options | Output and effect |
| --- | --- | --- |
| `stelz --version` or `stelz version` | None | Prints the package version. |
| `stelz --help` or `stelz help` | None | Prints command syntax and the selected service directory. Invoking `stelz` without a command also prints help. |
| `stelz init` | None | Prints the absolute service directory. Creates missing configuration, secrets, and profile directories. Preserves existing entries. |
| `stelz setup` | None | Prints the prepared service directory. Installs the package's prepared runtime against the existing Camoufox executable. |
| `stelz ui` | `--port PORT`, `--open` | Prints a private session URL and serves the local UI until shutdown. |

Setup requires all profiles to be safely stopped. It does not install or update the Camoufox browser.
See [Getting started](getting-started.md) for prerequisites and [release procedures](development/releasing.md) for updates.

The UI binds to `127.0.0.1`. Its default port is `9380`.
`--port` accepts an integer from `1024` to `65535`.
`--open` opens the printed URL in the system browser.
If the opener is unavailable, open the printed URL manually.
Keep this URL private because its fragment contains a temporary session token.
Ctrl-C stops the UI server and preserves running profile browsers.
See [UI sessions](ui.md#open-or-close-the-manager).

## Profile commands

### Create or reuse a profile

```sh
stelz profile create work --json
stelz profile create --help
stelz profile --help
```

Creation assigns an available loopback port and native browser storage. It leaves the browser stopped.
A new profile uses a direct connection unless you supply a proxy.
An existing compatible profile returns `created: false` without a configuration rewrite.
Omitted network options preserve an existing profile's route and expected IP.
Conflicting options fail without changing that profile.

| Option | Meaning |
| --- | --- |
| `--direct` | Requires a direct connection. Conflicts with a proxy input or an existing proxied profile. |
| `--proxy-url URL` | Supplies a complete HTTP(S) or unauthenticated SOCKS5 URL. |
| `--proxy-env NAME` | Reads the proxy URL from the named process environment variable once. |
| `--expected-ip IP` | Supplies an exact IPv4 or IPv6 address to require during browser-side checks. |
| `--expected-ip-env NAME` | Reads the expected IP from the named process environment variable once. |
| `--json` | Writes a compact JSON result to stdout or a JSON error to stderr. |

Choose at most one proxy input and one expected-IP input. Do not repeat options.
Environment input names must match `[A-Za-z_][A-Za-z0-9_]{0,127}`.
A missing or empty input variable fails. The command does not read these one-time inputs from `secrets.env`.
Creation saves supplied values under private secret references. Later clients do not need the input variables.
Prefer environment inputs to credentials in shell history.
See [Proxy tasks](proxies.md) for supported URL syntax.

Without `--json`, success prints `Created profile work.` or `Reused profile work.`.
With `--json`, success has this shape:

```json
{
  "ok": true,
  "created": true,
  "home": "/absolute/service/home",
  "profile": { "id": "work", "port": 9377, "storage": "native", "proxyConfigured": false }
}
```

Configured profiles also report their `proxyEnv` and `expectedIPEnv` reference names when present.
Results omit secret values.

## Browser lifecycle and diagnostics

These commands print formatted JSON without a `--json` option.

| Command | Scope | Result and effect |
| --- | --- | --- |
| `stelz start ID` | Also accepts `all` | Starts a visible browser or reuses its safe lifetime. Prints service state. Does not acquire control. |
| `stelz status [ID]` | Omitted target or `all` selects all profiles | Prints observed state and available live service details. Does not change control. |
| `stelz doctor [ID]` | Omitted target or `all` selects all profiles | Prints installation checks and profile diagnostics in one object. |
| `stelz logs ID` | One profile | Prints `profileId`, `server`, and `supervisor` log strings. |
| `stelz pause ID` | One profile for manual work | Blocks new actions and waits for current work. Keeps the browser and controller. |
| `stelz resume ID` | One paused profile | Performs any required fresh IP check, then permits actions. Keeps the controller. |
| `stelz release ID` | One profile for handoff | Releases the current controller after its actions finish. Prints `released` and `profileId`. Keeps the browser and phase. |
| `stelz recheck ID` | One profile only | Performs any required fresh browser-side IP check. Prints verification state. Preserves a pause. |
| `stelz stop ID` | Also accepts `all` | Stops the browser service after current actions finish. Prints observed state. Preserves saved data. |
| `stelz recover ID` | One profile only | Archives an eligible process record. Prints state, `recovered: true`, and `archived` when recovery occurs. |

The dispatcher also accepts `all` for `pause`, `resume`, and `release`.
Use an explicit ID for authentication and controller handoff.
Lifecycle commands and `status` process `all` targets sequentially.
Each successful profile produces a separate formatted JSON object, not a JSON array.
Failures go to stderr. Processing continues for the remaining profiles.
An empty catalog produces no profile output for these operations.
Doctor instead prints one object with a `profiles` array when initialized.

`logs` accepts `--lines N`, where `N` is an integer from `1` to `500`. The default is `100`.
Each log read uses at most the last 64 KiB of its current file.
An absent log produces an empty string.

`recover` does not stop processes or start a replacement browser.
It refuses recorded live processes or unknown ownership.
Inspect browser descendants before recovery because recorded process checks cannot establish their absence.
See [Recovery procedures](troubleshooting.md#inspect-an-unclean-lifetime).

Status separates `phase` from `controller` ownership.
A ready browser can have a controller. A paused browser can retain that same controller.
Possible phases include `starting`, `ready`, `paused`, `verification_failed`, `blocked`, `stopping`, and `stopped`.
Process inspection can instead report `orphaned`, `ownership_unknown`, or `unclean`.

Live state can contain `exitIp`, `checkedAt`, `verificationStatus`, `verificationFresh`, and `verificationRequired`.
See [IP verification fields](configuration.md#ip-verification-fields) for their meanings.
`ownership` reports separate supervisor and server verdicts: `owned`, `missing`, `different`, or `unverified`.
`controlError` means the live status request failed.
Stored fields can remain after shutdown. Read the current phase and ownership before using them.

Doctor reports `home`, `initialized`, `setup`, `node`, and `browserExecutable`.
Its `profiles` entries add `configuration` and `accessKey` checks.
`node` and `browserExecutable` check availability, not version compatibility.
Pending journals can add `networkRecovery` or `profileImportRecovery`.

## Profile transfer

| Command | Options | Output |
| --- | --- | --- |
| `stelz profile export ID... --output FILE` | `--json` | Export count and absolute archive path. JSON contains `ok`, `archive`, and profile `id`/`name` summaries. |
| `stelz profile export --all --output FILE` | `--json` | Same result for the complete catalog. All selected profiles must be cleanly stopped. |
| `stelz profile import FILE` | Repeated `--profile SOURCE_ID`, repeated `--rename SOURCE_ID=NEW_ID`, `--json` | Source-to-destination mappings. JSON contains `ok` and `profiles` with `sourceId`, `id`, and `name`. |
| `stelz profile export --help` or `stelz profile import --help` | None | Prints transfer syntax. |

Export requires either distinct IDs or `--all`, plus `--output`. It refuses an existing output file.
Import selects the complete archive unless `--profile` selects a subset.
Each rename must refer to a selected source profile and an unused destination ID.
Import assigns ports and private secret references. It leaves imported profiles stopped.
Without `--json`, transfer notices go to stderr. These notices do not indicate failure.
See [Transfer profiles](profile-transfer.md) before exporting or importing.

## MCP connection

```sh
stelz mcp
```

The command serves MCP over stdio. Stdout carries protocol messages, not a CLI status report.
Register it once per client configuration. A connection can control multiple profiles through explicit tool arguments.
The 18 tools remain available when the catalog is empty or changes.
Call `profile_list({})` for the current catalog.
Create, start, status, and acquire take `{profileId}`.
Acquire returns status and a fresh opaque `controlHandle` for that connection, profile, and browser lifetime.
Release, pause, resume, recheck, and all nine browser tools require `{profileId, controlHandle}`.
Status and list return controller summaries without handles.

`profile_create` makes direct profiles or safely reuses existing profiles unchanged.
Start remains explicit through `profile_start`, the CLI, or the UI. Acquisition never starts a browser.
Configuration, proxies, deletion, import, stop, recovery, and forced handoff remain CLI or UI operations.
Release and disconnect preserve the browser and its open pages.
Release explicitly before handoff.

The removed MCP `--profile` option returns a migration error.
Follow [Migration](clients.md#migrate-an-existing-registration) with the same `STELZ_HOME`, updated runtime setup, and explicit browser restarts.
Profile-import `--profile` selectors remain supported.
See [Shared MCP tools](mcp.md) for the complete contract.
See [Client verification](clients.md#verify-the-connection) and [agent setup](bootstrap.md).

## Errors and exit status

| Result | Exit status | Meaning |
| --- | --- | --- |
| Command completes | `0` | The command completed. Inspect its returned state before browser work. |
| Invalid input or command failure | `1` | Stderr contains the error. Inspect existing state before another lifecycle action. |
| Any failed target in a lifecycle or status `all` operation | `1` | Successful targets still print their results. |

`status` and `doctor` can exit `0` while reporting unhealthy state or failed checks.
`start` can exit `0` with `phase: "verification_failed"`. That phase blocks browser actions.
An MCP tool failure returns `isError: true` within the protocol. It does not necessarily end the MCP process.

Profile commands with `--json` write errors in this form:

```json
{ "ok": false, "error": { "code": "conflict", "message": "..." } }
```

Create codes are `not_initialized`, `invalid_input`, `conflict`, and `profile_unavailable`.
Transfer codes are `cancelled`, `invalid_input`, `conflict`, `too_large`, and `transfer_failed`.
An early configuration-loading failure can produce `profile_unavailable` for any profile command.
Other CLI errors use plain stderr text.

For implementation details, read [Architecture](development/architecture.md) and [Testing](development/testing.md).
