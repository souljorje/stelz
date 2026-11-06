# Shared MCP acceptance — 6 November 2026

## Candidate

- Source base: `cd63e812eca839d3c6e3c187774c26956147a5d3`, with uncommitted shared MCP changes.
- Frozen source manifest SHA-256: `818b6ce34b467207bcbd468b5075b3e31dae1be20d7b299c016c18dba50730f8`.
- Candidate: `stelz-0.3.0.tgz`.
- Archive SHA-256: `29985e94ad36fadbd59cab5203f47251dffdc82ab199f04f4392723fc2319b31`.
- Environment: macOS 26.5.2, arm64, Bun 1.4.4, Node 24.14.0.
- Browser: Camoufox 152.0.4, release `beta.30`.
- Browser executable SHA-256: `e468f25acba5085624da4d1ac809fd5679fa281ed2b0265f82efe63904900b33`.
- Dependencies: Camofox 1.18.1, camoufox-js 0.11.5, Playwright Core 1.62.1, MCP SDK 1.30.0.

The tests used one unchanged archive, installed in a temporary prefix.
Every browser suite used the installed CLI and disposable service data.
The native installation check exercised SQLite and Impit through the installed package and staged runtime.
Existing operator profiles were not selected.

The source snapshot includes concurrent proxy-input changes present when the candidate was frozen.
Later unrelated workspace changes do not inherit this archive's browser results.
The concurrency harness added screenshot, pagination, and close-tab coverage after packaging. These test files are outside the published archive.
After acceptance, one diagnostic message clarified the migration order: stop running profiles before setup, then start them explicitly.
The targeted protocol test checks this final wording. The frozen archive contains the earlier wording. Browser behavior did not change.

## Results

| Check | Result | Evidence |
| --- | --- | --- |
| Frozen-source `bun run check` | Passed | Build, typecheck, 682 Bun tests, and 103 Node regression tests. |
| Final-workspace `bun run check` | Passed | Build, typecheck, 687 Bun tests, and 103 Node regression tests, including the corrected migration message. |
| Isolated native installation | Passed | Package contents, links, CLI, HTTP UI, setup, SQLite queries, and Impit construction. |
| Dynamic discovery | Passed | Empty catalog, two runtime creations, and external CLI creation through one connection. Tool schemas stayed identical. |
| Routing | Passed | Swapped handles, unknown handles, foreign connections, foreign tabs, and internal overrides failed. |
| Ownership | Passed | Same-connection duplicate acquisition failed. Separate connections had exactly one acquisition winner. Releasing A preserved B. |
| Browser API | Passed | All nine tools, image responses, snapshot pagination, and all typing modes. |
| Restart and stale handles | Passed | One connection reacquired after restart. Old handles could not operate or release the replacement controller. |
| Crash and lifecycle races | Passed | Real client crash retained admitted work. Deterministic tests covered cancellation, disconnect, release, pause, resume, and handoff races. |
| Native persistence | Passed | Cookies, localStorage, IndexedDB, saved fingerprint settings, and native markers survived explicit restarts. |
| Window controls | Passed | Two headed profiles, window titles, selected-window activation, retained control, and stale-instance rejection. |
| Profile transfer | Passed | Native batch copies retained storage and fingerprints, with fresh access keys. |
| Proxy isolation | Passed | Two distinct US exits matched their pins across three lifetimes. WebRTC stayed disabled for proxied profiles. |
| Proxy failure | Passed | Interrupting either relay blocked that profile without direct fallback. The other profile remained operational. |
| Human takeover | Passed | The operator clicked the confirmation button while paused. Resume retained that action in the same browser and tab. |
| Real-agent TodoMVC task | Passed | 42 MCP calls in a fresh workspace. The agent created the second profile after work in the first profile. |
| Real-agent handoff | Passed | Two fresh Codex chats made 23 MCP calls. They used the same browser instances and tabs, changed only the work list, and released both controllers. |

The proxy region check independently confirmed both pinned exits as US addresses on 6 November 2026.
Credentials and handles are absent from this report.

## Observable fingerprint limits

Both native profiles completed three browser lifetimes.
User agent, platform, hardware concurrency, languages, timezone, screen, window dimensions, webdriver, WebGL, WebGL2, and audio remained stable.
Canvas output varied between lifetimes. Saved fingerprint files and native profile markers remained unchanged.
This result does not establish identical rendering output across restarts.

## Evidence and limits

Private evidence is under `.state/shared-mcp-acceptance/`:

- `source.json`: frozen file hashes and source base.
- `candidate-check.log`: checks against the frozen source.
- `final-check.log`: checks against the final workspace, including concurrent changes.
- `installation.json`: installed candidate and archive identity.
- `headed.json`: exit status for all eight headed suites.
- `concurrency.log`, `integration.log`, `native.log`, `transfer.log`, `typing.log`, `windows.log`, `proxy.log`, and `manual.log`.
- `proxy-regions.json`: current region checks without credentials.
- `agent.json` and redacted agent event logs: separate-workspace harness evidence.
- `agent-handoff-retry.json` and `agent-verification.json`: completed handoff and cross-chat instance, tab, and release checks.

The installed Codex CLI initially rejected its desktop model catalog and response transport settings before any Stelz action.
A temporary catalog copy supplied the missing CLI fields and selected the standard response transport.
The test used per-invocation overrides. Its registration and temporary catalog path did not appear in the global configuration.
The global configuration hash changed during this session. Its model, approval policy, reviewer, sandbox mode, and MCP server names matched the initial observation.
Authentication-file bytes remained unchanged.

The initial handoff agent attempted unnecessary profile creation and startup.
Automatic approval review rejected those calls. The retry passed with explicit acquisition-only instructions and the same approval protections.
The test setup explicitly restarted the disposable profiles before this retry.
The two retry chats shared those browser lifetimes and tabs. They did not create or start profiles.
The recipient completed one work item and verified that the personal list retained its original state.

Linux and Windows headed acceptance, Claude Code, and Hermes handoff remain unexecuted for this candidate.
SDK checks alone do not establish real-agent or human behavior.
This local candidate does not replace the CI archive required for publication.
