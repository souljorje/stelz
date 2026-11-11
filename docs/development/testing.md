---
title: "Testing"
description: "Commands for routine checks, fixtures, CI, and diagnostics, to read when you choose the command for a change."
tags: [development, testing]
sources: []
created: 2026-11-06T13:49:16Z
modified: 2026-11-11T14:55:54Z
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

- `check` builds the package, checks TypeScript, runs all tests that need no browser, and checks Markdown links in the packaged documentation.
- After a fix, run only the browser suites that `bunx lefthook run browser` selects. `lefthook.yml` holds the file map.
- Run the full archive suites once per candidate, not after each fix.

## Tests without browsers

Bun runs `tests/unit/` and `tests/integration/`. Node runs `tests/regression/`.

## Browser fixtures and cleanup

- Build before any browser suite.
- Suites use independent MCP SDK clients and synthetic local pages. No model credentials.
- Live checks use disposable profiles in separate service directories. They never select a saved profile. They stop their own browsers.
- Proxy and public checks need declared test proxies. See [Proxy and human acceptance](acceptance.md#proxy-and-human-acceptance) and [Public fingerprint checks](public-site-checks.md).
- Failed test state stays for inspection. Keep reports, snapshots, and proxy credentials outside Git. They can contain private data.

| Suite | Report |
| --- | --- |
| Integration | `.state/standalone-acceptance-*/report.json`. `STELZ_TEST_HOME`, when set, must identify a directory from `tests/helpers/test-home.ts`. |
| Native measurements | `.state/native-acceptance-*/report.json` |
| Concurrency | `.state/concurrency-acceptance/report.json`. A pass removes the service directory. A failure keeps it. |
| Profile windows | `.state/profile-windows-*/report.json` |
| Window close | `.state/window-close-*/report.json` |
| Typing | `.state/typing-acceptance-*/report.json` |
| Human takeover | `.state/manual-acceptance-*/report.json` |
| Package | `.state/package-test/report.json` |

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
