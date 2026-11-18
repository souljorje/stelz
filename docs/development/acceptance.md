---
title: "Acceptance"
description: "Checks for the built UI, archives, proxies, people, agents, and public sites, to read when you run one or accept a release candidate."
tags: [development, testing, acceptance]
sources: []
created: 2026-11-11T14:13:54Z
modified: 2026-11-17T08:36:53Z
---

# Acceptance

- Run these checks only on explicit command. Routine checks and the browser suite: see [Testing](testing.md#choose-a-check).
- Other pages: [Public fingerprint checks](public-site-checks.md) and [Agent onboarding acceptance](agent-onboarding.md).
- Checks that start Camoufox need desktop access and the paired build. See [Browser executable](../configuration/environment.md#browser-executable).
- Each check uses disposable profiles in its own service directory. It never selects a saved profile. It stops its own browsers.
- Each check prints its report path. Reports go in the system temp directory (`$TMPDIR`).
- Source proxy and human checks reuse the installed browser and cached data described in [Testing](testing.md#browser-suite).

## Built UI acceptance

- Run `bun run test:ui`. It builds first. It starts no Camoufox profile.
- Needs Chrome or Chromium. `STELZ_UI_CHROME` selects the executable.
- Screenshots and report: printed when the check ends.

## Proxy and location acceptance

- Needs declared test proxies. Never copy proxies from everyday profiles.
- The runner cannot confirm proxy ownership. The operator must supply the right route.

1. Create a private env file outside the repository with `PROXY_TEST_USAGE=dedicated-acceptance`.
2. Set `PROXY_TEST_URL` in that file. Also set `PROXY_TEST_SECOND_URL` to check two different exits.
3. Optionally set `PROXY_TEST_EXPECTED_IP` and `PROXY_TEST_SECOND_EXPECTED_IP` to check for known exits.
4. Run the check with the file's absolute path:

   ```sh
   PROXY_TEST_ENV=/absolute/path/to/private.env bun run test:proxy
   ```

- Two profiles run a direct baseline, then three proxied lifetimes.
- Routing: each profile uses only its own route, with no direct fallback when a relay stops.
- Location: preflight is ready before a browser starts. Start verifies the browser. The page shows the verified timezone and language, without the geolocation permission.
- Two routes: the exits must differ. Two endpoints with the same exit cannot pass.
- One route: both relays use it. The report marks the distinct-exit check as unexecuted.
- The report states whether the exits cover different timezones. Same-zone exits do not cover cross-zone cases.
- No IP pins: preflight observations set the expected addresses for the run.
- A pass does not prove the absence of OS or browser DNS leaks.
- Cleanup stops test browsers and removes temporary credential copies.
- Remove the env file when you no longer need it. See [Configure a proxy or expected exit IP](../proxies.md).

## Human acceptance

- Run `bun run test:human`. It needs a person at the visible browser for two steps. The check prints each step.
- Step 1: click **Human confirmation** in the fixture window while MCP actions are paused. Complete any authentication in that same window.
- Step 2: close that browser window. The check then verifies a clean stop and an explicit restart.

## Installed-package acceptance

```sh
bun run build
stage=$(bun run prepare:package)
(cd "$stage" && npm pack --ignore-scripts --pack-destination "$TMPDIR")
rm -rf "$stage"
bun run lint:package /absolute/path/to/candidate.tgz
bun run test:install --archive /absolute/path/to/candidate.tgz
bun run test:package --archive /absolute/path/to/candidate.tgz --setup
```

- Use the archive that npm writes under `$TMPDIR`. Do not rebuild between checks.
- `prepare:package` prints an isolated staging directory. It prepares patched Camofox but does not build the sources or create the final archive. Remove the staging directory after packing.
- npm's `--pack-destination DIRECTORY` selects the output directory. Without `--archive`, local checks select the current manifest version under `release-artifacts/`.
- `lint:package`: publint checks the exact archive. Warnings and errors fail the command.
- `test:install`: installs the archive in a disposable directory, runs the CLI version command, imports the SDK, and serves UI assets. `--native` adds ordinary npm lifecycle scripts and native dependency checks. It runs no setup and starts no browser.
- `test:install --both`: runs both installation modes concurrently against one archive. Each mode uses a separate prefix and service home. Either failure fails the command after both finish.
- Archive validation separately checks Camofox patches, bundled dependency constraints, and unchanged archive bytes.
- `test:package`: includes `test:install --native`, runs setup, checks native dependencies in the staged runtime, then runs the [browser suite](testing.md#browser-suite) against the installed CLI.
- Package acceptance prepares its browser once. The browser, proxy, and human checks reuse it. `--setup` separately checks setup behavior.
- Run the full archive checks once per candidate, not after each fix.

Flags:

| Flag | Adds |
| --- | --- |
| `--setup` | `test:setup` on the same installation |
| `--windows` | Window controls |
| `--proxy` | [Proxy and location acceptance](#proxy-and-location-acceptance) |
| `--human` | [Human acceptance](#human-acceptance). Needs a person at the visible browser. |

- `test:setup`: needs network access to GitHub and the paired build in the upstream Camoufox cache, which it hides for its consent case. It downloads no browser and starts one headed browser. A pass removes its files.

Full package acceptance:

- Run `bun run test:package --archive FILE --setup --proxy --human`.
- Set `PROXY_TEST_ENV` as in [Proxy and location acceptance](#proxy-and-location-acceptance).

ZIP commands of an installed release, without a browser, from the source checkout:

```sh
STELZ_TEST_CLI=/absolute/path/to/installed/stelz \
  bun test tests/unit/profile-transfer-cli.test.ts
```

- CI validation and publication of the same archive: see [Releasing](releasing.md).
