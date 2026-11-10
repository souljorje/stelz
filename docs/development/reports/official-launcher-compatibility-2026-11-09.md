# Official launcher Phase 2 compatibility

Phase 2 is **BLOCKED**. The saved-direct current launcher did not establish a valid native control. Sol/high found no further actionable issue in the measured evidence. This is neither PASS nor NO-GO. Production retains `camoufox-js`; no production dependency or profile changed.

## Inputs

The experiment used an isolated copy of delivery commit `6ef998c3bc817ee8c7cd7edef37a5469a1c776a7`, tree `1bb61b6b7008f7438d9f5b689e2370d75a2de734`, and a private prototype adapter. The setup report records hashes of the adapter, service scripts, copied fixture, and built files. Its `source.tar` contains the committed source. Evidence is under root `.state/official-launcher-migration/phase2/runs/service-setup-jzoz1z/run/`. The private `.state/official-launcher-migration/phase2/closeout-inputs.txt` lists sources for a later hash snapshot. That snapshot does not prove the as-run identity of helpers absent from the setup report.

The host was macOS 26.5.2 on arm64, with Bun 1.4.4, Node 24.14.0, and Playwright 1.62.1. The current launcher was `camoufox-js` 0.13.0. The candidate was official TypeScript `camoufox` 0.5.8. Python 3.12 package metadata was recorded, but Python launcher execution was NOT_RUN. See the [Phase 0 baseline](official-launcher-baseline-2026-11-07.md) for provenance and version limits.

| Input | SHA-256 |
|---|---|
| Firefox 152.0.4-beta.30 executable | `e468f25acba5085624da4d1ac809fd5679fa281ed2b0265f82efe63904900b33` |
| Official 0.5.8 package archive | `a8937259028d91b2e75704846cd697890997193915211b5b8e59d4f2b08fbc41` |
| `model-2/2026` archive | `6530b8322cdaa4ec042921c8d9a0369a0e6e0269ba636c01a7203e4a2f109936` |
| Saved-direct fixture | `970c0abc688776dadd2283eb90525a82482a8e20688f138d806486c99a4e63ef` |
| Delivery lock | `345d58fae17e45a5f887399161f9c7a45e65e0c1899ae230a76f553a728ffa65` |
| Private lock | `6d9414a80b3e7c63b4f39b2808b0165318f5372759989f0e188dd9c7791ebaeb` |
| Private service adapter | `91341cb324de49cc3f2593a5c0d09ad5e8c35e22ac52174f3a9b423e7f405251` |
| Private service runner | `eb582ae55d8b004e001e60e1dfae3a60585639e65ca4fcdfc9cc5884d361f168` |
| Private options worker | `ca1ff8aeff99bf13362116f39b4e7be7890d8c74179a8ce0b406762331b08918` |

The fixture is a private Phase 1 calibration variant. It removes only four window dimension fields from the earlier rejected candidate; the original bytes remain unchanged. It is not a production profile. See `.state/official-launcher-migration/phase1/final-phase1.json`.

The verified official package had 88 upstream files. The private installer metadata was checked separately. The current dependency graph matched statically across 53 nodes. The `camoufox-js` 0.13.0 lock integrity is `sha512-XVT9ErgpLaDyUKA/R/mGsDhiVtcE14TaJHELmKNZxGCCwkXBjFdyx6JG3D2KX+MwdGnfKGWE96otSO3FfVh44w==`. The official package declares a 156.0.1-beta.36 browser; that paired browser was not tested. A version difference alone is not an incompatibility finding.

## Observed saved-direct result

The current service blocked startup because page geometry disagreed with the privileged window and tab observation. Acquisition was rejected. A separate headed probe recorded page inner height 800 and privileged viewport height 748; it is not a measurement of the final service run. Evidence: `.state/official-launcher-migration/phase2/runs/contract-headed-xZJ3gN/result.json` and `.state/official-launcher-migration/phase2/runs/service-control-u1fzej/result.json`.

The official private adapter reached native admission with one original context and one blank startup window. Acquire, list tabs, and release passed. The saved pin remained byte-identical in both cases. The earlier privacy contradiction was corrected for this case: effective DNT `1` and GPC `true` agreed with both final and serialized preferences, page getters, and local request headers. Official added eight preferences and changed or removed none: privacy matched, other preference equivalence including storage quota remains unresolved, and paired runtime comparison is NOT_RUN. The official observation recorded 176 matching voices. Media-device enumeration remained UNRESOLVED, and six added label/group fields were unknown to the 152 engine properties.

The offline replay check reports `runtime: NOT_RUN`. That field describes the offline replay, not the official service's native admission. The current and official cases recorded `CURRENT_SCOPE_CLEAR` cleanup and `PASS_NAMED_SCOPE` noninterference. The latter covers named paths and assets only. The headed service had no extra test sandbox; Firefox's native sandbox configuration was unchanged, and activation was not measured.

## Required coverage

| Required row | Status |
|---|---|
| macOS fresh direct | NOT_RUN |
| macOS fresh proxy | NOT_RUN |
| macOS saved-valid direct | PARTIAL: current control blocked; official admission observed |
| macOS saved-valid proxy | NOT_RUN |
| macOS custom-compatible direct | NOT_RUN |
| macOS custom-compatible proxy | NOT_RUN |
| Linux package and native dependencies | NOT_RUN |
| Linux display modes | NOT_RUN |

Python/TypeScript comparison, the paired-engine run, the 500-candidate corpus and exact replay, and three lifetimes per class are NOT_RUN. Runtime range coverage is PARTIAL for the versions above. Earlier copied-source validation reported 28 Bun tests with 401 assertions and 116 Node tests passing. The two service catalogs matched each other across 18 schemas, including nine browser tools. Complete per-row tool, ownership, network, and parallel-profile contracts remain NOT_RUN.

The earlier options-only paths returned, but they do not prove browser compatibility. The `xseQVZ` privacy failure remains in its original report. The original `contract-headed-H66oz9` and `contract-headed-oJnVZN` cleanup records remain UNCONFIRMED despite later scoped recovery. Preserve those records and all failed runs.
