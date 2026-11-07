# Official Camoufox launcher migration

## Authority and status

This document is the canonical contract for the approved migration. The original plan is context.
Phase 0 is PASS. The metadata validator, independent Sol/high review, and orchestrator semantic gate passed. Gate evidence: `.state/official-launcher-migration/phase0/phase0doc-validation.json`.
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

Preserve profile IDs, data paths, secret references, and saved valid pins. Do not change global harness configuration. Do not introduce Python runtime, a general framework, extra MCP controls, canvas fixes, engine migration, or support for incompatible existing engines and profile classes. An incompatible existing engine or contract profile class blocks cutover.

## Execution protocol

- Phase workers use `gpt-6.1-terra` with `max`. All validation commands use `gpt-6-luna` with `low`. Each phase has a separate review with `gpt-6.1-sol` at `high`.
- A worker fixes review findings, the validator retests, and the reviewer checks again. The orchestrator owns the semantic gate.
- Explorer may do broad discovery. Editors may make targeted edits and read diffs. They may not broaden exploration ad hoc.
- No hidden model substitution is allowed.
- No phase advances with missing required evidence. Human-authentication and real-agent checks occur only in Phase 6.

## Preregistered acceptance criteria

Every declared supported class must appear in the result matrix and produce a usable candidate under its required controls. An all-rejected corpus does not pass. A rejected or unresolved mandatory candidate must not be admitted. Keep existing valid pin bytes unchanged and use the same engine hash. Under fixed conditions, core observables, schemas, controller/queue ownership, and network behavior must have zero unexplained differences. Native canvas variation is allowed.

The declared strata are fresh direct, fresh proxy, saved-valid direct, saved-valid proxy, and custom-compatible. Native verification covers at least three lifetimes per supported class. Geometry tolerances remain engine- and mode-specific. They do not assume universal chrome geometry.

The Phase 2 corpus has at least 500 candidates. Reconcile accepted, rejected, and unresolved counts to the total. The exact validator replay must reproduce the result. Every rejected or unresolved candidate is accounted for in the mandatory admission decision.

## Phase ledger

| Phase | Required outcome | Gate |
|---|---|---|
| 0 | Baseline, exact package evidence, support matrix, and preregistered tolerances | PASS; gate evidence `.state/official-launcher-migration/phase0/phase0doc-validation.json` |
| 1 | Independent fingerprint validator and check/import/export diagnostics | PENDING |
| 2 | Isolated compatibility experiment across every supported class | PENDING. Every required row is NOT RUN |
| 3 | Prepared runtime and pinned asset provisioning | PENDING |
| 4 | Narrow adapter and production dependency cutover | PENDING |
| 5 | Explicit previewed fingerprint repair | PENDING |
| 6 | Installed-archive and real-world acceptance | PENDING |

## Phase 1: validation and readiness

Add one shared validator for new, saved, effective, and serialized identities plus derived preferences. Add a JSON CLI fingerprint check with stable diagnostic and error codes. Import and export must expose diagnostics. Safe export remains available when a fingerprint is invalid.

Validate definite contradictions and unknown mandatory checks. Block start for either. Do not reject advisory unknown fields when they remain plausible. Cover OS, UA, platform, architecture, backend GPU, WebGL preferences and renderer, screen and available screen, window and viewport geometry, pixel depth, DPR, schema, and engine hash. Use conservative rules. A macOS Direct3D mismatch is not a blanket NVIDIA ANGLE prohibition. Geometry rules are engine- and mode-specific, with no universal 86-pixel chrome height. Do not mutate existing pins.

The per-profile lifecycle owner covers the attempt. Hold the global admission lock only for a short reservation or atomic commit section. Release it before launch, probing, or network readiness work. Reacquire it before final admission and recheck the profile instance and generation. Slow work stays under per-profile lifecycle ownership and must not depend on a held global lock or create parent/child deadlock.

Stage a private candidate and ownership journal. Prevalidate the candidate, launch the original native context, observe identity and network/location readiness, commit the pin durably and atomically, then write `initialized.json`. Reuse the existing `O_EXCL`, `fsync`, and atomic journal conventions. Clean up only owned processes on failure. Recover before or after pin commit without implicit restart or resampling. Phase 1 does not replace the launcher.

Readiness is a controller-admission gate, not only a CLI start condition. Status and `initialized.json` must both prevent MCP acquisition until the pin commit is durable and the instance/generation recheck succeeds. Implementation may commit in the verified hook under the correct lock, or use startup-prepared state with a supervisor commit/ack. The architecture choice remains open.

## Phase 2: compatibility evidence

Keep production dependencies unchanged. Compare current TypeScript and official TypeScript launchers with the same executable. Compare official Python and TypeScript launchers with the same executable. Run official TypeScript with its paired executable. Do not force compatibility.

Record an outcome for every currently supported profile class. Sampling is allowed only within a class and only for stated invariants. Define tolerances before tests. Preserve pins and expected observables. Require the expected Playwright `BrowserContext`/`Browser` adapter contract with no extra Context and no `launchServer` persistent-context workaround.

Check Node, Bun, and Playwright ranges. Check probe ownership, deadlines, cleanup, and one blank window. Confirm prepared starts do not download or mutate global caches. Check explicit executable resources, agreement between `firefoxUserPrefs` and `CAMOU_PREFS_*`, GeoIP plus permission behavior, custom executable resources, and Linux display modes.

Generate at least 500 immutable private macOS candidates without launching 500 browsers. Record input, options, model, package, and candidate hashes. Record strata and accepted, rejected, and unresolved counts. Provide exact validator replay. Use a public seed only if verified. Otherwise state how the corpus reproduces. Run real-browser representatives for at least three lifetimes, covering GPU, geometry, capabilities, and location. Native canvas variation is allowed. All required matrix rows gate the phase. A block delivers Phase 1 plus this report and retains the old production launcher.

## Phase 3: runtime provisioning

Provision pinned browser, model, location, and other explicit runtime assets under `STELZ_HOME`. Setup must be atomic and idempotent. Do not assume npm contains the browser or model. Start and repair must not download or write global caches. A missing asset fails with guidance.

Preserve explicit external executable support as read-only. Audit staging, manifests, native dependencies, `VirtualDisplay`, `xvfbArgs`, GeoIP path and name, stale bundled downloaders, and every patch. Test clean installation, interruption, repetition, and offline use. Phase 3 and Phase 4 may become one atomic delivery if the evidence supports it.

## Phase 4: production cutover

Use this pipeline: candidate, saved device replay, runtime policy and location, preferences, effective and serialized validation, launch, observable and network verification, new pin commit, Ready. Upstream warnings do not count as validation. Runtime fields do not become device pins.

Remove every `camoufox-js` import, transitive dependency, prepared manifest edge, and obsolete patch. Exercise full MCP, native-context, typing, window, and network regressions. Do not add implicit fallback or location-disable retry.

## Phase 5: explicit repair

Provide `profile fingerprint check --json`, `repair --preview --json`, and `repair --apply REPAIR_ID --accept-identity-change --json`. Require an exclusively stopped profile.

The immutable preview shows exact changed bytes and profile, source, candidate, engine, runtime, generator, configuration, and policy hashes. Run a required disposable real-browser preflight before approval and bind the observed results and validity conditions. Apply rejects stale or missing evidence. The opaque ID cannot be replaced with an arbitrary path.

A user approves the exact preview for a real profile. `setup --yes`, a generic CLI flag, or orchestrator sign-off is not identity approval. Back up atomically, journal, and replace only the exact candidate. Support idempotence and crash recovery. Make no engine change. REPLACE coupled GPU, WebGL, and dependent preference fields atomically when the approved identity change requires them. Preserve cookies, storage, IDB, proxy settings, and unrelated configuration.

## Phase 6: acceptance and delivery

The validator runs `bun run check`, then one unchanged installed candidate archive in a clean consumer. A changed archive requires renewed acceptance. Check invalid pins, repair, and hash faults. Check two headed profiles through shared MCP, all 18 schemas, all nine tools, typing, ownership races, handoff, cookies/storage/IDB/preferences across three lifetimes, duplicate starts and windows, and actual human takeover and resume in the same window. Use a real agent in a fresh workspace with two TodoMVC profiles, creating the second in the same chat.

Keep profile B Ready and usable. With profile A already operational, block or interrupt A during proxy/location failure. Confirm B remains Ready and usable. Correct and recheck A as separate operations. Check proxy exit IP, DNS, WebRTC, and location fail-closed behavior. Also check that uncertain actions are never replayed.

Always test pause, an actual human action in the same window, resume, and a fresh snapshot that proves the action. Authentication is conditional. Do not require a third-party login merely to complete the test.

Check startup, window close, shutdown, and probe cleanup. Check prepared offline operation, no extra windows, and no global-cache writes. Run Linux package and display checks separately from headed macOS acceptance. An SDK test is not real-agent proof. Record every pass, fail, or unexecuted check with commands, environment, and hashes. A required unexecuted check blocks release.

## Commands and evidence

| Phase | Validator command or entry point | Evidence | Pass criterion |
|---|---|---|---|
| 0 | Completed Phase 0 metadata collector | `.state/official-launcher-migration/phase0/baseline-evidence.json` | Metadata PASS plus independent review and orchestrator gate |
| 1 | `bun run check`, existing regression/integration entry points, PLANNED fingerprint validator replay | `.state/official-launcher-migration/phase1/` | Validator matrix, JSON diagnostics, lock and readiness tests pass |
| 2 | PLANNED compatibility runner and exact validator replay | `.state/official-launcher-migration/phase2/` | Every required row and preregistered corpus criterion passes |
| 3 | PLANNED provisioning, interruption, repetition, and offline entries | `.state/official-launcher-migration/phase3/` | Atomic idempotent setup and no-start-download checks pass |
| 4 | `bun run check`, existing regression/integration entry points, PLANNED adapter and installed-consumer entries | `.state/official-launcher-migration/phase4/` | Full contracts pass with no `camoufox-js` edge |
| 5 | PLANNED repair preview, stale-preview, apply, and crash-recovery entries | `.state/official-launcher-migration/phase5/` | Exact approved bytes apply atomically without engine change |
| 6 | `bun run check`, existing regression/integration entries, PLANNED installed-archive acceptance entries | `.state/official-launcher-migration/phase6/` | The unchanged candidate archive passes every required check |

Each evidence directory records source commit, diff identity, relevant archive hashes, environment, commands, and pass/fail/unexecuted results. Exact commands that depend on an API may freeze after Phase 2 discovery and before first execution. Mark those commands conditional. Do not pretend a later command was preregistered or already exists.

Use logical commits per accepted phase, a minor Changeset for pre-1.0 behavior, and the version PR for the changelog. Keep public documentation focused on setup, operation, repair, and limits. Do not publish automatically or edit global harness configuration.

