# Official Camoufox launcher migration

## Authority and status

This document is the canonical contract for the approved migration. The original plan is context.
Phases 0 to 2 passed their [gates](#phase-ledger). The [Phase 2 closeout](reports/official-launcher-phase2-2026-11-09.md) records the rescope that the user approved. The [prior report](reports/official-launcher-compatibility-2026-11-09.md) preserves the earlier BLOCKED result.
`main` is not release authority. Historical reports are context only. Do not mark a command passed unless supplied evidence proves it.

## Fixed objective

Replace `camoufox-js` with the official published TypeScript `camoufox` package. Keep `@askjo/camofox-browser@1.18.1` and its service contract:

- one browser and original native context per profile, using `browser-data/`;
- one controller and one action queue per profile, with parallel profiles;
- 18 fixed MCP tools, all nine `camofox_*` tools, and opaque control handles;
- typing modes, windows, deadlines, pause/resume, release, and handoff;
- explicit start, stop, and recovery;
- proxy isolation, WebRTC restrictions, location preflight, and fail-closed network behavior;
- no replay after any uncertain browser action, including direct or proxied actions, timeouts, disconnects, or unexpected exits.

Preserve profile IDs, data paths, secret references, and saved valid pins. Do not change global harness configuration. Do not introduce Python runtime, a general framework, extra MCP controls, canvas fixes, or implicit engine migration. Stelz supports only the paired engine in the launcher's `browser-pin.json`. The owner dropped Camoufox 152 and backward compatibility with earlier Stelz versions. A profile pinned to another engine fails Start on the engine hash. Create a new profile instead. Startup never upgrades a profile.

## Execution protocol

- The orchestrator makes small edits and owns the semantic gate. Explorers map source. Workers take only independent scoped changes.
- A validator runs builds, tests, and long native runs, and reports PASS or concise failures.
- A fresh reviewer checks each diff against this plan before each commit.
- Prove behavior with the production code and the existing suites. Do not build private harnesses.
- Review code for DRY and YAGNI. Fix concrete findings. Avoid speculative work.
- No phase advances with missing required evidence. Human-authentication and real-agent checks occur only in Phase 6.

## Preregistered acceptance criteria

Every declared supported macOS class must appear in the Phase 3 matrix and produce a usable candidate under its required controls. An all-rejected corpus does not pass. A rejected or unresolved mandatory candidate must not be admitted. Keep existing valid pin bytes unchanged and use the same engine hash. Under fixed conditions, core observables, schemas, controller/queue ownership, and network behavior must have zero unexplained differences. Native canvas variation is allowed.

The declared strata are fresh direct, fresh proxy, saved-valid direct, and saved-valid proxy on the paired engine. Native verification in Phase 3 covers at least three lifetimes per supported class. Window sizes are runtime values. Startup requires the page to report the real window exactly. Native samples before and after each page read must agree; while they differ, only the geometry is read again within the same deadline.

The Phase 2 corpus has at least 500 candidates. Reconcile accepted, rejected, and unresolved counts to the total. The exact validator replay must reproduce the result. Every rejected or unresolved candidate is accounted for in the mandatory admission decision.

## Phase ledger

| Phase | Required outcome | Gate |
|---|---|---|
| 0 | Baseline, exact package evidence, support matrix, and preregistered tolerances | Metadata/provenance validator PASS. Independent Sol/high review PASS. Orchestrator PASS. Baseline report commit `f2fcac2d39f47a5eec9952d69afc57218015dc39`. Gate evidence: `.state/official-launcher-migration/phase0/phase0doc-validation.json` |
| 1 | Independent fingerprint validator and check/import/export diagnostics | PASS. Core: `a43ba2fb671946b1c08869010f90a78e2363ae63`. Evidence: `.state/official-launcher-migration/phase1/final-phase1.json` |
| 2 | Isolated candidate evidence for macOS | PASS (rescoped). Corpus 500/500 and exact replay. Native admission observed. See the [closeout](reports/official-launcher-phase2-2026-11-09.md). |
| 3 | Prepared runtime, production cutover, and service contracts | PASS. Final archive from `e57bd81`. See the [result](#phase-3-result). |
| 4 | Merged into Phase 3 | — |
| 5 | Explicit previewed fingerprint repair | Dropped. See [Phase 5](#phase-5-dropped). |
| 6 | Installed-archive and real-world acceptance | Pending |

## Phase 1: validation and readiness

Add one shared validator for new, saved, effective, and serialized identities plus derived preferences. Add a JSON CLI fingerprint check with stable diagnostic and error codes. Import and export must expose diagnostics. Safe export remains available when a fingerprint is invalid.

Validate definite contradictions and unknown mandatory checks. Block start for either. Do not reject advisory unknown fields when they remain plausible. Cover OS, UA, platform, architecture, backend GPU, WebGL preferences and renderer, screen and available screen, window and viewport geometry, pixel depth, DPR, schema, and engine hash. Use conservative rules. Phase 3 replaces the GPU and geometry rules with upstream coherence. Do not mutate existing pins.

The per-profile lifecycle owner covers the attempt. Hold the global admission lock only for a short reservation or atomic commit section. Release it before launch, probing, or network readiness work. Reacquire it before final admission and recheck the profile instance and generation. Slow work stays under per-profile lifecycle ownership and must not depend on a held global lock or create parent/child deadlock.

Stage a private candidate and ownership journal. Prevalidate the candidate and statically check effective and serialized preferences.
Launch the original native context and observe identity, WebGL effects, and network/location readiness. Commit the pin durably and atomically, then write `initialized.json`.
Reuse the existing `O_EXCL`, `fsync`, and atomic journal conventions. Clean up only owned processes on failure.
Recover before or after pin commit without implicit restart or resampling. Phase 1 does not replace the launcher.

Readiness is a controller-admission gate, not only a CLI start condition. Status and `initialized.json` must both prevent MCP acquisition until the pin commit is durable and the instance/generation recheck succeeds. The supervisor rechecks the instance and generation and commits under the admission lock.

## Phase 2: compatibility evidence

Done. The official candidate passed the corpus, exact replay, and native admission. The [closeout](reports/official-launcher-phase2-2026-11-09.md) classifies the open findings. Service-contract checks move to Phase 3, where the production code and the existing suites test them. The Python comparison is an optional, options-level diagnostic.

## Phase 3: production cutover

Phase 3 merges runtime provisioning and the production cutover into one atomic delivery on a branch.

Scope: the browser stays user-provided or explicit, and setup and launch reject an unpaired build. Setup provisions the fingerprint model and location data. Stelz keeps its own exit-IP check and location resolver. The official helpers memoize per proxy, cannot be cancelled, have no error codes, and download into the shared cache. Stelz uses the official default location source, GeoIP AIO, with the same freshness limits, and downloads it during setup.

Provision the model, location, and other explicit runtime assets under `STELZ_HOME`. Setup must be atomic and idempotent. Do not assume npm contains the browser or model. Start and MCP calls must not download or write global caches. A missing asset fails with setup guidance. Keep explicit external executables read-only and resolve their resources from the bundle.

Use this pipeline: candidate, saved device replay, runtime policy and location, preferences, effective and serialized validation, launch, observable and network verification, new pin commit, Ready. Upstream warnings do not count as validation. Runtime fields do not become device pins. Coordinates must not grant the website geolocation permission. `firefoxUserPrefs` and `CAMOU_PREFS_*` must agree. Keep the Playwright `BrowserContext`/`Browser` contract with one original context and no `launchServer` workaround.

Upstream `coherence.validate` owns device plausibility. It rejects every ANGLE renderer on macOS. The 86-pixel window-chrome rule only gives a warning: saved identities can predate it, and startup checks the real window. Stelz adds OS agreement for UA, platform, `oscpu`, and `userAgentData`. It also checks WebGL preferences, the pin schema, the engine hash, serialized equality, and runtime observations. The saved device fields overlay the launcher output after `coherence.apply`, so apply never changes a pin. Only `src/browser/camoufox.ts` imports camoufox internals. The exact version pin and its unit test protect those imports.

Remove every `camoufox-js` import, transitive dependency, prepared manifest edge, and obsolete patch. Audit staging, manifests, native dependencies, `VirtualDisplay` and `xvfbArgs`, the GeoIP path and name, the retained Camofox downloader, and every patch. Do not add implicit fallback or location-disable retry.

The validator runs `bun run check`, `test:install --archive FILE`, and `test:package --archive FILE --windows --proxy`. The package suite reruns integration, native, transfer, concurrency, typing, windows, proxy, and location against one installation. A human runs `test:window-close`. Together they must cover clean, interrupted, repeated, and offline setup; every supported macOS class across three lifetimes; one blank window and cleanup of owned processes; parallel profiles; deadlines; uncertain actions; DNS; and the supported Node, Bun, and Playwright ranges. Retest the fresh-proxy scroll timeout.

### Phase 3 result

Phase 3 passed on 10 November 2026. It uses launcher `0.5.8` and Camoufox `156.0.1-beta.36` on macOS arm64 with Bun `1.4.4`.
The final archive SHA-256 is `1df6e2b1f32d83c361eb4385ed140b92efec516380832abf653742ba72fef49a`. It was packed from `e57bd81`.

| Validation | Result |
|---|---|
| `bun run check`: 167 tests | PASS |
| `test:install` with lifecycle scripts disabled | PASS |
| `test:package --windows --proxy` on one installation: integration, native, transfer, concurrency, typing, windows, proxy, and location | PASS |
| Native strata: 3 fresh-direct and 6 saved-valid-direct lifetimes | PASS |
| Location strata with one proxy route: 3 fresh-proxy and 6 saved-valid-proxy lifetimes, with a scroll in each | PASS |
| Proxy acceptance with one route shared by two relays: relay-cut isolation, recovery, and a wrong expected IP | PASS |
| Actual window close, clean shutdown, explicit restart, and saved pin preservation | PASS |

Phase 6 must still check two distinct proxy exits and location coverage across timezones. Both need a second proxy route.

Known issue: the integration step after a crashed client sometimes times out in `camofox_scroll` (`tests/browser/integration.ts:109-115`).
The client opens a second tab, pauses and resumes, and then scrolls the original background tab. About one run in four timed out after 30 seconds. The final gate did not.
The issue predates this migration. Stelz does not replay the uncertain action. Its root cause is unknown.
These checks did not reproduce it: a hidden window, 15 background-tab rounds, the location suite, and 11 runs with protocol tracing.
Investigate it separately. Add timestamps around the bring-to-front and wheel calls of the scroll route, then repeat the integration suite until it fails.

Next, run [Phase 6 acceptance](#phase-6-acceptance-and-delivery). Phase 4 remains merged into Phase 3. This result does not approve a release.

## Phase 5: dropped

The owner removed backward compatibility with earlier Stelz versions. No saved pin needs repair or an engine upgrade, so Phase 5 is not built.
An invalid pin blocks Start. Create a new profile instead.

## Phase 6: acceptance and delivery

The validator runs `bun run check`, then one unchanged installed candidate archive in a clean consumer. A changed archive requires renewed acceptance. Check invalid pins and hash faults. Check two headed profiles through shared MCP, all 18 schemas, all nine tools, typing, ownership races, handoff, cookies/storage/IDB/preferences across three lifetimes, and duplicate starts and windows. Use a real agent in a fresh workspace with two TodoMVC profiles, creating the second in the same chat.

Run `tests/qa/public-sites.ts` and its verdict reader in final acceptance only. Visit Fingerprint Playground first, then web scraping, Pixelscan, and Rebrowser. Reorder the existing runner before execution. Do not add site-specific task automation or detector-evasion patches.

The root `.state/public-sites/2026-11-03T14-14-14-955Z-oQoH0c/report.json` records Playground, web scraping, and Rebrowser passes. Playground had a proxy warning, Rebrowser skipped 11 probes, and Pixelscan was inconclusive. The `2026-11-03T13-51-57-338Z-gyZa1G/report.json` records a separate Pixelscan pass. These signals are not a full-suite pass. The later `2026-11-03T14-47-34-732Z-fTkmqQ/report.json` records Playground high activity and an inconclusive Pixelscan.

Require live results and preserve their snapshots and reports. Separate site, traffic, and transient effects from measured identity failures. Keep incomplete observations unresolved. Results do not promise future nondetection. Native canvas variation remains allowed.

Keep profile B Ready and usable. With profile A already operational, block or interrupt A during proxy/location failure. Confirm B remains Ready and usable. Correct and recheck A as separate operations. Check proxy exit IP, DNS, WebRTC, and location fail-closed behavior. Also check that uncertain actions are never replayed.

Always test pause, an actual human action in the same window, resume, and a fresh snapshot that proves the action. Authentication is conditional. Do not require a third-party login merely to complete the test.

Check startup, window close, shutdown, and probe cleanup. Check prepared offline operation, no extra windows, and no global-cache writes. Run Linux package, native dependency, and display checks separately from headed macOS acceptance. An SDK test is not real-agent proof. Record every pass, fail, or unexecuted check with commands, environment, and hashes. A required unexecuted check blocks release.

## Commands and evidence

| Phase | Validator command or entry point | Evidence | Pass criterion |
|---|---|---|---|
| 0 | Completed Phase 0 metadata collector | `.state/official-launcher-migration/phase0/baseline-evidence.json` | [Phase 0 gate](#phase-ledger) |
| 1 | `bun run check`, existing regression/integration entry points, PLANNED fingerprint validator replay | `.state/official-launcher-migration/phase1/` | Validator matrix, JSON diagnostics, lock and readiness tests pass |
| 2 | Private candidate corpus, replay, and service prototype | `.state/official-launcher-migration/phase2/evidence/` | [Closeout](reports/official-launcher-phase2-2026-11-09.md) |
| 3 | `bun run check` and the existing real-browser suites in [Phase 3](#phase-3-production-cutover) | `.state/official-launcher-migration/phase3/` | Atomic idempotent setup, no start downloads, and full contracts pass with no `camoufox-js` edge |
| 6 | `bun run check`, existing regression/integration entries, PLANNED installed-archive acceptance entries | `.state/official-launcher-migration/phase6/` | The unchanged candidate archive passes every required check |

Each evidence directory records source commit, diff identity, relevant archive hashes, environment, commands, and pass/fail/unexecuted results. Exact commands that depend on an API may freeze before first execution. Mark those commands conditional. Do not pretend a later command was preregistered or already exists.

Use logical commits per accepted phase, a minor Changeset for pre-1.0 behavior, and the version PR for the changelog. Keep public documentation focused on setup, operation, and limits. Do not publish automatically or edit global harness configuration.

