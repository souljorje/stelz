---
title: "Testing"
description: "Commands for routine checks, fixtures, CI, and diagnostics, to read when you choose the command for a change."
tags: [development, testing]
sources: []
created: 2026-11-06T13:49:16Z
modified: 2026-11-16T10:19:11Z
---

# Testing

- No browser needed. Browser, archive, proxy, human, and agent suites: see [Acceptance](acceptance.md).
- Run commands from the repository root.
- Use the pinned Bun version in `package.json`. Other requirements: [What you need](../getting-started.md#what-you-need).

## Choose a check

| Change | Run |
| --- | --- |
| Any change | `bun install --frozen-lockfile --ignore-scripts`, then `bun run check` |
| One test file | `bun test FILE` |
| Browser plugin or persistence code | `bun run test:regression` |
| UI code | `bun run test:ui`, then [`bun run test:ui:browser`](acceptance.md#built-ui-acceptance) |
| Behavior that needs a browser | `bunx lefthook run browser` |
| Release candidate | [Installed-package acceptance](acceptance.md#installed-package-acceptance) |

- `check`: build, typecheck, `check:docs` (relative Markdown links, with linkinator), and all tests that need no browser.
- After a fix, run only the browser suites that `bunx lefthook run browser` selects. `tests/browser/suites.yml` holds the file map.
- `STELZ_DRY_RUN=echo bunx lefthook run browser` prints the selected commands. Use `--file PATH` to select a path explicitly.
- Run the full archive suites once per candidate, not after each fix.

## Tests without browsers

Bun runs `tests/unit/` and `tests/integration/`. Node runs `tests/regression/`.

## Browser fixtures and cleanup

- Build before any browser suite.
- When selected suites need a source runtime, `bunx lefthook run browser` builds and prepares one in `$TMPDIR/stelz-browser-seed`. Suites clone it into disposable homes. The next run replaces it.
- When integration also selects typing or window controls, those checks reuse its browsers. They close only their fixture tabs and release control. Integration stops the browsers.
- Shared checks must preserve the existing tabs, configuration, and browser lifetimes. Typing also restores its temporary configuration changes.
- Integration alone adds neither check. Typing and window controls can still run alone with disposable browsers. Manual window-close, restart, and native stability checks remain unchanged.
- Setup and location share one packed archive per run. Both receive its explicit path. The runner checks its hash before and after each suite.
- Storage fixtures use instant typing. The typing suite still checks realistic keyboard events and pacing.
- Browser runs keep location data between runs in `$TMPDIR/stelz-seed-cache`, and setup refreshes it when it is old ([rule](../configuration/network.md#managed-location-data)).
- A suite that you run by hand prepares its own runtime.
- Suites use independent MCP SDK clients and synthetic local pages. No model credentials.
- Live checks use disposable profiles in separate service directories. They never select a saved profile. They stop their own browsers.
- Proxy and public checks need declared test proxies. See [Proxy and human acceptance](acceptance.md#proxy-and-human-acceptance) and [Public fingerprint checks](public-site-checks.md).
- Failed test state stays for inspection. Keep reports, snapshots, and proxy credentials outside Git. They can contain private data.
- Disposable test homes and reports go in the system temp directory (`$TMPDIR`). Each suite prints its report path.
- `STELZ_TEST_HOME`, when set, must identify a directory from `tests/helpers/test-home.ts`.
- Concurrency suite: a pass removes the service directory. A failure keeps it.

## Coverage boundaries

Keep browser checks together when they need the same starting state. Keep failure cases separate when they need controlled faults.

| Suite | Responsibility |
| --- | --- |
| Integration | Browser actions, screenshots, complete snapshot pagination, SDK jobs, handoff, and restart through the CLI |
| Concurrency | Multiple profiles on one connection, routing, acquisition races, stale handles, and process cleanup |
| Native | Repeated device measurements and cookie, localStorage, and IndexedDB persistence across browser lifetimes |
| Transfer | Archive round trip and native data in an imported browser |
| Typing | Actual input events, field types, mode overrides, and live defaults |
| Unit and integration without browsers | Exact boundaries, malformed inputs, controlled timeouts, and failure recovery |

- Screenshot format and pagination checks belong to integration. Concurrency does not repeat them.
- The typing threshold test also checks that bulk entry does not clear the field first. The browser suite checks long text.
- Package acceptance shares integration browsers with typing and optional window checks, as the local runner does.

## Continuous integration

- `.github/workflows/ci.yml` runs `bun run check` on Linux for pull requests, manual dispatch, and reusable workflow calls.
- A parallel job packs the archive. It runs `test:install` with scripts disabled and with native installation.
- No CI job starts a live browser.
- CI runs on Ubuntu only while GitHub macOS runners are paused. The macOS matrix entries stay commented in both workflows.
- Release workflow: see [Releasing](releasing.md).

## Diagnostics

Start the profile first. Use the same `STELZ_HOME` as the lifecycle commands.

```sh
bun run browser profile-02 profile_status
bun run browser profile-02 tools
```
