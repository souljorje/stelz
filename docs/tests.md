# Development and testing

Use the runtime requirements in [Use the service](README.md).

## Build

```sh
bun install --frozen-lockfile
bun run build
npm pack ./packages/stelz
```

Build regenerates `packages/stelz/dist/` from source.
The archive contains the CLI, supervisor, browser plugin, built local UI, documentation, client examples, and third-party notices.
The diagnostic client runs from source. The archive excludes source files, tests, installed dependencies, and browser state.

## Checks

| Command | Coverage |
| --- | --- |
| `bun run typecheck` | TypeScript checks. |
| `bun run test:ui` | UI sessions, lifecycle dispatch, profile creation and deletion, interrupted saves, safe network edits, and redaction. |
| `bun run test:ui:browser` | Built UI in Chrome, local sessions, offline assets, forms, and responsive layouts. |
| `bun run test` | Controller, lifecycle, setup, proxy, plugin, native storage, and observation tests. |
| `bun run test:integration` | Two checkpoint profiles, exclusive control, handoff, disconnect, client crash, pause, and restart. |
| `bun run test:native` | Two native profiles, storage isolation, and repeated fingerprint samples across three browser lifetimes. |
| `bun run test:window-close` | Close one isolated test window when prompted. Check clean shutdown, Stopped UI state, and explicit restart. |
| `bun run test:windows` | Native profile labels, window focus, unchanged website titles, and controller preservation in two isolated Camoufox profiles. |
| `bun run test:proxy` | Two distinct proxy exits, three browser lifetimes, expected IP pins, and isolated route failures during cached verification. |
| `bun run test:manual` | Human interaction while paused, followed by MCP resume in the same browser and tab. |
| `bun run test:public --profile ID` | Four public fingerprint checks in an existing Camoufox profile, with screenshots and verdict reports. |
| `bun run verify:release` | npm pack lifecycle, archive contents, isolated install, CLI, HTTP UI, and staged setup validation with a fake executable. No browser. |
| `bun run test:package` | Archive installation in an isolated npm prefix, an empty working directory, and browser acceptance. |

The earlier browser acceptance run passed on 2026-11-02 with macOS 26.5.2 on Apple Silicon.
That run used Bun 1.4.4, Node.js 24.14.0, TypeScript 5.9.3, and Camoufox 152.0.4 beta.30.
Camofox remains pinned to npm version 1.18.1.

The regression suite also runs directly with Node. It does not require a browser.
The plugin tests use the actual hooks with simulated browser and network interfaces.
They cover stalled actions, failed IP checks, explicit recheck, action serialization, cache expiry, and independent provider fallback.
One hundred queued actions require one IP check with the default cache, compared with 101 checks in strict mode.
This request count includes the startup check. It does not measure external service latency.
The mismatch test expires verification after 100 successful cached actions.
The next check must reject the unexpected exit. Subsequent actions must remain blocked until an explicit successful recheck.
Network-failure tests cover proxy, DNS, and connection errors, including structured upstream responses.
They check queue order, status during recheck, and rejection of page contents or URLs as network diagnostics.
Live acceptance on 2026-11-03 ran 100 MCP tab-list actions per profile without refreshing verification.
Explicit recheck bypassed the two-minute cache. Both profiles stopped after the check.
Lifecycle and setup tests cover orphaned servers, interrupted setup, and concurrent lock recovery.

Build the UI before `test:ui:browser`.
That check uses the actual UI API and isolated service files with simulated lifecycle operations.
It does not start Camoufox profiles.
It uses installed Chrome on macOS. Set `STELZ_UI_CHROME` to select another Chrome or Chromium executable.
Screenshots and its report are in `.state/ui-browser/`.
The UI check also creates profiles with and without a proxy, confirms deletion, and checks profile archives.

## Continuous integration

GitHub Actions runs frozen installation, build, TypeScript checks, regression tests, and isolated browser-free archive verification on Linux and macOS.
CI and release workflows use the root `package.json` `packageManager` pin (`bun@1.4.4`), Node.js 24, and read-only repository permissions.
The manual release workflow runs the same checks on Linux and uploads the archive as an artifact.
Both workflows skip browser downloads. Browser, proxy, and human acceptance checks run locally.

## Test data

Browser checks use independent MCP SDK clients and at most two profiles.
Checkpoint, native, and manual checks use explicit direct development mode. Proxy acceptance requires two supplied HTTP proxies.
The isolated acceptance checks stop their test browsers. The public-site check saves its artifacts, then stops its selected browser.
These checks require no model credentials.

- `test:integration` uses `.state/standalone-acceptance/`. Set `STELZ_TEST_HOME` to select another test directory.
- `test:native` creates a fresh `.state/native-acceptance-*` directory.
- `test:windows` creates a fresh `.state/profile-windows-*` directory with native and checkpoint profiles.
- `test:package` uses temporary install and service directories. Its report is `.state/package-test/report.json`.

Reports, screenshots, and test profiles are disposable. Keep actual profile data in the configured `STELZ_HOME`.

The default tests check add-on generation, stale inventories, focus acknowledgements, timeouts, and UI session protections without a browser.
They also check credential redaction before display limits and one secrets-file read per window inventory.
UI browser checks cover disabled window controls, aligned actions, and polling that stops on hidden tabs.

For proxy acceptance, create a private env file with `PROXY_TEST_URL` and `PROXY_TEST_SECOND_URL`.
Optionally add `PROXY_TEST_EXPECTED_IP` and `PROXY_TEST_SECOND_EXPECTED_IP` to pin known exit addresses.
Pass its absolute path in `PROXY_TEST_ENV` when running `bun run test:proxy`. Keep credentials outside the repository.
The test requires different observed exits. Two credentials or endpoints with the same exit cannot pass.
Without supplied IP pins, preflight observations establish the expected addresses for that run.
Each profile uses its own relay. The test collects repeated browser observations across three explicit starts and stops.
It then interrupts each relay separately while the successful verification cache remains fresh.
The failed route must reject external browser requests. The other route must retain its own expected IP.
Explicit recheck must block only the failed profile. Recovery must preserve the original browser lifetime.
The test also checks swapped IP pins, WebRTC policy, storage isolation, and unchanged device settings.
Its report is `.state/proxy-acceptance-*/report.json`. Cleanup stops the test browsers and removes their temporary credentials.
The input env file remains private operator data. Remove that file when it is no longer necessary.

`test:manual` opens a headed fixture and pauses MCP actions. Click **Human confirmation** in that window.
The test then resumes MCP control and checks the original browser and tab.

## Window acceptance

Keep two browser slots available. Run these commands from the source checkout:

```sh
bun run build
bun run test:windows
```

This check requires desktop access for visible Camoufox windows.
It starts two isolated profiles, one with native storage and one with checkpoint storage.
It stops only those test profiles during cleanup.
The report is `.state/profile-windows-*/report.json`.

The check covers native title prefixes, unchanged page titles, page selection, controller preservation, and rejection of old browser lifetimes.
It also checks that release and disconnect preserve the windows.
A successful run records `result: "passed"`.
Foreground restrictions record `result: "incomplete"`, with reasons in `foregroundLimits`, and produce a nonzero exit code.
Other failures record `result: "failed"` and produce a nonzero exit code.

Use `bun run test:windows --inspect` to print a temporary UI session URL after the checks.
Open that URL during the 45-second inspection period. The test then stops its UI and browsers.
Window acceptance passed on 2026-11-03 with both storage modes.

## Public fingerprint checks

Start the selected Camoufox profile before this check. Use the same `STELZ_HOME` as the service.

```sh
bun run start profile-02
bun run test:public --profile profile-02
```

The suite uses stelz MCP tools to visit these sites in order:

| Site | Pass condition |
| --- | --- |
| [Fingerprint web scraping](https://demo.fingerprint.com/web-scraping) | The default query displays flight cards without a detection warning. |
| [Fingerprint Playground](https://demo.fingerprint.com/playground) | Desktop detection flags are clear, with low-confidence proxy findings treated as warnings. |
| [Pixelscan](https://pixelscan.net/fingerprint-check) | The completed fingerprint is consistent and its summary checks report no warnings. |
| [Rebrowser](https://bot-detector.rebrowser.net/) | Applicable automatic probes pass. Chromium-specific and untriggered probes have explicit skip reasons. |

Each site runs its checks automatically. The suite reads fresh snapshots without injected scripts or detector overrides.
Playground flags include bot detection, tampering, incognito, VPN, proxy, developer tools, virtual machines, privacy settings, blocklists, high activity, and rarity.
Detected flags fail that check, except a proxy finding with explicitly low confidence.
Low-confidence proxy findings appear as warnings. They do not override bot detection, tampering, or other failures.
Medium-confidence and high-confidence proxy findings still fail. Numeric scores, mobile signals, and fields that require location permission remain informational.
The suite does not request location permission or trigger Rebrowser's scripted probes.
Rebrowser reports each native probe separately. Skipped and untriggered probes do not count as passed checks.
Its overall result describes the applicable checks and states the remaining coverage limits.

The suite acquires one running profile and creates four tabs sequentially.
It keeps existing tabs during the checks. After saving its artifacts, it runs `stelz stop ID` to close that profile's windows.
Cleanup also runs after failed or interrupted checks. Saved profile data remains available for the next explicit start.
Cleanup applies only after successful acquisition. A controller conflict leaves the browser running.
The suite does not start browsers. Other profiles remain unchanged.
An active controller prevents acquisition. Release that controller before you retry.

The suite checks each page every two seconds for up to 120 seconds, excluding human authentication time.
It waits for each MCP operation to finish. A service deadline blocks further browser actions and requires an explicit stop and start.
Individual site errors do not prevent later checks when the profile remains usable.

Authentication pauses the profile. Complete authentication in the same Camoufox window, then type `done` in the terminal.
Without an interactive terminal, the suite records an incomplete result and stops the browser during cleanup.
Cancelling authentication also ends the run and stops the browser. Start the profile before the next run.

Artifacts are in `.state/public-sites/<run>/`. Each run creates `report.json` and `report.md`.
Visited sites also have a PNG screenshot and a snapshot JSON file when capture succeeds.
The flight check activates the observed Search button. This scrolls the form into view and repeats the default search.
A fresh snapshot records the result before the final screenshot.
PNG files capture the native viewport. Snapshot files contain the accessible page results.
Reports contain the profile, URLs, times, observed verdicts, reasons, artifact paths, and errors.
Snapshots can contain visitor IDs, IP addresses, and other browser data. Files have private permissions.

Results are `PASS`, `FAIL`, `INCONCLUSIVE`, `UNSUPPORTED`, or `ERROR`.
Loading pages, missing signals, and unfamiliar results cannot pass. Capture errors remain separate from observed detector verdicts.
Reports update after each site. Interrupts preserve partial reports and stop the browser after pending operations finish.
The report records whether shutdown succeeded in its `stopped` field. Shutdown errors cause the command to fail.
The command exits successfully only when all four checks pass and all four screenshot captures succeed.
Shutdown must also succeed.
Advisory warnings do not fail the run. Rebrowser's partial coverage remains explicit in its result.

Live checks are opt-in. The default test command runs the offline verdict and runner tests without visiting public sites.

## Typing acceptance

Run `bun run build`, then `bun run test:typing` with a browser slot available.
The check starts one headed browser in a separate service directory. It does not change existing profiles.
The check uses standard MCP tools and a local page that records input events.
It checks variable timing, replacement, Unicode, multiline text, editable content, numeric and date inputs, and Enter submission.
It also checks that oversized paced input preserves existing text and that instant mode enters bulk text.
The check explicitly stops its browser. Results are in `.state/typing-acceptance-*/report.json`.
The default test command checks typing logic and runtime setup without starting a browser.

To use an existing stopped profile, run `bun run test:typing --profile ID`.
Its service must already contain the current typing runtime.
This mode starts and stops the selected profile twice. Typing mode overrides apply only to the test processes.
The profile catalog and secrets file remain unchanged.

## Diagnostics

Start the selected profile before using the diagnostic client:

```sh
bun run browser profile-02 profile_status
bun run browser profile-02 tools
```

Use the same `STELZ_HOME` for diagnostics and lifecycle commands.

## Limits

Native fingerprint acceptance records three explicit browser lifetimes per profile.
Each lifetime contains two fresh documents with three sequential samples per document.
The report records raw samples, unique values, incomplete probes, and differences within documents, within lifetimes, and across lifetimes.
It also records the browser engine hash, host environment, display observations, experiment recipe, and network policy.
The contract requires unchanged saved device settings and persistent cookie, localStorage, and IndexedDB markers under the same recorded environment.
Selected device properties, including WebGL and WebGL2, must match in this controlled experiment.
Canvas and audio hashes remain measured outputs. The service does not guarantee identical hashes within a lifetime or across restarts.
Missing or failed probes cannot establish stability. A difference across lifetimes does not establish that a restart caused it.
Language and timezone follow current network policy. A policy change is separate from drift under an unchanged policy.
Observed stability applies only to the recorded environment and samples. It does not establish future stability or website acceptance.
Native measurement passed on 2026-11-03 with Camoufox 152.0.4 beta.30 on macOS arm64.
Both profiles produced 18 complete samples across three lifetimes. All required device properties and storage markers remained stable.
Each profile produced three canvas hashes, one per lifetime. Canvas hashes matched within each lifetime.
Each profile produced one audio hash across all samples. These observations do not extend the stability contract.
Checkpoint mode preserves cookies, localStorage, and IndexedDB. It does not preserve a complete Firefox profile.

Earlier proxy acceptance used one shared endpoint. That evidence did not establish distinct profile exits.
The current proxy check requires two distinct exits and repeated browser measurements before it can pass.
Two-proxy acceptance passed on 2026-11-03 with exits `206.220.14.4` and `198.135.34.88`.
Each exit remained unchanged across three browser lifetimes with three independent samples per lifetime.
Both relay interruptions prevented external requests while successful cached verification was less than one second old.
The other profile retained its own exit. Explicit recheck blocked the failed route, and recovery preserved its browser lifetime.
Swapped IP pins blocked both profiles. All test browsers stopped during cleanup.
Human takeover passed with a manual click while paused, followed by resume in the original browser and tab.
Codex to Hermes handoff passed with actual MCP tool calls in the same browser and tab.
Hermes read the original storage marker, changed it, and released control. The browser lifetime and device pin remained unchanged.
The check used temporary harness configurations and a working local model endpoint. The original configurations and approval policies remained unchanged.
Claude Code was not installed, so that client remains untested.
Browser executable changes require an explicit migration.
No test establishes that websites cannot detect automation.

## Source layout

- `tests/unit/`: offline logic and verdict tests, including Node regression tests.
- `tests/integration/`: offline process, setup, catalog, and transaction checks.
- `tests/browser/`: explicit browser acceptance commands.
- `tests/qa/`: package, public-site, and human acceptance commands.
- `tests/helpers/`: shared fixtures and verdict readers.
- `scripts/call.ts`: development MCP diagnostic client.

UI source is in `apps/ui/src/`. Its browser imports use only `packages/stelz/src/api/contracts.ts`.
The contract contains no Node, Bun, or server imports. It is not a public package API.
