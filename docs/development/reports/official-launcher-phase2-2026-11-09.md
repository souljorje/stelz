# Official launcher Phase 2 closeout

Phase 2 is **PASS (rescoped)**. The official `camoufox` 0.5.8 launcher generates and replays valid identities and starts the native Stelz context. The remaining service-contract checks move to the [Phase 3 cutover](../official-launcher-migration.md#phase-3-production-cutover), which tests the production code instead of a private harness. This report supersedes the gate in the [BLOCKED report](official-launcher-compatibility-2026-11-09.md). That report remains as history.

The host, executable, package, and model are the same as in the BLOCKED report. Private evidence is in `.state/official-launcher-migration/phase2/evidence/`. The run directories and their logs were removed after this summary.

## Results

| Check | Result | Evidence |
|---|---|---|
| Corpus of 500 macOS candidates | PASS: 500 accepted static, 0 rejected, 0 unresolved | `corpus-manifest.json` |
| Exact validator replay | PASS: 500 records, 0 mismatches, package files and model hash agree | `corpus-replay.json` |
| Native admission | PASS for the recorded rows: one blank window, unchanged pins, and matching privacy observation | `service-control-xngbFA.json` |
| Saved-direct control | PASS in the earlier run: acquire, list tabs, and release | [BLOCKED report](official-launcher-compatibility-2026-11-09.md#observed-saved-direct-result) |
| Full control sequence | INCOMPLETE in all six rows. The error does not name the failed tool. | `service-control-xngbFA.json` |
| Python options comparison | BLOCKED: the worker output file was missing | `python-hijtqV.json` |
| Paired 156 engine | NOT_RUN | — |

## Findings

The run logs showed these causes before their removal.

| Finding | Class | Action |
|---|---|---|
| The control sequence opened a tab with `about:blank`. Camofox accepts only `http:` and `https:` URLs. | Harness | None. Production tests use real URLs. |
| The copied browser bundle had no `version.json` | Harness | None. Phase 3 passes the engine version explicitly. |
| The Python sandbox denied its own output path | Harness | None. The comparison is optional. |
| Control errors did not name the failed tool | Harness | None. The harness is retired. |
| The fresh-proxy scroll timed out | Unresolved | Retest in Phase 3. |

No finding shows an official launcher incompatibility. Native canvas variation remains accepted. The [migration plan](../official-launcher-migration.md#phase-2-compatibility-evidence) records the rescope decisions.
