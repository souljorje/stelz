# Development and testing

Use the runtime requirements in [Use the service](README.md).

## Build

```sh
bun install --frozen-lockfile
bun run build
npm pack
```

Build regenerates `dist/` from source.
The archive contains the CLI, supervisor, browser plugin, documentation, client examples, and third-party notices.
The diagnostic client runs from source. The archive excludes source files, tests, installed dependencies, and browser state.

## Checks

| Command | Coverage |
| --- | --- |
| `bun run typecheck` | TypeScript checks. |
| `bun run test` | Controller, proxy, plugin, native storage, and observation tests. |
| `bun run test:integration` | Two checkpoint identities, exclusive control, handoff, disconnect, client crash, pause, and restart. |
| `bun run test:native` | Two native identities, persistent storage, and observed device properties across restart. |
| `bun run test:proxy` | US exit IP, direct-to-proxy transition, native restart, WebRTC, and live proxy failure. |
| `bun run test:manual` | Human interaction while paused, followed by MCP resume in the same browser and tab. |
| `bun run test:package` | Archive installation in an isolated npm prefix, an empty working directory, and browser acceptance. |

All checks passed on 2026-11-02 with macOS 26.5.2 on Apple Silicon.
The run used Bun 1.4.4, Node.js 24.14.0, TypeScript 5.9.3, and Camoufox 152.0.4 beta.30.
The unit and regression suites contain 38 tests.
Camofox remains pinned to npm version 1.18.1.

The regression suite also runs directly with Node. It does not require a browser.
The plugin tests use the actual hooks with simulated browser and network interfaces.

## Continuous integration

GitHub Actions runs frozen installation, build, TypeScript checks, regression tests, and an archive dry run on Linux and macOS.
It uses the Bun version in `package.json`, Node.js 24, and read-only repository permissions.
The workflow skips browser downloads. Browser, proxy, and human acceptance checks run locally.

## Test data

Browser checks use independent MCP SDK clients and at most two identities.
Checkpoint, native, and manual checks use explicit direct development mode. Proxy acceptance uses the supplied HTTP proxy.
Each run stops its test browsers. These checks require no model credentials.

- `test:integration` uses `.state/standalone-acceptance/`. Set `STELZ_TEST_HOME` to select another test directory.
- `test:native` creates a fresh `.state/native-acceptance-*` directory.
- `test:package` uses temporary install and service directories. Its report is `.state/package-test/report.json`.

Reports, screenshots, and test profiles are disposable. Keep actual identity data in the configured `STELZ_HOME`.

For proxy acceptance, create a private env file with `PROXY_TEST_URL`. Optionally add `PROXY_TEST_EXPECTED_IP`.
Pass its absolute path in `PROXY_TEST_ENV` when running `bun run test:proxy`. Keep credentials outside the repository.
The test uses two identities through one HTTP proxy. It removes their temporary proxy credentials after stopping the browsers.

`test:manual` opens a headed fixture and pauses MCP actions. Click **Human confirmation** in that window.
The test then resumes MCP control and checks the original browser and tab.

## Diagnostics

Start the selected identity before using the diagnostic client:

```sh
bun run browser identity-02 identity_status
bun run browser identity-02 tools
```

Use the same `STELZ_HOME` for diagnostics and lifecycle commands.

## Limits

Native restart checks compare selected device properties, including WebGL and WebGL2.
They report canvas and audio differences separately. Canvas hashes changed in the latest run.
Checkpoint mode preserves cookies, localStorage, and IndexedDB. It does not preserve a complete Firefox profile.

Proxy acceptance passed with one supplied US HTTP endpoint shared by both identities.
The exit IP remained stable across restart. WebRTC stayed disabled, and an IP mismatch or live proxy outage blocked control.
Human takeover passed with a manual click while paused, followed by resume in the original browser and tab.
Codex to Hermes handoff passed with actual MCP tool calls in the same browser and tab.
Hermes read the original storage marker, changed it, and released control. The browser lifetime and device pin remained unchanged.
The check used temporary harness configurations and a working local model endpoint. The original configurations and approval policies remained unchanged.
Claude Code was not installed, so that client remains untested.
Browser executable changes require an explicit migration.
No test establishes that websites cannot detect automation.
