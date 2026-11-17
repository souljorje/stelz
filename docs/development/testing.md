---
title: "Testing"
description: "Commands for routine checks, the browser suite, and CI, to read when you choose the command for a change."
tags: [development, testing]
sources: []
created: 2026-11-06T13:49:16Z
modified: 2026-11-17T08:36:53Z
---

# Testing

- Run commands from the repository root.
- Use the pinned Bun version in `package.json`. Other requirements: [What you need](../getting-started.md#what-you-need).
- Checks that need a proxy, a person, a public site, or a packed archive: see [Acceptance](acceptance.md).

## Choose a check

| Change | Run |
| --- | --- |
| Local change | `bun install --frozen-lockfile --ignore-scripts`, then `bun run check:changed` |
| Full validation | `bun run check` |
| One test file | `bun test FILE` |
| Behavior that needs a browser | `bun run test:browser` |
| Window controls | `bun run test:browser --windows` |
| UI code | [`bun run test:ui`](acceptance.md#built-ui-acceptance) |
| Browser and UI together | `bun run check:desktop` |
| Release candidate | [Installed-package acceptance](acceptance.md#installed-package-acceptance) |

- `check`: lint, typecheck, build, documentation links, and all unit tests run concurrently. Any failure fails the command.
- `check:changed`: the same checks, with affected unit tests. Each selected test file runs once.
- `lint`: pinned Oxlint with correctness checks. The policy is in `.oxlintrc.json`.
- `test`: all files in `tests/unit/`. No browser needed.
- After a fix to browser behavior, run `bun run test:browser` again.

## Affected tests

- `bun run test:changed` uses Bun's transitive import graph against `HEAD`, including staged, unstaged, and untracked files.
- For a branch, run `bun run test:changed --base origin/main`. The selector uses the merge-base.
- Set `STELZ_TEST_BASE=origin/main` with `check:changed` or `check:desktop` to use the same branch comparison.
- Source changes also run the subprocess tests declared in `scripts/test-changed.ts`. Bun cannot trace modules loaded through command arguments or copied fixtures.
- Add a dependency rule there when a test reads a new file or starts a new subprocess outside its import graph.
- Package, lockfile, configuration, shared-helper, script, unknown-path, and deletion changes run all unit tests. Renames include the old path.
- Changes to `docs/mcp.md` run its contract test. QA-script changes also run the dedicated-proxy input guard.
- A missing Git reference fails the command. Fetch the base branch before using it.

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
- Install the paired browser once with `bun run setup`, or set `CAMOUFOX_EXECUTABLE` to an existing paired build.
- Routine browser checks use the existing executable at its real path. They do not copy or install a browser.
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

- Restart and import checks compare stable device properties, including pixel ratio. Reports record changes in native window dimensions and rendered hashes.
- `--windows` adds the window controls. They need visible desktop windows. A foreground restriction gives `incomplete` and a nonzero exit code.
- Typing and window checks are parts of this suite. They do not run alone.
- Location data and the fingerprint model stay in `$TMPDIR/stelz-seed-cache`. Setup refreshes old location data ([rule](../configuration/network.md#managed-location-data)).
- The suite finds the browser in the test cache, upstream cache, or default Stelz installation. `CAMOUFOX_EXECUTABLE` overrides this selection.
- `test:desktop` builds once, then runs Camoufox and Chrome checks concurrently in separate homes.
- `test:browser:built` and `test:ui:built` require a completed build. The wrappers call them automatically.
- `check:desktop` also runs lint, typecheck, documentation links, and affected unit tests beside that build.
- Do not run the standalone `test:browser` and `test:ui` wrappers concurrently. Each wrapper replaces `dist/` during its build.
- The report gives the seconds from the start of the run for each check.
- The suite prints its report. A pass removes its test home. A failure keeps it and prints the report path.
- Keep reports, snapshots, and proxy credentials outside Git. They can contain private data.
- `STELZ_TEST_HOME`, when set, must identify a directory from `tests/helpers/test-home.ts`.

## Continuous integration

- `.github/workflows/ci.yml` fetches Git history and runs `check:changed` against the pull request's base SHA.
- Main-branch pushes, manual dispatch, and release calls run `check` with all unit tests.
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
