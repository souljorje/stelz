---
title: "Acceptance"
description: "Acceptance suites for browsers, archives, proxies, people, agents, and public sites, to read when you run a suite or accept a release candidate."
tags: [development, testing, acceptance]
sources: []
created: 2026-11-11T14:13:54Z
modified: 2026-11-11T15:01:55Z
---

# Acceptance

- Run these suites only on explicit command. Routine checks and report paths: see [Testing](testing.md).
- Other pages: [Public fingerprint checks](public-site-checks.md) and [Agent onboarding acceptance](agent-onboarding.md).
- Browser suites need desktop access and the paired Camoufox build. See [Browser executable](../configuration/environment.md#browser-executable).
- Run `bun run build` first. Selecting suites: [Testing](testing.md#choose-a-check).
- `bun run test:integration` and `bun run test:concurrency` need no other input.

## Built UI acceptance

- Run `bun run test:ui:browser`. It starts no Camoufox profile.
- Needs Chrome or Chromium. `STELZ_UI_CHROME` selects the executable.
- Screenshots and report: `.state/ui-browser/`.

## Native storage and device measurements

- Run `bun run test:native`.
- Canvas and audio hashes are measurements. See [Persistent state](architecture.md#persistent-state-and-device-properties).
- Missing or failed probes cannot show stability.

## Profile transfer acceptance

- Run `bun run test:transfer`.
- Report: `.state/profile-transfer/report.json`. Cleanup stops only its test profiles.
- To check an installed release's ZIP commands without a browser, run from the source checkout:

```sh
STELZ_TEST_CLI=/absolute/path/to/installed/stelz \
  bun test tests/integration/profile-transfer-cli.test.ts
```

## Proxy and human acceptance

- Needs declared test proxies. Never copy proxies from everyday profiles.
- The runner cannot confirm proxy ownership. The operator must supply the right route.

1. Create a private env file outside the repository with `PROXY_TEST_USAGE=dedicated-acceptance`.
2. Set `PROXY_TEST_URL` in that file. Also set `PROXY_TEST_SECOND_URL` to check two different exits.
3. Optionally set `PROXY_TEST_EXPECTED_IP` and `PROXY_TEST_SECOND_EXPECTED_IP` to check for known exits.
4. Run the check with the file's absolute path:

   ```sh
   PROXY_TEST_ENV=/absolute/path/to/private.env bun run test:proxy
   ```

- Two routes: the exits must differ. Two endpoints with the same exit cannot pass.
- One route: both relays use it. The report marks the distinct-exit check as unexecuted.
- No IP pins: preflight observations set the expected addresses for the run.
- A pass does not prove the absence of OS or browser DNS leaks.
- Report: `.state/proxy-acceptance-*/report.json`. Cleanup stops test browsers and removes temporary credential copies.
- Remove the env file when you no longer need it. See [Configure a proxy or expected exit IP](../proxies.md).

Human takeover:

- Run `bun run test:manual`. Click **Human confirmation** in the visible fixture while MCP actions are paused.
- Complete any authentication in that same window.

## Window acceptance

- `bun run test:windows`: two native profiles. Needs visible desktop windows.
- Report status: `passed`, `incomplete`, or `failed`. Both `incomplete` and `failed` give a nonzero exit code.
- Foreground restrictions give `incomplete`, with reasons in `foregroundLimits`. Other failures give `failed`.
- `--inspect`: prints a temporary UI URL for 45 seconds, then stops its UI and browsers.
- `bun run test:window-close`: close only the isolated test window when prompted.

## Typing acceptance

- Run `bun run test:typing`.
- It rejects `--profile`. Each run creates a disposable profile and stops it.
- See [Typing](../configuration/typing.md).

## Installed-package acceptance

```sh
bun run pack
bun run test:install --archive /absolute/path/to/candidate.tgz
bun run test:package --archive /absolute/path/to/candidate.tgz --setup
```

- Use the archive path that `pack` prints. Do not rebuild between checks.
- `pack --destination DIRECTORY`: another output directory. Without `--archive`, local checks select the current manifest version under `release-artifacts/`.
- `test:install`: no browser. `--native` adds ordinary npm lifecycle scripts and native dependency checks.
- `test:package`: installs with lifecycle scripts. Always runs integration, native persistence, transfer, concurrency, and typing acceptance. Replaces `test:install --native` and the source-tree suites it repeats. Flags:

| Flag | Adds |
| --- | --- |
| `--setup` | `test:setup` on the same installation |
| `--windows` | Window controls |
| `--proxy` | Proxy and location acceptance |
| `--manual` | Human acceptance. Needs a real click in the visible browser. |

- `test:setup`: needs network access to GitHub and the paired build in the upstream Camoufox cache, which it hides for its consent case. It downloads no browser and starts one headed browser. Report: `.state/package-test/setup-report.json`. A pass removes its files.

Full package acceptance:

- Run `bun run test:package --archive FILE --setup --proxy --manual`.
- Set `PROXY_TEST_ENV` as in [Proxy and human acceptance](#proxy-and-human-acceptance).
- Set an absolute `CAMOUFOX_EXECUTABLE`. The location check needs both.

Location readiness alone, with one or two private proxy routes:

```sh
PROXY_TEST_ENV=/absolute/path/to/private.env CAMOUFOX_EXECUTABLE=/absolute/path/to/camoufox bun run test:location --archive /absolute/path/to/candidate.tgz
```

- Three profiles take the supplied routes in turn. One route serves all three.
- The report states whether the exits cover different timezones. Same-zone exits do not cover cross-zone cases.
- CI validation and publication of the same archive: see [Releasing](releasing.md).
