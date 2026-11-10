# Testing

Run commands from the repository root unless a procedure states otherwise.
Use the pinned Bun version in `package.json` and Node.js 24 or later.
See [Runtime requirements](../getting-started.md#what-you-need) for installation prerequisites.
Actual browser checks require desktop access. Their setup step prepares the paired Camoufox build.
See [How setup finds the browser](../getting-started.md#how-setup-finds-the-browser).

## Standard checks

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
```

`check` builds the package, checks TypeScript, and runs all tests that require no browser.
Build regenerates `dist/` from source. Bun builds the CLI, supervisor, plugin, and early theme script.
Vite builds the React UI with local fonts and licenses.
Build also checks Markdown links in the packaged documentation.

| Command | Coverage |
| --- | --- |
| `bun run typecheck` | TypeScript checks. |
| `bun run test` | Bun unit and integration tests in parallel workers, followed by Node regression tests. No browser. Run `bun test FILE` to check one file alone. |
| `bun run test:regression` | Browser plugin and persistence regression tests through Node. No browser. |
| `bun run test:ui` | UI sessions, lifecycle dispatch, catalog limits, safe configuration edits, rename, window models, and redaction. No browser. |
| `bun run test:ui:browser` | Built UI in Chrome or Chromium with isolated service files and simulated lifecycle operations. |
| `bun run test:integration` | Two native profiles, exclusive control, handoff, disconnect, client crash, pause, and restart. |
| `bun run test:concurrency` | Three native profiles, simultaneous starts, isolated storage, duplicate starts, and handoff on a local fixture. |
| `bun run test:native` | Native storage isolation and repeated device measurements across three browser lifetimes. |
| `bun run test:transfer` | ZIP export/import, batch copies, saved sessions, device records, fresh access keys, and imported-profile window controls. |
| `bun run test:window-close` | A prompted window close, clean shutdown, Stopped UI state, and explicit restart. |
| `bun run test:windows` | Native profile labels, focus, unchanged website titles, and controller preservation in two profiles. |
| `bun run test:proxy` | Two distinct proxy exits, repeated starts, expected IP pins, and isolated route failures during cached verification. |
| `bun run test:manual` | A human action while paused, then MCP resume in the same browser and tab. |
| `bun run test:typing` | All typing modes, input events, live defaults, overrides, replacement, and submission through MCP. |
| `bun run test:public` | Four public fingerprint checks with screenshots, observed verdicts, and explicit coverage limits. |
| `bun run pack` | Build a local candidate archive and checksum in `release-artifacts/`. |
| `bun run test:install --archive FILE` | Inspect an unchanged archive, isolated npm installation with scripts disabled, CLI, HTTP UI, and staged setup. No browser. |
| `bun run test:install --archive FILE --native` | Ordinary npm installation, SQLite queries, and Impit construction from the installation and staged runtime. No browser. |
| `bun run test:setup --archive FILE` | Install one unchanged archive. Check setup consent, a wrong configured browser, the pinned release metadata, an upstream cache clone with a concurrent setup, an offline repeat, an interrupted and repeated location download, and an update while a profile runs. Downloads no browser and starts one headed browser. |
| `bun run test:package --archive FILE` | Install one unchanged archive. Run integration, native persistence, transfer, concurrency, and typing acceptance. |
| `bun run test:package --archive FILE --setup --windows --proxy --manual` | Add setup, window controls, proxy and location checks, and human acceptance on the same installation. |

Select suites according to changed behavior. `bunx lefthook run browser` selects them from the files the branch changes.
The repository root `lefthook.yml` holds the file map and the run options. Browser checks require an explicit command.
Run the full archive suites with `test:package` once per candidate, not after each fix.
The default tests do not establish browser persistence, proxy routing, or human takeover.
Historical results are in [Browser acceptance, November 2026](reports/browser-acceptance-2026-11.md)
and [Onboarding, 2026-11-05](reports/onboarding-2026-11-05.md).
Those reports do not validate a new checkout or release.

## Tests without browsers

Bun discovers `tests/unit/` and `tests/integration/`.
Node runs `tests/regression/` directly with TypeScript transformation.
Plugin tests execute actual hooks with simulated browser and network interfaces.
They cover stalled actions, failed checks, explicit recheck, serialization, cache expiry, and independent provider fallback.

The verification-cache tests compare 100 queued actions under default and strict policies.
The expected counts include the startup check: one check with the default cache and 101 in strict mode.
These counts do not measure external service latency.
A mismatch after cache expiry must block subsequent actions until an explicit successful recheck.

Network tests cover proxy, DNS, and connection errors, including structured upstream responses.
They check queue order and status during recheck.
Page contents and URLs must not serve as network diagnostics.
Lifecycle and setup tests cover orphaned servers, interrupted setup, and concurrent lock recovery.

For shared MCP changes, check all 18 tool schemas with an empty catalog and after profile creation.
Check fresh catalogs, direct creation, unchanged reuse, and explicit start through one connection.
Check concurrent control of separate profiles and exclusive control of each profile.
Require fresh handles after acquisition, release, reconnect, restart, and forced operator handoff.
Reject handles from another connection, profile, or browser lifetime.
Check that list and status omit handles. Release and disconnect must preserve browsers and pages.
Keep the MCP migration error separate from valid profile-import `--profile` selectors.

Profile creation tests cover direct and proxy inputs, reuse, concurrent creation, conflicts, redaction, missing initialization, and interrupted transactions.
Transfer tests cover ZIP64, unsafe paths and links, checksums, size limits, cancellation, credential redaction, conflicts, and recovery.
Window tests cover generated add-ons, stale inventories, focus acknowledgements, timeouts, and credential redaction before display limits.
Lifecycle fixtures use copied source and mock plugin bytes. They require no workspace build output.

## Built UI acceptance

```sh
bun run build
bun run test:ui:browser
```

This check uses the actual UI API with isolated service files and simulated lifecycle operations.
It starts no Camoufox profiles.
It uses installed Chrome or Chromium. Set `STELZ_UI_CHROME` to select its executable.
The check covers sessions, offline assets, forms, profile creation, deletion archives, disabled window controls, layout, and hidden-tab polling.
Screenshots and its report are in `.state/ui-browser/`.

## Browser fixtures and cleanup

Build before running browser acceptance. Browser checks use independent MCP SDK clients and synthetic local pages.
These checks require no model credentials.
The separate agent-onboarding procedure requires a configured coding agent.

Live checks create disposable profiles in separate service directories.
They must not select an operator's saved profile.
Native and manual checks use direct development networking. Proxy acceptance requires supplied proxies.
Tests explicitly stop their own browsers during cleanup.
Keep failed test state for inspection. Keep actual profile data in the configured `STELZ_HOME`.

| Suite | Data and reports |
| --- | --- |
| Integration | Fresh `.state/standalone-acceptance-*` directory with `report.json`. `STELZ_TEST_HOME` must identify a directory from `tests/helpers/test-home.ts`. |
| Native measurements | Fresh `.state/native-acceptance-*` directory with `report.json`. |
| Concurrency | Fresh temporary service directory. Report: `.state/concurrency-acceptance/report.json`. Success removes its service directory. Failure preserves it. |
| Profile windows | Fresh `.state/profile-windows-*` directory with `report.json`. |
| Window close | Fresh `.state/window-close-*` directory with `report.json`. |
| Typing | Fresh `.state/typing-acceptance-*` directory with `report.json`. |
| Human takeover | Fresh `.state/manual-acceptance-*` directory with `report.json`. |
| Package | Temporary npm prefix and service directory. Report: `.state/package-test/report.json`. |

Reports and snapshots can contain private browser data. Keep them and all proxy credentials outside Git.

## Native storage and device measurements

```sh
bun run build
bun run test:native
```

The check starts three native profiles across three explicit browser lifetimes each.
It records three fresh-direct lifetimes and six saved-valid-direct lifetimes, with unchanged saved pins.
Each lifetime contains two fresh documents with three sequential samples per document.
The report records raw samples, unique values, incomplete probes, and differences within documents, within lifetimes, and across lifetimes.
It also records the engine hash, host environment, display observations, experiment recipe, and network policy.

The contract requires unchanged saved device settings and persistent cookie, localStorage, and IndexedDB markers under the recorded environment.
Selected device properties, including WebGL and WebGL2, must match in this controlled experiment.
Canvas and audio hashes remain measured outputs. The service does not guarantee identical hashes within a lifetime or across restarts.
Missing or failed probes cannot establish stability.
A difference across lifetimes does not establish that a restart caused it.
Language and timezone follow current network policy. A policy change is separate from drift under unchanged conditions.
Observed results apply only to the recorded environment and samples.
A changed browser executable blocks startup of existing profiles.

## Profile transfer acceptance

```sh
bun run build
bun run test:transfer
```

This check requires desktop access for Camoufox.
It creates a fresh `.state/transfer-native-*` service directory and uses synthetic data on a local fixture.
It checks cookies, localStorage, IndexedDB, fingerprint bytes, a fresh access key, and window controls after import.
The report is `.state/profile-transfer/report.json`. Cleanup stops only its test profiles.

To check an installed release's ZIP commands without starting browsers, run this from the source checkout:

```sh
STELZ_TEST_CLI=/absolute/path/to/installed/stelz \
  bun test tests/integration/profile-transfer-cli.test.ts
```

These tests use disposable directories and a synthetic executable for compatibility hashes.
They check batch copies, credentials, destination IDs, output-file protection, mismatched engines, and unclean lifetimes.
See [Profile transfer](../profile-transfer.md) for supported behavior.

## Proxy and human acceptance

Use local fixtures and synthetic proxy inputs for routine tests.
Live acceptance requires declared test proxies. Never copy proxies from everyday profiles.
The runner cannot verify proxy ownership. The operator must supply the correct route.

1. Create a private env file outside the repository with `PROXY_TEST_USAGE=dedicated-acceptance`.
2. Set `PROXY_TEST_URL` in that file. Also set `PROXY_TEST_SECOND_URL` to check two different exits.
3. Optionally set `PROXY_TEST_EXPECTED_IP` and `PROXY_TEST_SECOND_EXPECTED_IP` to require known exits.
4. Build the service.
5. Run the check with the file's absolute path:

   ```sh
   PROXY_TEST_ENV=/absolute/path/to/private.env bun run test:proxy
   ```

With two routes, the test requires different observed exits. Two endpoints with the same exit cannot pass.
With one route, both relays use it. Relay evidence identifies each route, and the report marks the distinct-exit check as unexecuted.
Without supplied IP pins, preflight observations establish the expected addresses for that run.
Each profile uses its own relay.
The check collects repeated browser observations across three explicit starts and stops.
Each relay serves a unique `.invalid` hostname. The browser must display that relay's nonce.
This proves that the request does not require local DNS resolution. It does not prove the absence of OS or browser DNS leaks.

It interrupts each relay while successful verification remains cached.
The failed route must reject external requests. The other route must retain its expected IP.
Explicit recheck must block only the failed profile. Recovery must preserve the original browser lifetime.
The check also covers a mismatched expected IP, WebRTC policy, isolated storage, and unchanged saved device settings.
Two routes swap their pins. One route uses a documentation address.

The report is `.state/proxy-acceptance-*/report.json`.
Cleanup stops test browsers and removes temporary credential copies.
The supplied env file remains private operator data. Remove it when no longer necessary.
See [Proxies](../proxies.md) for network behavior.

Run `bun run test:manual` for human takeover.
Click **Human confirmation** in its visible fixture while MCP actions are paused.
The check resumes MCP control and checks the original browser and tab.
Complete any authentication in that same window.

## Window acceptance

```sh
bun run build
bun run test:windows
```

This check starts two isolated native profiles and requires visible desktop windows.
It checks title prefixes, unchanged page titles, page selection, controller preservation, and rejection of stale browser lifetimes.
It also checks that release and disconnect preserve windows.
Cleanup stops only those test profiles.

The report records `passed`, `incomplete`, or `failed`.
Foreground restrictions produce `incomplete`, reasons in `foregroundLimits`, and a nonzero exit code.
Other failures produce `failed` and a nonzero exit code.
Use `bun run test:windows --inspect` to print a temporary UI URL for a 45-second inspection period.
The check then stops its UI and browsers.

Run `bun run test:window-close` for shutdown behavior.
Close only the isolated test window when prompted.
The check must observe clean shutdown, Stopped UI state, and explicit restart.

## Typing acceptance

```sh
bun run build
bun run test:typing
```

The check starts one visible browser in a separate service directory.
It uses standard MCP tools and a local page that records input events.
It checks variable timing, replacement, Unicode, multiline text, editable content, numeric and date inputs, and Enter submission.
All three `camofox_type` modes use the same browser, tab, and MCP connection.

Long automatic input uses one bulk fill.
Keyboard mode sends trusted `keydown`, `keypress`, `keyup`, and input events.
Instant mode uses bulk entry even for short text. Enter submits exactly once.
The check also covers live profile defaults and per-call overrides without a browser restart.
It rejects `--profile`. Every run creates a disposable profile and explicitly stops it.

The default tests execute the upstream type route and tab lock with virtual timers.
They cover long input, terminal timeouts, and serialization without starting a browser.

## Public fingerprint checks

```sh
bun run build
bun run test:public
```

These opt-in checks visit public sites through Stelz MCP tools.
The default tests exercise verdict and runner logic without visiting those sites.
Site results describe observed checks. They do not establish that websites cannot detect automation.

| Site | Required observation |
| --- | --- |
| [Fingerprint web scraping](https://demo.fingerprint.com/web-scraping) | The default query displays flight cards without a detection warning. |
| [Fingerprint Playground](https://demo.fingerprint.com/playground) | Desktop detection flags are clear. An explicitly low-confidence proxy finding is a warning. |
| [Pixelscan](https://pixelscan.net/fingerprint-check) | The completed fingerprint is consistent and its summary checks report no warnings. |
| [Rebrowser](https://bot-detector.rebrowser.net/) | Applicable automatic probes pass. Chromium-specific and untriggered probes have explicit skip reasons. |

The suite reads fresh snapshots without injected scripts or detector overrides.
Playground flags include bot detection, tampering, incognito, VPN, proxy, developer tools, virtual machines, privacy settings, blocklists, high activity, and rarity.
A detected flag fails the check except an explicitly low-confidence proxy finding.
That warning cannot override bot detection, tampering, or other failures.
Medium-confidence and high-confidence proxy findings fail.
Numeric scores, mobile signals, and fields that require location permission remain informational.
The suite requests no location permission and does not trigger Rebrowser's scripted probes.
Skipped and untriggered probes do not count as passes.

Public checks are occasional acceptance checks. Reserve a separate proxy for these checks.
Do not share this proxy with lifecycle tests, which create multiple identities.
The suite reuses one native profile and opens four tabs in sequence.
It rejects `--profile` and ignores the operator's `STELZ_HOME`.
Set `PROXY_TEST_ENV` to a private file with `PROXY_TEST_USAGE=dedicated-public` and `PROXY_TEST_URL`.
Add `PROXY_TEST_EXPECTED_IP` when an exit pin is necessary.
From the repository root, create a test home once. Save the printed absolute path:

```sh
bun --no-env-file -e 'import { createTestHome } from "./tests/helpers/test-home.ts"; console.log(createTestHome("public-profile", ".state"));'
```

Use that same path for every public check:

```sh
PUBLIC_TEST_HOME=/absolute/path/printed/above PROXY_TEST_ENV=/absolute/path/to/public.env bun run test:public
```

The home retains cookies and device settings. It is bound to the proxy protocol, host, port, and IP pin.
A credential rotation keeps the profile. A route or IP pin change needs a new `PUBLIC_TEST_HOME`.
Concurrent runs cannot share the home. After a crash, verify that the run has stopped before removing `.public-check.lock`.
There is no automatic direct-connection fallback or shell proxy URL fallback.
The suite copies those inputs to its test directory and removes that copy during cleanup.

Each page receives checks every two seconds for up to 120 seconds, excluding human authentication time.
The runner waits for each MCP operation to finish.
A service deadline blocks further actions and requires explicit stop and start.
A site error does not prevent later checks when the profile remains usable.

Authentication pauses the profile. Complete authentication in the same Camoufox window.
Then type `done` in the terminal.
A noninteractive terminal or cancelled authentication produces an incomplete run.
Cleanup stops the browser. Another run reuses the saved profile.

Artifacts are in `.state/public-sites/<run>/`.
Each run writes `report.json` and `report.md`.
Visited sites receive PNG screenshots and snapshot JSON files when capture succeeds.
The flight check activates the observed Search button and repeats the default search.
A fresh snapshot records the result before the final screenshot.
Screenshots capture the native viewport. Snapshots contain accessible page results.
Reports record profile, URLs, times, observed verdicts, reasons, artifacts, and errors.
Snapshots can contain visitor IDs and IP addresses. Files use private permissions.

Results are `PASS`, `FAIL`, `INCONCLUSIVE`, `UNSUPPORTED`, or `ERROR`.
Loading pages, missing signals, and unfamiliar results cannot pass.
Capture errors remain separate from observed detector verdicts.
Reports update after each site. Interrupts preserve partial reports and stop the browser after pending operations finish.
The `stopped` field records cleanup success. Shutdown errors cause command failure.
Success requires four passing site checks, four successful screenshots, and successful shutdown.
Advisory warnings do not fail the run. Rebrowser's partial coverage remains explicit.

## Installed-package acceptance

`test:package --archive FILE --proxy` runs location acceptance on its own installation. For location readiness alone, run the saved archive with one or two private proxy routes:

```sh
PROXY_TEST_ENV=/absolute/path/to/private.env CAMOUFOX_EXECUTABLE=/absolute/path/to/camoufox bun run test:location --archive /absolute/path/to/candidate.tgz
```

This check reuses the isolated package installer and existing proxy relays.
It checks setup reuse, preflight, browser location, permissions, native storage, fingerprints, and scrolling across three lifetimes for each of three profiles.
The first lifetime uses a fresh profile; the next two preserve its saved pin. Each profile has its own relay. Profiles take the supplied routes in turn, so one route serves all three.
It records proxy destinations and restored fixture requests before Ready. These observations do not establish complete traffic isolation.
The report states whether the supplied exits cover different timezones. Same-zone exits do not establish cross-zone coverage.
Only temporary test profiles are stopped. Private proxy credentials stay outside reports and Git.

```sh
bun run pack
bun run test:install --archive /absolute/path/to/candidate.tgz
bun run test:package --archive /absolute/path/to/candidate.tgz --setup
```

`test:package --setup` runs `test:setup` on its own installation, so release acceptance installs the archive once with lifecycle scripts.
Each installation uses a new prefix. The npm download cache persists in `.state/npm-cache`, and npm verifies each package's integrity hash.
`test:setup` hides the upstream Camoufox cache for its consent case. Its other cases read the paired build from that cache and need it. Unit tests cover the browser download with a fixture release. The suite needs network access to GitHub.
It writes `.state/package-test/setup-report.json` and removes its files after a pass.

The package suite installs with lifecycle scripts and runs the native dependency checks, so it replaces `test:install --native` here.
It also replaces separate source-tree runs of the suites it repeats against the installation. Use those for development.

Use the archive path printed by `pack` in each command. Do not rebuild between acceptance checks.
`pack --destination DIRECTORY` selects another output directory.
Without `--archive`, local checks select the current manifest version under `release-artifacts/`.
An explicit path also works for the Changesets workflow's `release-artifacts/packages/` layout.

The installer checks archive contents and Markdown links, compares prepared dependencies, and tests the installed CLI and bundled UI.
It validates staged setup using a fake browser executable. It does not launch that executable.
The `--native` mode enables ordinary npm lifecycle scripts and executes native dependency checks.
The package suite always includes native persistence and transfer acceptance.
Its accepted `--native` flag is unnecessary for those checks.

For full package acceptance, supply `PROXY_TEST_ENV` as described above and an absolute `CAMOUFOX_EXECUTABLE`. The location check requires both.
Run `bun run test:package --archive FILE --setup --proxy --manual`.
The human check requires an actual click in the visible browser.
The suite checks that runtime links do not depend on the source checkout and that the archive hash remains unchanged.
See [Releasing](releasing.md) for CI validation and publication of the same workflow archive.

## Agent onboarding acceptance

Use a desktop machine with a configured coding agent. Preserve its approval protections and global client configuration.
Use [Bootstrap](../bootstrap.md) for agent installation orchestration.
Use [Client verification](../clients.md#verify-the-connection) for the registered-tool check.

1. Build and pack a candidate.
2. Prepare a new writable project directory, npm prefix, and temporary `STELZ_HOME`.
3. Give a fresh agent the bootstrap document, archive, test locations, and this request:

   > Follow the bootstrap document. Install the supplied archive into the test prefix.
   > Use the temporary STELZ_HOME. Create or reuse profile work.
   > Install the canonical skill in this test project's supported location. Preserve global client configuration and approval protections.
   > Register one shared `stelz mcp` connection at project scope if supported.
   > Otherwise record exact connection arguments for the operator. Preserve the same STELZ_HOME.
   > Verify through your actual registered browser tools.
   > Report Installed, Browser ready, Client configured, and Verified separately.
   > State pending verification when tools are unavailable. Release control after verification. Leave the browser running.

4. Record actions, errors, and intervention requests.
5. Start a new client session if registration requires it. Resume verification with the same profile and saved connection.
6. Require a fresh profile catalog and actual acquisition with `{profileId}`.
7. Require the returned handle on browser calls, fresh snapshots, an observed fixture action, result verification, and release.
8. Repeat the original onboarding request through the same registration.
9. Check the same profile ID, port, secret references, browser lifetime, and persistent fixture marker.
10. Stop only the test profile after release and reuse evidence is complete.
11. Stop the fixture server separately. Retain failed test state for inspection.

A model must perform browser interaction through its registered MCP tools.
An SDK script can inspect resulting state. It cannot replace real-agent evidence.
The installed-package verifier checks the CLI and onboarding resources outside the source checkout.
Record public bootstrap and registry installation separately when those paths form part of the test.
See the [2026-11-05 report](reports/onboarding-2026-11-05.md) for one assisted run and its limits.

## Continuous integration

`.github/workflows/ci.yml` runs on pull requests, manual dispatch, and reusable workflow calls.
It runs `bun run check` on Linux and macOS.
The shared setup action selects Bun from `packageManager`, Node.js 24, and its pinned npm version.
It caches Bun packages by `bun.lock`, except for publication. It installs frozen dependencies with lifecycle scripts disabled and skips browser downloads.
A parallel job packs the archive and runs `test:install` with scripts disabled and with native installation. The Release workflow skips that job and checks its own archive. No CI job starts a live browser.

The Release workflow requires those checks before version updates or packaging.
Its installation matrix checks one saved archive on Linux and macOS with scripts disabled and with ordinary native installation.
The publication job downloads and publishes that same archive.
Browser, proxy, and human acceptance remain explicit local checks.
See [Releasing](releasing.md) for the complete workflow and permissions.

## Diagnostics and source layout

Start the selected profile before using the development diagnostic client:

```sh
bun run browser profile-02 profile_status
bun run browser profile-02 tools
```

Use the same `STELZ_HOME` for diagnostics and lifecycle commands.
The diagnostic client runs from source. It is not part of the installed CLI.

| Path | Contents |
| --- | --- |
| `tests/unit/` | Logic, archive format, UI API, and verdict checks. |
| `tests/regression/` | Plugin and persistence checks through Node. |
| `tests/integration/` | Process, setup, catalog, CLI, and transaction checks without browsers. |
| `tests/browser/` | Explicit browser acceptance commands. |
| `tests/package/` | Isolated archive installation checks. |
| `tests/qa/` | Package, public-site, and human acceptance commands. |
| `tests/helpers/` | Shared fixtures, observations, and verdict readers. |
| `scripts/call.ts` | Development MCP diagnostic client. |

See [Architecture](architecture.md) for UI contracts and runtime source layout.
