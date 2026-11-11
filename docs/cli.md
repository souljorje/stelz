---
title: "CLI reference"
description: "Commands, options, outputs, and exit status of the installed stelz command. Read it to run or script a CLI operation."
tags: [cli, reference]
sources: []
created: 2026-11-06T13:49:16Z
modified: 2026-11-11T14:13:54Z
---

# CLI reference

This page lists the commands, options, outputs, and exit status of the installed `stelz` command.
`ID` is a stable profile ID, such as `work`. A display name does not select a profile.
Use the same [`STELZ_HOME`](configuration.md#service-directory-and-precedence) for the CLI, UI, and each MCP connection. `--json` works only on commands that list it.

## Installation and UI

| Command | Options | Output and effect |
| --- | --- | --- |
| `stelz --version`, `stelz version` | None | Prints the package version. |
| `stelz --help`, `stelz help`, `stelz` | None | Prints command syntax and the selected service directory. |
| `stelz setup` | `--yes`, `--json` | Creates missing service files. Prepares the browser, fingerprint model, location data, and runtime. Prints a summary and the next step. |
| `stelz ui` | `--port PORT` (`1024`-`65535`, default `9380`), `--open` | Prints a private session URL and serves the UI on `127.0.0.1` until shutdown. `--open` opens the URL in the system browser. |
| `stelz mcp` | None | Serves MCP over stdio. See [Shared MCP tools](mcp.md). |

- Setup asks once in a terminal before it downloads. `--yes` skips the question.
- Without a terminal or `--yes`, a setup that needs downloads fails with `confirmation_required` and a `downloads` list. Each entry has `name`, `size`, `purpose`, and `source`.
- `setup --json` never prompts. It prints one JSON report on stdout (`browser` with `source`, `locationData` for each dataset, `fingerprintModel`, and `runtime` with `id` and `status`: `prepared` or `reused`), and progress and a JSON error on stderr.
- Setup does not stop running profiles. They keep their runtime until [restart](#browser-lifecycle-and-diagnostics). See [Setup fails](troubleshooting.md#setup-fails).
- Keep the UI URL private. Its fragment contains a temporary session token. Ctrl-C stops the UI server and preserves running profile browsers.

## Profile commands

### Create or reuse a profile

```sh
stelz profile create work --json
```

Creation assigns an available loopback port and native browser storage. It leaves the browser stopped.
A new profile uses a direct connection unless you supply a proxy.
An existing compatible profile returns `created: false` without a configuration rewrite.
Omitted network options preserve its route and expected IP. Conflicting options fail without changing it.

| Option | Meaning |
| --- | --- |
| `--direct` | Requires a direct connection. Conflicts with a proxy input or an existing proxied profile. |
| `--proxy-url URL` | Supplies a complete HTTP(S) or unauthenticated SOCKS5 URL. See [Proxy tasks](proxies.md). |
| `--proxy-env NAME` | Reads the proxy URL once from the named process environment variable. |
| `--expected-ip IP` | Supplies an exact IPv4 or IPv6 address to require during browser-side checks. |
| `--expected-ip-env NAME` | Reads the expected IP once from the named process environment variable. |
| `--json` | Writes a compact JSON result to stdout or a JSON error to stderr. |

- Choose at most one proxy input and one expected-IP input. Do not repeat options.
- Environment input names match `[A-Za-z_][A-Za-z0-9_]{0,127}`. A missing or empty variable fails. The command does not read these inputs from `secrets.env`.
- Creation saves supplied values under private secret references. Later clients do not need the input variables.
- Without `--json`, success prints `Created profile work.` or `Reused profile work.`.

With `--json`, success has this shape. Configured profiles also report `proxyEnv` and `expectedIPEnv` reference names. Results omit secret values.

```json
{
  "ok": true,
  "created": true,
  "home": "/absolute/service/home",
  "profile": { "id": "work", "port": 9377, "storage": "native", "proxyConfigured": false }
}
```

### Check a saved fingerprint

`stelz profile fingerprint check work --json` inspects the saved pin and configured engine without a browser. `fingerprint_uninitialized` means no pin exists. See [Fingerprint recovery](troubleshooting.md#native-data-or-fingerprint-is-unavailable) for other errors.

## Browser lifecycle and diagnostics

These commands print formatted JSON by default and progress on stderr. Their `--json` option gives structured errors on stderr and never prompts. Only `start`, `restart`, `status`, `doctor`, and `recheck` accept it.

| Command | Scope | Result and effect |
| --- | --- | --- |
| `stelz start ID` | Also `all` | Starts a visible browser or reuses its safe lifetime. Does not acquire control. |
| `stelz status [ID]` | Omitted or `all`: all profiles | Prints observed state and live service details. Does not change control. |
| `stelz doctor [ID]` | Omitted or `all`: all profiles | Prints installation checks and profile diagnostics in one object. |
| `stelz logs ID` | One | Prints `profileId`, `server`, and `supervisor` log strings. `--lines N`: `1` to `500`, default `100`. Reads at most the last 64 KiB of each file. |
| `stelz pause ID` | One | Blocks new actions and waits for current work. Keeps the browser and controller. |
| `stelz resume ID` | One paused | Performs any required fresh IP check, then permits actions. Keeps the controller. |
| `stelz release ID` | One | Releases the controller after its actions finish. Prints `released` and `profileId`. Keeps the browser and phase. |
| `stelz recheck ID` | One | Stopped profile: checks connection and location before launch. Running profile: checks the browser. Preserves a pause. |
| `stelz stop ID` | Also `all` | Stops the browser service after current actions finish. Preserves saved data. |
| `stelz restart ID` | Also `all`: running profiles | Stops, then starts a running profile so that it uses the current runtime. Refuses a stopped profile. A failed start leaves it stopped. |
| `stelz recover ID` | One | Archives an eligible process record. Prints state, `recovered: true`, and `archived`. Does not stop processes or start a browser. |

- `pause`, `resume`, and `release` also accept `all`. Use an explicit ID for authentication and controller handoff.
- `all` targets run in sequence. Each success prints a separate JSON object, not an array. A failure goes to stderr and the rest continue. `doctor` prints one object with a `profiles` array.
- `recover` refuses recorded live processes and unknown ownership. Inspect browser descendants first. See [Recovery procedures](troubleshooting.md#inspect-an-unclean-lifetime).

### Status and doctor fields

- `phase` is separate from `controller`. Phases: `starting`, `ready`, `paused`, `verification_failed`, `blocked`, `stopping`, `stopped`. Process inspection can instead report `orphaned`, `ownership_unknown`, or `unclean`.
- Live state includes the [IP verification fields](configuration.md#ip-verification-fields).
- `restartToUpdate: true` means that a running profile uses an earlier runtime. Run `stelz restart ID`.
- `ownership` gives separate supervisor and server verdicts: `owned`, `missing`, `different`, or `unverified`.
- `controlError` means the live status request failed. Stored fields can remain after shutdown, so read the phase and ownership first.
- Doctor reports `home`, `initialized`, `setup`, `node`, and `browserExecutable`. Each `profiles` entry adds `configuration` and `accessKey`. Pending journals add `networkRecovery` or `profileImportRecovery`.

## Profile transfer

| Command | Options | Output |
| --- | --- | --- |
| `stelz profile export ID...` or `--all`, with `--output FILE` | `--json` | Export count and absolute archive path. JSON: `ok`, `archive`, profile `id`/`name` summaries, `fingerprintDiagnostics`. |
| `stelz profile import FILE` | Repeated `--profile SOURCE_ID`, repeated `--rename SOURCE_ID=NEW_ID`, `--json` | Source-to-destination mappings. JSON: `ok`, `profiles`, `fingerprintDiagnostics`. |

- Export refuses an existing output file. All selected profiles must be cleanly stopped.
- Import selects the whole archive unless `--profile` selects a subset. Each rename must name a selected source profile and an unused destination ID.
- Without `--json`, notices go to stderr and do not alone indicate failure.

See [Transfer profiles](profile-transfer.md).

## Errors and exit status

| Result | Exit status |
| --- | --- |
| Command completes | `0` |
| Invalid input or command failure | `1`. Stderr has the error. |
| Any failed target in an `all` operation | `1`. Successful targets still print. |

- `status` and `doctor` can exit `0` while they report unhealthy state. A preflight or browser-verification blocker makes `start` exit `1`.
- A repeated start preserves an existing `verification_failed` lifetime, which blocks browser actions.
- With `--json`, location failures include `location.phase`, `code`, `message`, `nextAction`, and `browserStarted`.
- An MCP tool failure returns `isError: true`. It does not necessarily end the MCP process.

Profile commands with `--json` write errors in this form:

```json
{ "ok": false, "error": { "code": "conflict", "message": "..." } }
```

Create codes: `not_initialized`, `invalid_input`, `conflict`, `profile_unavailable`. Transfer codes: `cancelled`, `invalid_input`, `conflict`, `too_large`, `transfer_failed`.
An early configuration-loading failure can produce `profile_unavailable` for any profile command. Lifecycle commands without `--json` print plain stderr text.
