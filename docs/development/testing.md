---
title: "Testing"
description: "Commands for routine checks, the browser suite, and CI, to read when you choose the command for a change."
tags: [development, testing]
sources: []
created: 2026-11-06T13:49:16Z
modified: 2026-11-18T08:35:49Z
---

# Testing

- Run commands from the repository root.
- Use the pinned Bun version in `package.json`. Other requirements: [What you need](../getting-started.md#what-you-need).
- Checks that need a proxy, a person, a public site, or a packed archive: see [Acceptance](acceptance.md).

## Choose a check

| Change | Run |
| --- | --- |
| Any change | `bun install --frozen-lockfile --ignore-scripts`, then `bun run check` |
| One test file | `bun test FILE` |
| Behavior that needs a browser | `bun run test:browser` |
| Window controls | `bun run test:browser --windows` |
| UI code | [`bun run test:ui`](acceptance.md#built-ui-acceptance) |
| Release candidate | [Installed-package acceptance](acceptance.md#installed-package-acceptance) |

- `check`: lint, typecheck, build, documentation links, and all unit tests run concurrently. Any failure fails the command.
- `lint`: pinned Oxlint with correctness checks. The policy is in `.oxlintrc.json`.
- `test`: all files in `tests/unit/`. No browser needed.
- After a fix to browser behavior, run `bun run test:browser` again.

## Layout

| Directory | Contents |
| --- | --- |
| `tests/unit/` | All tests that need no browser: functions, in-process services, and CLI subprocesses |
| `tests/browser/` | `smoke.ts`, the one Camoufox suite, with its typing and window parts. `ui.ts`, the built UI in Chrome. |
| `tests/qa/` | Checks that run only on explicit command. See [Acceptance](acceptance.md). |
| `tests/helpers/` | Fixtures, test homes, and MCP clients |

- One behavior has one test. Put it at the cheapest level that proves it: a function, then an in-process service, then a CLI subprocess, then the browser suite.
- Bun runs all of `tests/unit/`.
- Use `test.each` rows for the boundary cases of one rule.

## Browser suite

- `bun run test:browser` builds, then runs `tests/browser/smoke.ts`.
- It needs desktop access and the paired Camoufox build. See [Browser executable](../configuration/environment.md#browser-executable).
- Browser checks use one installed paired browser at its real path. They do not copy it into each test home.
- The suite takes the first paired build of: `CAMOUFOX_EXECUTABLE`, the default Stelz installation, the upstream cache, and its own cache in `$TMPDIR/stelz-seed-cache`.
- With none, it downloads the paired build (over 1 GB) into its own cache once. It never changes the default installation.
- Setup prepares the current plugin and dependencies in the disposable home. Missing or stale location data can require GitHub access.
- It uses independent MCP SDK clients and direct profiles in one disposable home. No model credentials.
- All checks use one local page, `tests/helpers/fixture.ts`. Action checks reuse one work tab. Typing runs concurrently in a separate profile's startup tab.

One run does these checks in the same browsers:

| Area | Checks |
| --- | --- |
| Lifecycle | MCP creates and starts a profile. Startup opens one blank window. Stop leaves a receipt and no server or browser process. |
| Actions | Click, type, scroll, wait, screenshots, targets, snapshot shapes, diffs, and complete pagination |
| Control | One controller, handle routing, an acquisition race, handoff, disconnect, a crashed client, pause, and resume |
| Persistence | Cookie, localStorage, IndexedDB, saved fingerprint, and device observations across a restart |
| Transfer | Export of a stopped profile, import as a stopped copy, and the same storage and fingerprint in the copy |
| SDK | One job from `tests/browser/sdk-job.ts` |
| Typing | Field types, bulk entry of long text, a mode override, and live defaults. Keyboard mode types real key events for more than 10 seconds, the budget of balanced mode. |

- A restart must keep the device properties that a page can read, with the inner and outer window size.
- An imported copy opens another window, so only the pixel ratio of its window must match.
- `--windows` adds the window controls. They need visible desktop windows. A foreground restriction gives `incomplete` and a nonzero exit code.
- Typing and window checks are parts of this suite. They do not run alone.
- Location data and the fingerprint model stay in `$TMPDIR/stelz-seed-cache`. Setup refreshes old location data ([rule](../configuration/network.md#managed-location-data)).
- Do not run `test:browser` and `test:ui` at the same time. Each one replaces `dist/` during its build, and both create profiles in the default port range.
- The report gives the seconds from the start of the run for each check.
- The suite prints its report. A pass removes its test home. A failure keeps it and prints the report path.
- Keep reports, snapshots, and proxy credentials outside Git. They can contain private data.
- `STELZ_TEST_HOME`, when set, must identify a directory from `tests/helpers/test-home.ts`.

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
