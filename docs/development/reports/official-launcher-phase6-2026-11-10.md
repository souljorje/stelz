# Official launcher Phase 6 acceptance — 2026-11-10

Status: ACCEPTED WITH LIMITATIONS by the owner on 10 November 2026. The Phase 6 acceptance decision is closed.
Publication still requires the normal release workflow and its checks.
Scope and gates: [migration plan](../official-launcher-migration.md#phase-6-acceptance-and-delivery).

## Candidate

- Source: `866d8b6`, including the click guard correction and paced keyboard default.
- Archive: `stelz-0.4.0.tgz`.
- SHA-256: `5cbb610d41e2de0b4aad01d32371771112aff1b8e33a6dbd160e25a6147ee7a7`.
- Host: macOS 26.5.2, build 25F84, arm64. Bun 1.4.4. Camoufox 156.0.1-beta.36.
- Private evidence: `.state/official-launcher-migration/phase6/2026-11-10-866d8b6/`.

The archive remains unchanged between checks. Tests use isolated installations and disposable profiles.
The public-site runner needed one test-only correction: remove the obsolete profile `mode` field. This does not change archive bytes.

## Results

| Check | Result | Evidence and limits |
| --- | --- | --- |
| Build, typecheck, unit/integration and regression tests | PASS | 762 Bun tests and 167 Node tests. `check.log`. |
| Installed package and native dependencies | PASS | Fresh npm prefix. SQLite and Impit checks. `package-report.json`. |
| Shared MCP integration, persistence, transfer, concurrency, typing | PASS | Installed candidate. Three profiles across three native lifetimes. Separate suite reports. |
| Setup, offline reuse, interruption, update and restart | PASS | `setup-report.json`. |
| Two distinct proxy exits, isolation, recovery and mismatched pins | PASS | `proxy-report.json`. |
| Proxy location and persistence | PASS | Three fresh and six saved-profile lifetimes. `location-report.json`. |
| Cross-timezone coverage | NOT COVERED | Both supplied exits resolve to `America/Los_Angeles`. The operator requested recording this gap. |
| Actual human action while paused, then resume | PASS | The operator clicked the fixture. The browser and tab remained unchanged. `manual-report.json`. |
| Window labels, focus, page titles, controller preservation and release | PASS | Two disposable profiles. The operator kept windows visible and avoided other input. `windows-report.json`. |
| Fresh-agent onboarding and registered-tool interaction | PASS | Isolated Codex project. Actual fixture and TodoMVC actions through MCP. |
| Live handoff to a second fresh agent | PASS | Same browser lifetimes, three tabs, fixture count, and isolated TodoMVC lists. |
| Public-site checks | NOT PASSED | Web scraping passed. Rebrowser passed nine applicable probes. Playground and Pixelscan reported adverse signals. See below. |

The earlier package run also recorded `differentTimezones: false`. Its chat summary incorrectly claimed coverage of two timezones.
The accepted background-tab scroll timeout remains a known issue. This run did not trigger it.
The standalone integration report's proxy/human note is covered by the proxy and human suites in this same package run.

## Agent evidence

The fresh agent installed the candidate, prepared the runtime, created `work`, and registered one project-scoped MCP connection.
It installed the canonical skill by symlink. The operator explicitly trusted the disposable project before Codex loaded its MCP configuration.
No agent changed global harness configuration or approval protections.
The PATH Codex CLI has an unrelated model-catalog compatibility error. The BB Codex runtime loaded the registered tools successfully.
Claude's account was rate-limited, so this run uses Codex.

The first agent observed fixture count 1 before and after release/reacquisition.
In `work`, it created two todos and completed only `buy milk`. In `work-2`, it created only `second profile`.
Fresh snapshots confirmed isolation. Both profiles remained Ready with unchanged instance IDs and no controller after release.
No action errors, uncertain clicks, or authentication challenges occurred.
The second fresh agent acquired both existing profiles, observed their preserved state, and released them through the same shared registration.
Both agents used registered MCP tools. No SDK script substituted for agent interaction.
Cleanup explicitly stopped both disposable profiles and the fixture server after handoff verification.
These results cover BB's Codex integration. They do not establish Claude Code or Hermes acceptance.

## Public-site evidence

The installed candidate ran all four sites in the required order. The runner exited with code 1 and stopped its disposable profile.
Its JSON report confirms release, shutdown, unchanged browser lifetime, and no action errors.
Snapshots, screenshots, and the original reports remain in `.state/public-sites/2026-11-10T14-36-36-299Z-HMm8C3/`.
A copy is under the candidate evidence directory at `public-sites/`. The archive hash remained unchanged.

| Site | Recorded result | Evidence review |
| --- | --- | --- |
| Fingerprint Playground | INCONCLUSIVE originally, FAIL in corrected offline replay | The original reader did not recognize “You are using a VPN 🌐 (timezone mismatch)”. The saved response confirms `vpn: true` and `timezone_mismatch: true`. |
| Fingerprint web scraping | PASS | The page rendered flight routes and prices. |
| Pixelscan | FAIL | The screenshot and snapshot show “Masking detected”. Location, proxy, and bot checks still showed “Collecting Data...”. |
| Rebrowser | PASS, partial coverage | Nine applicable probes passed. Eleven probes were skipped. See the original report for applicability and untriggered-hook reasons. |

Playground assigned the exit IP to Boston with timezone `America/New_York`. Its raw browser attributes report `America/Los_Angeles`.
This is a location-source disagreement. The evidence does not establish the proxy's physical location.
Bot and browser-tampering signals reported no detection. The timeout reflects unsupported verdict wording, not an absent VPN result.
The Playground screenshot shows the lower page. The full snapshot contains the VPN row and response fields.

Pixelscan exposed no specific failed property in the captured evidence. Its masking signal cannot establish a cause by itself.
The unfinished location, proxy, and bot checks remain unresolved. No identity or detector-evasion changes were made.

## Offline investigation

The corrected reader recognizes the observed VPN wording only in the VPN result field. Unknown wording, busy results, and explanatory content remain excluded.
All 172 verdict-reader and public-runner tests passed. Typecheck passed.
Replaying all four saved snapshots changed only Playground, from INCONCLUSIVE to FAIL. The original reports remain unchanged.
`public-verdict-replay.json` records snapshot hashes and the corrected reader hash. No new browser visits or proxy requests were made.

The saved `public-location.json` explains the location decision:

| Source | Result |
| --- | --- |
| GeoIP AIO, built 4 November | Selected `America/Los_Angeles`. Data age: six days. |
| GeoLite2 City, built 6 November | Returned `America/Chicago`, no city, and a 1,000 km accuracy radius. Stelz classified this as uncorroborated. |
| Browser verification | Observed `America/Los_Angeles` and `en-US`, matching the prepared configuration. |
| Fingerprint response | Assigned Boston and `America/New_York` to the exit IP. Reported a timezone mismatch. |

The browser applied the configured timezone correctly. This evidence identifies disagreement between location sources, not a failed timezone application.
Current `strict` policy blocks conflicting or stale evidence. It permits uncorroborated evidence, so it would not block this exit.
Requiring corroboration would need a separate policy decision. Neither database nor the public detector establishes the physical location.

The Pixelscan runner ended the page check after about eight seconds when the masking signal appeared.
It did not wait for the remaining cards. This preserves the observed failure but limits diagnosis.
The saved profile passed the installed candidate's static fingerprint and engine-hash checks. That command did not launch or verify a browser.
`public-fingerprint-check.json` records these limits. The local HTTP cache contained no entry for Pixelscan's `/s/api/co` classifier response.

An [upstream report](https://github.com/daijro/camoufox/issues/729) describes masking on an older Camoufox version and Linux, including font-related classifier results.
That issue is closed and does not establish the cause on this macOS candidate. No font or canvas changes are justified by this evidence.

## Plain Python comparison

The operator authorized one additional comparison through the same proxy using unmodified Python Camoufox defaults.
Python Camoufox 0.5.8 used the same browser binary and GeoIP AIO dataset hashes as the Stelz candidate.
Launch options were only `geoip=True`, `proxy=proxy`, and `headless=False`. The default sampler selected a Windows identity.

Playground again reported a timezone mismatch, with no bot or browser-tampering detection.
Pixelscan reported San Francisco, no proxy, and no automated behavior. Its fingerprint result remained pending after 166 seconds.
The warning therefore reproduces without Stelz. The incomplete Pixelscan result cannot resolve the earlier masking cause.
The different sampled OS also prevents attribution of result differences to Stelz alone.

Evidence: `.state/python-camoufox-2026-11-10/report.md`, snapshots, screenshots, and captured JSON responses.
The browser closed after one visit to each site. No Stelz profile or configuration changed.

## Acceptance decision

On 10 November 2026, the owner explicitly accepted the remaining limitations and closed the acceptance decision.
The following items no longer block this release:

- GeoIP disagreement and the resulting Playground timezone warning. The browser applied the configured timezone correctly.
- Pixelscan masking with no established cause. The incomplete Python comparison does not resolve this finding.
- Missing cross-timezone coverage. This check remains NOT COVERED.

The background-tab scroll timeout remains an accepted limitation, as recorded in the Phase 3 result.
No failed or incomplete observation becomes a passing test through this decision. The original evidence remains unchanged.
Further detector investigation and cross-timezone testing are follow-up work, not prerequisites for this release.

Routine tests use local fixtures. Live checks require dedicated test proxies, and public checks preserve their saved profile.
The test-isolation changes passed 191 focused tests and typecheck. They did not contact real proxies or public sites.

Remaining delivery steps are push and merge, required CI, version PR review, and publication through the [release workflow](../releasing.md).
The workflow must validate the final publication archive. This decision does not claim browser acceptance of different archive bytes.

## Commands

These commands record the original run. For future runs, use the dedicated-input and persistent-home instructions in [Testing](../testing.md).

```sh
bun run check
bun test tests/unit/public-site-verdicts.test.ts tests/unit/public-sites.test.ts
bun run typecheck
bun run pack --destination .state/official-launcher-migration/phase6/2026-11-10-866d8b6/archive
PROXY_TEST_ENV=/private/path/proxies.env CAMOUFOX_EXECUTABLE=/absolute/path/camoufox \
  bun run test:package --archive /absolute/path/stelz-0.4.0.tgz --setup --proxy --manual
STELZ_TEST_CLI=/installed/stelz/dist/cli.js STELZ_TEST_SEED_HOME=/prepared/test/home \
  CAMOUFOX_EXECUTABLE=/absolute/path/camoufox bun run test:windows
PROXY_TEST_ENV=/private/path/proxies.env STELZ_TEST_CLI=/installed/stelz/dist/cli.js \
  STELZ_TEST_SEED_HOME=/prepared/test/home CAMOUFOX_EXECUTABLE=/absolute/path/camoufox \
  bun tests/qa/public-sites.ts
```

Private execution metadata records the actual paths, timestamps, and archive hash.
Public-site results describe the observed run. They do not promise future nondetection.
