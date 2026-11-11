---
title: "Acceptance"
description: "Acceptance suites that need browsers, an installed archive, proxies, a person, an agent, or public sites. Read it to run a suite or to accept a release candidate."
tags: [development, testing, acceptance]
sources: []
created: 2026-11-11T14:13:54Z
modified: 2026-11-11T14:13:54Z
---

# Acceptance

These suites run only on explicit command. Routine checks, fixtures, and report paths are in [Testing](testing.md).
Browser suites need desktop access and the paired Camoufox build. See [Browser executable](../configuration.md#browser-executable).
Run `bun run build` first. `bunx lefthook run browser` selects the suites for the changed files. Reports can contain private data.
`bun run test:integration` and `bun run test:concurrency` need no other input.

## Built UI acceptance

Run `bun run test:ui:browser`. The check starts no Camoufox profile. It uses installed Chrome or Chromium. Set `STELZ_UI_CHROME` to select its executable.
Screenshots and the report are in `.state/ui-browser/`.

## Native storage and device measurements

Run `bun run test:native`. Saved device settings and the cookie, localStorage, and IndexedDB markers must stay unchanged across three lifetimes. Selected device properties, including WebGL and WebGL2, must match.
Canvas and audio hashes are measurement output. The service does not guarantee identical hashes within a lifetime or across restarts.
Missing or failed probes cannot show stability. Language and timezone follow current network policy, so a policy change is not drift.

## Profile transfer acceptance

Run `bun run test:transfer`. The report is `.state/profile-transfer/report.json`. Cleanup stops only its test profiles.
To check an installed release's ZIP commands without a browser, run this from the source checkout:

```sh
STELZ_TEST_CLI=/absolute/path/to/installed/stelz \
  bun test tests/integration/profile-transfer-cli.test.ts
```

## Proxy and human acceptance

Live acceptance requires declared test proxies. Never copy proxies from everyday profiles.
The check cannot confirm proxy ownership. The operator must supply the correct route.

1. Create a private env file outside the repository with `PROXY_TEST_USAGE=dedicated-acceptance`.
2. Set `PROXY_TEST_URL` in that file. Also set `PROXY_TEST_SECOND_URL` to check two different exits.
3. Optionally set `PROXY_TEST_EXPECTED_IP` and `PROXY_TEST_SECOND_EXPECTED_IP` to require known exits.
4. Run the check with the file's absolute path:

   ```sh
   PROXY_TEST_ENV=/absolute/path/to/private.env bun run test:proxy
   ```

With two routes, the exits must differ. Two endpoints with the same exit cannot pass.
With one route, both relays use it, and the report marks the distinct-exit check as unexecuted.
Without supplied IP pins, preflight observations set the expected addresses for that run.
The check does not prove the absence of OS or browser DNS leaks.
The report is `.state/proxy-acceptance-*/report.json`. Cleanup stops test browsers and removes temporary credential copies.
Remove the env file when you no longer need it. See [Proxies](../proxies.md) for network behavior.

For human takeover, run `bun run test:manual`. Click **Human confirmation** in its visible fixture while MCP actions are paused.
Complete any authentication in that same window.

## Window acceptance

Run `bun run test:windows`. It starts two native profiles and needs visible desktop windows.
The report records `passed`, `incomplete`, or `failed`. Foreground restrictions produce `incomplete`, reasons in `foregroundLimits`, and a nonzero exit code. Other failures produce `failed` and a nonzero exit code.
Add `--inspect` to print a temporary UI URL for a 45-second inspection period. The check then stops its UI and browsers.
For `bun run test:window-close`, close only the isolated test window when prompted.

## Typing acceptance

Run `bun run test:typing`. The check starts one visible browser with a local page that records input events. It rejects `--profile`. Every run creates a disposable profile and stops it.
See [Typing](../configuration.md#typing) for the mode behavior.

## Public fingerprint checks

`bun run test:public` visits public sites through Stelz MCP tools. A pass does not show that a website cannot detect automation.

| Site | Required observation |
| --- | --- |
| [Fingerprint web scraping](https://demo.fingerprint.com/web-scraping) | The default query displays flight cards without a detection warning. |
| [Fingerprint Playground](https://demo.fingerprint.com/playground) | Desktop detection flags are clear. An explicitly low-confidence proxy finding is a warning. |
| [Pixelscan](https://pixelscan.net/fingerprint-check) | The completed fingerprint is consistent and its summary checks report no warnings. |
| [Rebrowser](https://bot-detector.rebrowser.net/) | Applicable automatic probes pass. Chromium-specific and untriggered probes have explicit skip reasons. |

Any other detected Playground flag fails, and so do medium-confidence and high-confidence proxy findings. A low-confidence proxy warning cannot override another failure.
Skipped and untriggered probes do not count as passes.

Reserve a separate proxy for these checks. Do not share it with lifecycle tests, which create multiple identities.
The suite rejects `--profile`, ignores the operator's `STELZ_HOME`, and reuses one native profile.

1. Create a private env file with `PROXY_TEST_USAGE=dedicated-public` and `PROXY_TEST_URL`. Add `PROXY_TEST_EXPECTED_IP` when an exit pin is necessary.
2. From the repository root, create a test home once. Save the printed absolute path:

   ```sh
   bun --no-env-file -e 'import { createTestHome } from "./tests/helpers/test-home.ts"; console.log(createTestHome("public-profile", ".state"));'
   ```

3. Use that same path for every public check:

   ```sh
   PUBLIC_TEST_HOME=/absolute/path/printed/above PROXY_TEST_ENV=/absolute/path/to/public.env bun run test:public
   ```

The home keeps cookies and device settings. It is bound to the proxy protocol, host, port, and IP pin. A credential rotation keeps the profile. A route or IP pin change needs a new `PUBLIC_TEST_HOME`.
Concurrent runs cannot share the home. After a crash, make sure that the run is not active before you remove `.public-check.lock`.
There is no direct-connection fallback and no shell proxy URL fallback.

Authentication pauses the profile. Complete authentication in the same Camoufox window, then type `done` in the terminal. A noninteractive terminal or cancelled authentication produces an incomplete run.
A service deadline blocks further actions and requires an explicit stop and start.

Artifacts are in `.state/public-sites/<run>/`: `report.json`, `report.md`, and for each site a PNG screenshot and a snapshot JSON file. Snapshots can contain visitor IDs and IP addresses.
Results are `PASS`, `FAIL`, `INCONCLUSIVE`, `UNSUPPORTED`, or `ERROR`. Loading pages, missing signals, and unfamiliar results cannot pass.
Success requires four passing site checks, four screenshots, and successful shutdown. Advisory warnings do not fail the run.

## Installed-package acceptance

```sh
bun run pack
bun run test:install --archive /absolute/path/to/candidate.tgz
bun run test:package --archive /absolute/path/to/candidate.tgz --setup
```

Use the archive path that `pack` prints in each command. Do not rebuild between checks. `pack --destination DIRECTORY` selects another output directory.
Without `--archive`, local checks select the current manifest version under `release-artifacts/`.

- `test:install` needs no browser. Add `--native` for ordinary npm lifecycle scripts and native dependency checks.
- `test:package` installs with lifecycle scripts and always runs integration, native persistence, transfer, concurrency, and typing acceptance. It replaces `test:install --native` and the source-tree suites that it repeats.
- `test:package --setup` runs `test:setup` on the same installation. `--windows` adds window controls. `--proxy` adds proxy and location acceptance. `--manual` adds human acceptance, which needs a real click in the visible browser.
- `test:setup` needs network access to GitHub and the paired build in the upstream Camoufox cache, which it hides for its consent case. It downloads no browser and starts one headed browser. It writes `.state/package-test/setup-report.json` and removes its files after a pass.

For full package acceptance, run `bun run test:package --archive FILE --setup --proxy --manual`. Set `PROXY_TEST_ENV` as in [Proxy and human acceptance](#proxy-and-human-acceptance) and an absolute `CAMOUFOX_EXECUTABLE`. The location check needs both.
For location readiness alone, run the saved archive with one or two private proxy routes:

```sh
PROXY_TEST_ENV=/absolute/path/to/private.env CAMOUFOX_EXECUTABLE=/absolute/path/to/camoufox bun run test:location --archive /absolute/path/to/candidate.tgz
```

Three profiles take the supplied routes in turn, so one route serves all three. The report states whether the exits cover different timezones. Same-zone exits do not cover cross-zone cases.
See [Releasing](releasing.md) for CI validation and publication of the same workflow archive.

## Agent onboarding acceptance

Use a desktop machine with a configured coding agent. Keep its approval protections and global client configuration.
The first session follows [Agent setup](../bootstrap.md). The second runs a first browser task.

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

The model must do the browser interaction through its registered MCP tools. An SDK script can inspect the resulting state. It cannot replace real-agent evidence.
Record public bootstrap and registry installation separately when those paths form part of the test.
