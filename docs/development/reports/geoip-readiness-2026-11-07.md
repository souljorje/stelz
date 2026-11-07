# GeoIP readiness acceptance — 7 November 2026

Proxied profiles now require a fresh preflight and browser verification before Ready.
The UI shows local blockers before Start and retains failures after cleanup.
Setup prepares one shared database. Direct profiles retain their existing behavior.

This report covers a local candidate. It does not approve publication or establish results for another archive.

| Source or artifact | Identity |
| --- | --- |
| Base commit when packed | `973bae0c8e3d89d61ca6cad7be33cd5697b6d37c` |
| Source | Base commit plus local changes, including the existing blank-startup work and launcher upgrade |
| Source manifest | 208 files, SHA-256 `e0d0113de84f9a88bd64cd98e66f4c38e63f33c81e1f38afeda91256aa310b5c` |
| Saved archive | `/private/tmp/stelz-geoip-release-040/stelz-0.4.0.tgz` |
| Archive SHA-256 | `596e2e4e2988a80df94e0d60aa473225ca43e0ff0631f3f13911bac1d57156f4` |
| Platform | macOS 26.5.2, build 25F84, arm64 |
| Runtimes | Bun 1.4.4, Node.js 24.14.0 |
| Integration | `@askjo/camofox-browser` 1.18.1, `camoufox-js` 0.13.0, Playwright 1.62.1 |
| Database reader | MaxMind 5.0.8, mmdb-lib 3.0.3 |
| Native dependencies | Impit 0.14.8, better-sqlite3 13.0.1 |
| Browser | Camoufox 152.0.4-beta.30 |
| Browser executable SHA-256 | `e468f25acba5085624da4d1ac809fd5679fa281ed2b0265f82efe63904900b33` |

Concurrent commits advanced HEAD to `1e45751a545b72579d8e98f6641e55e3b578be43` during acceptance.
All 208 source hashes still matched after the checks. This report is outside that manifest and archive.
Local evidence is in `.state/geoip-readiness-2026-11-07/`, including `source.json`, logs, and `location-acceptance.json`.
The evidence directory is outside Git. Private proxy credentials do not appear in the report.

The implementation reuses the existing flows:

- `src/runtime/location-preflight.ts:68` uses the pinned IP helper, profile configuration rules, and admission guard. Network checks run outside global admission.
- `src/browser/location.ts` uses the actual MaxMind reader and existing deterministic country-language policy. Internal input identities invalidate stale results.
- `src/browser/geoip-setup.ts:7` extends staged setup in `src/browser/setup.ts`. It checks release integrity before atomic activation and reuses valid data offline.
- `src/browser/location-launch.ts:18` passes the checked IP and settings through the existing launcher. The Camofox patch removes the disabled-GeoIP retry and blanket geolocation permission.
- `src/browser/plugin.ts:197` uses the existing IP check and action queue. It checks the original blank page before readiness or acquisition.
- `ui/src/ProfileDetail.tsx` and `ui/src/model.ts` reuse existing actions and refresh behavior. CLI and MCP preserve structured failures.

The pinned 0.13.0 launcher already preserves an explicit GeoIP address. That behavior needed no duplicate fix.
Real browser testing found that `CAMOU_CONFIG` alone retained the host timezone with this browser build.
The existing Playwright `timezoneId` launch option fixed it before the first page. The fix does not change running sessions.

| Check | Evidence and result |
| --- | --- |
| Build, typecheck, automated tests | `bun run check` passed: 718 Bun tests and 132 Node regression tests. |
| Dataset failures | Real MaxMind reader with deterministic database fixtures. Missing, corrupt, incompatible, and incomplete data blocked UI, CLI, and MCP startup without reservation. |
| Proxy and stale-input failures | Simulated transport and services covered authentication, unreachable proxies, invalid IPs, cancellation, deadline, expected IP, changed secrets, edits, and concurrent checks. |
| Launcher failure path | Tests executed the patched Camofox preparation function and pinned IP helper. Failure did not retry with disabled GeoIP or a direct connection. |
| Browser verification failures | Simulated browser tests covered incompatible location, compatible rotation, normalized locale/timezone, failed-start cleanup, blocked acquisition, and late replies. |
| Setup safety | Fixtures covered integrity failure, offline reuse, interrupted staging, concurrent setup, and preservation of prior data and unrelated settings. |
| UI | Chrome checked the visible blocker, recovery action, unchecked state, and successful connection check without launch. Fixtures simulated lifecycle services. |
| Installed archive | Both scripts-disabled and ordinary native installation passed. Checks covered archive contents, links, CLI, HTTP UI, setup, SQLite, and Impit. |
| Real browser journey | The same archive passed setup, repeated setup, preflight, start, MCP acquisition, local navigation, stop, and restart for two proxy profiles. |

`tests/integration/location-preflight.test.ts` covers shared entry points.
`tests/unit/location-launcher.test.ts` covers the actual patched integration.
`tests/package/location.ts` reuses the package installer, proxy relay, MCP client, and blank-window assertion.

The real journey used two distinct exits and four browser lifetimes.
Both exits resolved to `America/Chicago`, while the host used `Asia/Tbilisi`.
Every browser reported timezone `America/Chicago`, Intl locale `en-US`, and navigator languages `["en-US", "en"]`.
Preflight and browser exit IPs matched for each attempt.
Geolocation remained **configured**, not browser-observed. The local page reported geolocation permission `prompt`.

Native storage markers remained separate and persisted through restart. Fingerprint files remained byte-identical.
The test stopped only its temporary acceptance profiles. Both ended in `stopped` with no process receipt.
No existing browser session required a restart or fingerprint change.

Setup acquired GeoLite2-City release `2026.11.07` at `2026-11-07T08:51:31.520Z`.
Its database build time was `2026-11-06T06:16:28.000Z`.
Its SHA-256 was `9db04e8a4441ec54183537d8774c08e42720f2243137dd42e9cc7f78ea2b927b`.
Repeated setup retained the same manifest and acquisition time.

Before Ready, the proxy relay observed only connections to `api.ipify.org` for preflight and browser verification.
Restored local pages made zero requests before Ready across all four lifetimes.
This observation does not establish complete traffic isolation. TLS contents, OS traffic, and all Firefox background traffic remain unproven.
MCP gating alone does not establish that no website traffic occurred.

Real checks with different exit timezones remain untested because both supplied routes use the same timezone.
Real mid-start proxy rotation and network failure injection remain untested. Deterministic tests cover those decisions.
Linux and Windows browser acceptance remain untested. These results do not establish compatibility on those platforms.

The documentation update used the ASD-STE100 skill for installation, proxy, troubleshooting, CLI, integration, and agent guidance.
The documentation uses its structural rules without claiming official dictionary compliance.
The change includes a minor Changeset. This work did not publish a package.
