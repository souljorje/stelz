---
title: "Testing"
description: "Routine checks, tests without browsers, fixtures and cleanup, CI, and diagnostics. Read it to choose the command for a change."
tags: [development, testing]
sources: []
created: 2026-11-06T13:49:16Z
modified: 2026-11-11T14:13:54Z
---

# Testing

Routine checks need no browser. For suites that need a browser, an archive, a proxy, a person, or an agent, see [Acceptance](acceptance.md).
Run commands from the repository root. Use the pinned Bun version in `package.json` and Node.js 24 or later. See [Runtime requirements](../getting-started.md#what-you-need).

## Choose a check

| Change | Run |
| --- | --- |
| Any change | `bun install --frozen-lockfile --ignore-scripts`, then `bun run check` |
| One test file | `bun test FILE` |
| Browser plugin or persistence code | `bun run test:regression` |
| UI code | `bun run test:ui`, then [`bun run test:ui:browser`](acceptance.md#built-ui-acceptance) |
| Behavior that needs a browser | `bunx lefthook run browser` |
| Release candidate | [Installed-package acceptance](acceptance.md#installed-package-acceptance) |

`check` builds the package, checks TypeScript, runs all tests that need no browser, and checks Markdown links in the packaged documentation.
After a fix, run only the browser suites that `bunx lefthook run browser` selects. The `lefthook.yml` file holds the file map.
Run the full archive suites once per candidate, not after each fix.

## Tests without browsers

Bun runs `tests/unit/` and `tests/integration/`. Node runs `tests/regression/`.

For shared MCP changes, check these cases:

- All 18 tool schemas, with an empty catalog and after profile creation. Fresh catalogs, direct creation, unchanged reuse, and explicit start through one connection.
- Concurrent control of separate profiles and exclusive control of each profile.
- Fresh handles after acquisition, release, reconnect, restart, and forced operator handoff. Handles from another connection, profile, or browser lifetime fail.
- List and status omit handles. Release and disconnect preserve browsers and pages.
- `stelz mcp` rejects arguments. Profile-import `--profile` selectors stay valid.

## Browser fixtures and cleanup

Build before you run a browser suite. Browser suites use independent MCP SDK clients and synthetic local pages. They need no model credentials.
Live checks create disposable profiles in separate service directories and never select a saved profile. They stop their own browsers.
Proxy and public checks need declared test proxies. See [Proxy and human acceptance](acceptance.md#proxy-and-human-acceptance) and [Public fingerprint checks](acceptance.md#public-fingerprint-checks).

Each suite writes `report.json` to a fresh directory under `.state/`: `standalone-acceptance-*` (integration), `native-acceptance-*`, `profile-windows-*`, `window-close-*`, `typing-acceptance-*`, or `manual-acceptance-*`.
Integration uses `STELZ_TEST_HOME` when set. The value must identify a directory from `tests/helpers/test-home.ts`.
Concurrency writes `.state/concurrency-acceptance/report.json`. A pass removes its service directory. A failure keeps it.
The package suite writes `.state/package-test/report.json`.
Keep failed test state for inspection. Keep reports, snapshots, and proxy credentials outside Git, because they can contain private data.

## Continuous integration

`.github/workflows/ci.yml` runs `bun run check` on Linux for pull requests, manual dispatch, and reusable workflow calls.
A parallel job packs the archive and runs `test:install` with scripts disabled and with native installation. No CI job starts a live browser.
See [Releasing](releasing.md) for the release workflow.

## Diagnostics

Start the profile, then run the development diagnostic client from source. Use the same `STELZ_HOME` as the lifecycle commands.

```sh
bun run browser profile-02 profile_status
bun run browser profile-02 tools
```
