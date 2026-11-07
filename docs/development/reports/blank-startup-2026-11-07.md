# Blank startup acceptance — 7 November 2026

Each profile starts with one native window and one blank tab. MCP can navigate that original tab.
The private browser add-on performs IP checks without opening a diagnostic page.

## Tested candidate

| Item | Value |
| --- | --- |
| Base commit | `35071effb905db1541662f5303a4faf040667283` plus the local startup changes |
| Archive | `stelz-0.3.1.tgz` |
| Archive SHA-256 | `0b0de711ef2d9a0fedc411f4ced91506e1f273a0533de000acd35db76e630286` |
| Source manifest SHA-256 | `408f2fa663d178e19b6ad5c89570d64ebc34cfeeb79b45a7892b7506c5911a6f` |
| System | macOS 26.5.2, build 25F84, arm64 |
| Runtime | Bun 1.4.4, Node.js 24.14.0 |
| Browser | Camoufox 152.0.4-beta.30, headed |
| Browser executable SHA-256 | `e468f25acba5085624da4d1ac809fd5679fa281ed2b0265f82efe63904900b33` |

The source manifest records 197 files before packaging. This report was added after testing.
The five headed suites used the same archive bytes and an isolated installation.
Tests used disposable profiles and two authenticated proxies. No operator profile or global client configuration changed.

## Results

| Check | Result |
| --- | --- |
| `bun run check` | Passed: build, typecheck, 689 Bun tests, and 127 Node regression tests. |
| Installed package | Passed: archive contents, dependency checks, CLI, HTTP UI, and runtime setup. |
| Headed integration | Passed: one blank window, usable original tab, isolated storage, handoff, disconnect, pause/resume, and explicit restart. |
| Two proxies | Passed: blank startup and rechecks, distinct stable exits across three lifetimes, WebRTC blocking, and wrong-IP rejection. |
| Proxy failures | Passed: no direct fallback, independent healthy profile, blocked actions, and recovery in the original browser. |
| Shared MCP concurrency | Passed: three native browsers and independent control through shared and separate connections. |
| Native persistence | Passed: three lifetimes, isolated native storage, saved fingerprint settings, and expected observable properties. |
| Window controls | Passed: profile labels, window inventory, focus, controller retention, stale-instance rejection, and bridge authentication. |
| Independent code review | No actionable findings in the final background probe or proxy-authentication handling. |

The native suite recorded canvas differences across restarts. This matches the previously accepted Firefox behavior.
The window-control suite explicitly creates extra task windows after startup.

## Execution notes and limits

An earlier candidate failed authenticated background requests. The fix supplies credentials only for the add-on's active probe and configured proxy.
Regression tests cover foreign challenges, website authentication, repeated challenges, and credential isolation.
Startup tests cover delayed verification, upstream reapers, concurrent page creation, and preservation of user-navigated pages.

The operator's browser cache changed during testing. The new 156.0.1 metadata failed with the pinned launcher before browser startup.
Tests used a separate copy of the previously tested 152.0.4 binary and a complete GeoIP database.
Environment retries and the interrupted proxy run do not count as passing acceptance.

Linux, Windows, actual human takeover, real-agent handoff, and the dedicated typing and profile-transfer suites were not rerun for this change.
SDK results do not establish actual human or agent behavior. This local candidate was not published.

Local evidence is under `.state/startup-acceptance/`, including the source manifest, archive, suite logs, and `headed.json`.
The full automated check log is `.state/startup-full-check.log`. These paths are excluded from Git.
Apply the change through the normal [runtime update procedure](../camofox-integration.md#apply-a-package-or-source-update).
