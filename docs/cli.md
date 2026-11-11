---
title: "CLI reference"
description: "Commands, options, outputs, and exit status of the installed stelz command, to read when you run or script a CLI operation."
tags: [cli, reference]
sources: []
created: 2026-11-06T13:49:16Z
modified: 2026-11-11T14:27:18Z
---

# CLI reference

- `ID`: stable profile ID, such as `work`. A display name does not select a profile.
- Use the same [`STELZ_HOME`](configuration/environment.md#service-directory-and-precedence) for the CLI, UI, and each MCP connection.
- `--json` works only on commands that list it.

## Installation and UI

| Command | Options | Output |
| --- | --- | --- |
| `stelz --version`, `stelz version` | None | Package version. |
| `stelz --help`, `stelz help`, `stelz` | None | Command syntax and the selected service directory. |
| `stelz setup` | `--yes`, `--json` | Creates missing service files. Prepares the browser, fingerprint model, location data, and runtime. Prints a summary and the next step. |
| `stelz ui` | `--port PORT` (`1024`-`65535`, default `9380`), `--open` | Private session URL. Serves the UI on `127.0.0.1` until shutdown. `--open` opens the URL in the system browser. |
| `stelz mcp` | None | Serves MCP over stdio. See [Shared MCP tools](mcp.md). |

- Setup asks once in a terminal before it downloads. `--yes` skips the question.
- No terminal and no `--yes`: a setup that needs downloads fails with `confirmation_required` and a `downloads` list. Each entry has `name`, `size`, `purpose`, and `source`.
- `setup --json` never prompts. Stdout: one JSON report (`browser` with `source`, `locationData` for each dataset, `fingerprintModel`, `runtime` with `id` and `status`: `prepared` or `reused`). Stderr: progress and a JSON error.
- Setup does not stop running profiles. See [Update Stelz](getting-started.md#update-stelz) and [Setup fails](troubleshooting/setup.md#setup-fails).
- Keep the UI URL private. Its fragment holds a temporary session token. Ctrl-C stops the UI server. Profile browsers keep running.

## Profile commands

### Create or reuse a profile

```sh
stelz profile create work --json
```

- Assigns an available loopback port and native browser storage. Leaves the browser stopped. New profile: direct connection unless you supply a proxy.
- Existing compatible profile: returns `created: false`, no configuration rewrite. Omitted network options keep its route and expected IP. Conflicting options fail without changing it.

| Option | Meaning |
| --- | --- |
| `--direct` | Requires a direct connection. Conflicts with a proxy input or an existing proxied profile. |
| `--proxy-url URL` | Proxy URL. See [Supported proxy URLs](proxies.md#supported-proxy-urls). |
| `--proxy-env NAME` | Reads the proxy URL once from the named process environment variable. |
| `--expected-ip IP` | Expected exit IP for browser-side checks. See [Supported proxy URLs](proxies.md#supported-proxy-urls). |
| `--expected-ip-env NAME` | Reads the expected IP once from the named process environment variable. |
| `--json` | Compact JSON result on stdout or JSON error on stderr. |

- At most one proxy input and one expected-IP input. No repeated options.
- Environment input names match `[A-Za-z_][A-Za-z0-9_]{0,127}`. A missing or empty variable fails. The command does not read these inputs from `secrets.env`.
- Supplied values go to private secret references. Later clients do not need the input variables.
- Without `--json`: `Created profile work.` or `Reused profile work.`. With `--json`: this shape. Configured profiles also report `proxyEnv` and `expectedIPEnv` reference names. No secret values.

```json
{
  "ok": true,
  "created": true,
  "home": "/absolute/service/home",
  "profile": { "id": "work", "port": 9377, "storage": "native", "proxyConfigured": false }
}
```

### Check a saved fingerprint

`stelz profile fingerprint check work --json`: inspects the saved pin and configured engine without a browser.

- `fingerprint_uninitialized`: no pin exists. Other errors: see [Fingerprint recovery](troubleshooting/lifetime-and-state.md#native-data-or-fingerprint-is-unavailable).

## Browser lifecycle and diagnostics

- Output: formatted JSON. Progress: stderr. To choose an action, see [Troubleshooting](troubleshooting/index.md).
- `--json` gives structured errors on stderr and never prompts. Only `start`, `restart`, `status`, `doctor`, and `recheck` accept it.

| Command | Scope | Output |
| --- | --- | --- |
| `stelz start ID` | One or `all` | Service state. Does not acquire control. |
| `stelz status [ID]` | One, or all profiles when omitted or `all` | Observed state and live service details. |
| `stelz doctor [ID]` | One, or all profiles when omitted or `all` | Installation checks and profile diagnostics in one object. |
| `stelz logs ID` | One | `profileId`, `server`, and `supervisor` log strings. `--lines N`: `1` to `500`, default `100`. At most the last 64 KiB of each file. |
| `stelz pause ID` | One | Blocks new actions, waits for current work. Keeps browser and controller. |
| `stelz resume ID` | One paused | Runs any required fresh IP check, then permits actions. Keeps the controller. |
| `stelz release ID` | One | Releases the controller after its actions finish. Prints `released` and `profileId`. Keeps browser and phase. |
| `stelz recheck ID` | One | Stopped profile: checks connection and location. Running profile: checks the browser. Preserves a pause. |
| `stelz stop ID` | One or `all` | Observed state. Waits for current actions. Keeps saved data. |
| `stelz restart ID` | One or `all` (running profiles) | Refuses a stopped profile. A failed start leaves the profile stopped. See [Update Stelz](getting-started.md#update-stelz). |
| `stelz recover ID` | One | Archives an eligible process record. Prints state, `recovered: true`, and `archived`. Does not stop processes or start a browser. |

- `pause`, `resume`, and `release` also accept `all`. Use an explicit ID for authentication and controller handoff.
- `all` runs in sequence. Each success prints a separate JSON object, not an array. A failure goes to stderr and the rest continue. `doctor` prints one object with a `profiles` array.
- `recover` refuses recorded live processes and unknown ownership. Inspect browser descendants first. See [Recovery procedures](troubleshooting/lifetime-and-state.md#inspect-an-unclean-lifetime).

### Status and doctor fields

- `phase` is separate from `controller`. Phases: `starting`, `ready`, `paused`, `verification_failed`, `blocked`, `stopping`, `stopped`. Process inspection can instead report `orphaned`, `ownership_unknown`, or `unclean`.
- Live state includes the [IP verification fields](configuration/network.md#ip-verification-fields).
- `restartToUpdate: true`: the running profile uses an earlier runtime. See [Update Stelz](getting-started.md#update-stelz).
- `ownership`: separate supervisor and server verdicts, each `owned`, `missing`, `different`, or `unverified`.
- `controlError`: the live status request failed. Stored fields can remain after shutdown. Read the phase and ownership first.
- Doctor: `home`, `initialized`, `setup`, `node`, `browserExecutable`. Each `profiles` entry adds `configuration` and `accessKey`. Pending journals add `networkRecovery` or `profileImportRecovery`.

## Profile transfer

| Command | Options | Output |
| --- | --- | --- |
| `stelz profile export ID...` or `--all`, with `--output FILE` | `--json` | Export count and absolute archive path. JSON: `ok`, `archive`, profile `id`/`name` summaries, `fingerprintDiagnostics`. |
| `stelz profile import FILE` | Repeated `--profile SOURCE_ID`, repeated `--rename SOURCE_ID=NEW_ID`, `--json` | Source-to-destination mappings. JSON: `ok`, `profiles`, `fingerprintDiagnostics`. |

- Export refuses an existing output file. All selected profiles must be cleanly stopped.
- Import selects the whole archive unless `--profile` selects a subset. Each rename names a selected source profile and an unused destination ID.
- Without `--json`, notices go to stderr and do not alone indicate failure.
- Procedures: see [Transfer profiles](profile-transfer.md).

## Errors and exit status

| Result | Exit status |
| --- | --- |
| Command completes | `0` |
| Invalid input or command failure | `1`. Error on stderr. |
| Any failed target in an `all` operation | `1`. Successful targets still print. |

- `status` and `doctor` can exit `0` while they report unhealthy state. A preflight or browser-verification blocker makes `start` exit `1`.
- A repeated start keeps an existing `verification_failed` lifetime. It blocks browser actions.
- With `--json`, location failures include `location.phase`, `code`, `message`, `nextAction`, and `browserStarted`.
- An MCP tool failure returns `isError: true`. It does not necessarily end the MCP process.
- Lifecycle commands without `--json`: plain stderr text.
- With `--json`, profile commands write errors in this form:

```json
{ "ok": false, "error": { "code": "conflict", "message": "..." } }
```

- Create codes: `not_initialized`, `invalid_input`, `conflict`, `profile_unavailable`. Transfer codes: `cancelled`, `invalid_input`, `conflict`, `too_large`, `transfer_failed`.
- An early configuration-loading failure can produce `profile_unavailable` for any profile command.
