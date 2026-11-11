---
title: "Acceptance"
description: "Acceptance suites for browsers, archives, proxies, people, agents, and public sites, to read when you run a suite or accept a release candidate."
tags: [development, testing, acceptance]
sources: []
created: 2026-11-11T14:13:54Z
modified: 2026-11-11T14:27:18Z
---

# Acceptance

- Run these suites only on explicit command. Routine checks and report paths: see [Testing](testing.md).
- Browser suites need desktop access and the paired Camoufox build. See [Browser executable](../configuration.md#browser-executable).
- Run `bun run build` first. `bunx lefthook run browser` selects the suites for the changed files.
- Reports can contain private data.
- `bun run test:integration` and `bun run test:concurrency` need no other input.

## Built UI acceptance

- Run `bun run test:ui:browser`. It starts no Camoufox profile.
- Needs Chrome or Chromium. `STELZ_UI_CHROME` selects the executable.
- Screenshots and report: `.state/ui-browser/`.

## Native storage and device measurements

- Run `bun run test:native`.
- Canvas and audio hashes are measurements. The service does not guarantee identical hashes within a lifetime or across restarts. Missing or failed probes cannot show stability.

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
3. Optionally set `PROXY_TEST_EXPECTED_IP` and `PROXY_TEST_SECOND_EXPECTED_IP` to require known exits.
4. Run the check with the file's absolute path:

   ```sh
   PROXY_TEST_ENV=/absolute/path/to/private.env bun run test:proxy
   ```

- Two routes: the exits must differ. Two endpoints with the same exit cannot pass.
- One route: both relays use it. The report marks the distinct-exit check as unexecuted.
- No IP pins: preflight observations set the expected addresses for the run.
- A pass does not prove the absence of OS or browser DNS leaks.
- Report: `.state/proxy-acceptance-*/report.json`. Cleanup stops test browsers and removes temporary credential copies.
- Remove the env file when you no longer need it. See [Proxies](../proxies.md).

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
- See [Typing](../configuration.md#typing).

## Public fingerprint checks

- Run `bun run test:public`.
- Sites: [Fingerprint web scraping](https://demo.fingerprint.com/web-scraping), [Fingerprint Playground](https://demo.fingerprint.com/playground), [Pixelscan](https://pixelscan.net/fingerprint-check), [Rebrowser](https://bot-detector.rebrowser.net/).
- A pass does not show that a website cannot detect automation.
- Use a separate proxy. Do not share it with lifecycle tests, which create multiple identities.
- It rejects `--profile`, ignores `STELZ_HOME`, and reuses one native profile.

1. Create a private env file with `PROXY_TEST_USAGE=dedicated-public` and `PROXY_TEST_URL`. Add `PROXY_TEST_EXPECTED_IP` when an exit pin is necessary.
2. From the repository root, create a test home once. Save the printed absolute path:

   ```sh
   bun --no-env-file -e 'import { createTestHome } from "./tests/helpers/test-home.ts"; console.log(createTestHome("public-profile", ".state"));'
   ```

3. Use that same path for every public check:

   ```sh
   PUBLIC_TEST_HOME=/absolute/path/printed/above PROXY_TEST_ENV=/absolute/path/to/public.env bun run test:public
   ```

Test home:

- Keeps cookies and device settings. Bound to the proxy protocol, host, port, and IP pin.
- A credential rotation keeps the profile. A route or IP pin change needs a new `PUBLIC_TEST_HOME`.
- Concurrent runs cannot share it. After a crash, make sure the run is not active, then remove `.public-check.lock`.
- No direct-connection fallback. No shell proxy URL fallback.

Run behavior:

- Authentication pauses the profile. Complete it in the same Camoufox window, then type `done` in the terminal. A noninteractive terminal or cancelled authentication gives an incomplete run.
- A service deadline blocks further actions. Stop and start the profile explicitly.

Result:

- Artifacts: `.state/public-sites/<run>/` with `report.json`, `report.md`, and for each site a PNG screenshot and a snapshot JSON file.
- Snapshots can contain visitor IDs and IP addresses.
- Site results: `PASS`, `FAIL`, `INCONCLUSIVE`, `UNSUPPORTED`, `ERROR`. Loading pages, missing signals, and unfamiliar results cannot pass.
- Success: four passing site checks, four screenshots, successful shutdown. Advisory warnings do not fail the run.

## Installed-package acceptance

```sh
bun run pack
bun run test:install --archive /absolute/path/to/candidate.tgz
bun run test:package --archive /absolute/path/to/candidate.tgz --setup
```

- Use the archive path that `pack` prints. Do not rebuild between checks.
- `pack --destination DIRECTORY`: another output directory. Without `--archive`, local checks select the current manifest version under `release-artifacts/`.
- `test:install`: no browser. `--native` adds ordinary npm lifecycle scripts and native dependency checks.
- `test:package`: installs with lifecycle scripts. Always runs integration, native persistence, transfer, concurrency, and typing acceptance. Replaces `test:install --native` and the source-tree suites it repeats.
- `test:package` flags: `--setup` runs `test:setup` on the same installation. `--windows` adds window controls. `--proxy` adds proxy and location acceptance. `--manual` adds human acceptance, which needs a real click in the visible browser.
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

## Agent onboarding acceptance

- Use a desktop machine with a configured coding agent. Keep its approval protections and global client configuration.
- First session: [Agent setup](../bootstrap.md). Second session: a first browser task.

1. Build and pack a candidate. Push its branch, so that the skill link resolves to the candidate's skill.
2. Prepare a new writable project directory, npm prefix, and temporary `STELZ_HOME`.
3. Give a fresh agent in that project the [setup request from the README](../../README.md#let-your-agent-set-it-up) with the branch's skill link.
   Add the test conditions: install the archive instead of the registry, and use the test prefix and `STELZ_HOME`.
4. Approve the setup downloads when the agent asks. Record each other intervention request.
5. Require the installed package, a prepared runtime, the skill link, one shared MCP registration, an open UI, and a report with the next steps.
   The agent must not create or start a profile.
6. Create and start `work` in the UI. Start a new client session in the same project.
7. Serve the packaged onboarding fixture. Ask the agent to verify Stelz on that page in profile `work`. Keep the browser window visible.
8. Require a fresh catalog, acquisition with `{profileId}`, fresh snapshots, the fixture action and its result, and release.
9. Stop only the test profile and the fixture server. Keep failed test state for inspection.

- The model must do the browser interaction through its registered MCP tools. An SDK script can inspect the resulting state. It cannot replace real-agent evidence.
