# Official launcher Phase 0 baseline

## Status

Phase 0 is PASS. The metadata validator, independent Sol/high review, and orchestrator semantic gate passed. Gate evidence: `.state/official-launcher-migration/phase0/phase0doc-validation.json`. All Phase 2 compatibility rows are NOT RUN. No production profile launched, no browser or model downloaded, and no production source, dependency, lockfile, or profile changed.

The original baseline artifact remains immutable. This report records later documentation corrections and later-phase checks.

Evidence: `.state/official-launcher-migration/phase0/baseline-evidence.json`, SHA-256 `e609accd9f5a00dd618389c0452a18e7be94fddbd5ddcf7e06bcb476eb546912`.

## Repository baseline

Clean `main` at `0be8d860bd013a45c0a7a5a420f007f017800b7e`. The baseline evidence does not record the `origin/main` ref. Stelz is 0.4.0. Camofox is 1.18.1. The production launcher is `camoufox-js` 0.13.0 with `playwright-core` 1.62.1. MCP SDK is 1.30.0.

The host is macOS 26.5.2 build 25F84 on arm64. Bun is 1.4.4. PATH Node is 24.14.0. The installed runtime metadata declares Node 26.13.0. The isolated verifier used Node 26.12.1. Runtime compatibility with any of these versions is not established.

| Evidence | SHA-256 |
|---|---|
| `package.json` | `6afac4966002844086679ae8e383df959e7f5817548e98c1ef11e43a743d9ddb` |
| `bun.lock` | `345d58fae17e45a5f887399161f9c7a45e65e0c1899ae230a76f553a728ffa65` |
| current Camoufox executable | `e468f25acba5085624da4d1ac809fd5679fa281ed2b0265f82efe63904900b33` |

The current executable is Firefox 152.0.4-beta.30. Its cached hash matches runtime metadata. The npm bundling and patch inventory still require Phase 3 and Phase 4 audit.

## Candidate package

The candidate is official published `camoufox` 0.5.8. The 239,370-byte tarball has SHA-256 `a8937259028d91b2e75704846cd697890997193915211b5b8e59d4f2b08fbc41`. Registry SHA-512 and SHA-1 match. npm publish and SLSA signatures verify. The certificate is from GitHub Actions in `daijro/camoufox` at `refs/tags/v0.5.8`, workflow `release.yml`, commit `ac2ce31c0e875b4009e97bc86927b5ed5dbf49d7`. Source bindings and subject digest verify.

The validator entry-type addendum `.state/official-launcher-migration/phase0/tarball-entry-verification.json` verifies 88 entries, 88 unique names, all regular files, with no links, special entries, or unsafe names. Its source listing is `raw/tarball-entry-list-verbose.txt`, SHA-256 `66670bc3e0cc84f74c5652f249817d638098d9b1f32e5d92c2017b4e766c3353`. The frozen baseline remains unchanged. The manifest requires Node `>= 22.15` and `playwright-core <1.63`. It has no `exports` field. Public entry points are `dist/index.js` and `dist/index.d.ts`, with hash `b860795f39c6d5c41b49a32370d3ce725b8a81185b2332355f527298eb2b1751` and `3f0471ea7488798ac68b6bf8d3a6679dfa4399754dcf4f14e04214abf5801b3a`.

The package manifest pins browser `156.0.1-beta.36`. Its pin manifest hash is `157152a05d48cf4d156d344b0468ea9e75046c3050d0318be32a78fd9dea574b`. The paired browser was not downloaded or hash-verified.

The package model pin is `model-2/2026`, archive size 1,564,571 bytes, archive SHA-256 `6530b8322cdaa4ec042921c8d9a0369a0e6e0269ba636c01a7203e4a2f109936`. The pin source hash is `6adc131599cbbe03800b00814f788af1837fa3656e7d34af32bc772cdb877189`. This is manifest evidence only. The model archive and contained files were not downloaded and independently verified.

## Support matrix

All rows below describe the required contract. Their Phase 2 execution status is NOT RUN.

| Platform and class | Mode | Phase 2 |
|---|---|---|
| macOS Apple Silicon, fresh direct | direct | NOT RUN |
| macOS Apple Silicon, fresh proxy | proxy with expected exit IP | NOT RUN |
| macOS Apple Silicon, saved-valid direct | direct | NOT RUN |
| macOS Apple Silicon, saved-valid proxy | proxy with expected exit IP | NOT RUN |
| macOS Apple Silicon, custom-compatible direct | absolute read-only path | NOT RUN |
| macOS Apple Silicon, custom-compatible proxy | proxy with expected exit IP | NOT RUN |
| Linux package/native-dependency installation | CI/package check only | NOT RUN |
| Linux display behavior | isolated experiment only | NOT RUN |
| Windows | unsupported | NOT APPLICABLE |

Every macOS row requires one original native context, one blank startup window, all 18 MCP and nine Camofox tool contracts, control handles, exclusive controller and queue, parallel profiles, all three typing modes (`auto`, `keyboard`, `instant`), windows, pause/resume, release, and handoff. Native verification covers at least three lifetimes per supported class. A proxied row also requires a fresh location preflight and fail-closed exit IP, timezone, locale, DNS, and WebRTC checks.

Linux package and display checks do not establish documented Linux desktop support. A fake replacement binary does not establish custom-executable support. Legacy invalid v1 pins remain rejected and are not a supported class. Historical fingerprint contradictions are fixtures.

## Preregistered tolerances

Zero tolerance applies to contract loss, duplicate browser instances or controllers, extra blank/probe windows, implicit fallback, unreported pin mutation, downloads or global-cache writes during start or repair, handle/schema changes, and any engine change.

Existing valid pin bytes must remain unchanged. The engine hash must remain the same. Under fixed conditions, core observables, schemas, controller/queue ownership, and network behavior must have zero unexplained differences. This covers OS, UA, platform, architecture, GPU and WebGL, screen and viewport geometry, DPR/depth, locale, timezone, and location result. Geometry rules remain engine- and mode-specific. There is no universal chrome-height assumption. Serialized prefs must agree with effective prefs. Runtime fields cannot become device pins.

Native canvas drawing may vary. Timing, detector score, and incidental process order are not identity fields. Variation is accepted only when it causes no contradiction and does not change a saved pin. Detector scores are secondary.

The Phase 2 corpus has at least 500 candidates. Accepted, rejected, and unresolved counts must reconcile to the total. Rejected or unresolved mandatory candidates cannot be admitted. An all-rejected corpus is not a pass. Every declared supported class must produce a usable candidate with the required controls.

No uncertain browser action is replayed. This includes direct and proxied actions, timeouts, disconnects, and unexpected exits. Blocking or interrupting an operational proxied profile must leave another operational profile Ready and usable. Correcting or rechecking the blocked profile is a separate operation.

## Gate record

| Check | Result |
|---|---|
| Phase 0 metadata validation | PASS |
| Independent Phase 0 review | PASS |
| Orchestrator semantic gate | PASS |
| Candidate runtime compatibility | NOT RUN |
| Candidate/browser execution | NOT RUN |
| Every Phase 2 matrix row | NOT RUN |

Unresolved facts are actual runtime compatibility with Node 22.15 or later and the Bun/Playwright set, paired-browser behavior, downloaded model artifact verification, patch necessity, persistent-context adapter behavior, and all execution evidence. These facts gate later phases only through their assigned evidence.
