# Local test report — 2026-11-02

Tested on macOS 26.5.2 arm64, Bun 1.3.8, Node 24.14.0, and the preinstalled Camoufox 152.0.4 beta.30. Browser binary SHA-256: `e468f25acba5085624da4d1ac809fd5679fa281ed2b0265f82efe63904900b33`.

| Check | Result | Evidence / limitation |
| --- | --- | --- |
| TypeScript and unit checks | Passed | `bun run typecheck`; six unit tests, including proxy validation, encoding, and action serialization. |
| A. Concurrent headed browsers | Passed in explicit development mode | `test-01` and `test-02` used separate Camofox server/browser processes, ports 9471/9472, storage and fingerprints. Both were controlled through MCP. |
| B. Two natural-language Codex workers | Passed through MCP diagnostic bridge | Two native Codex subagents independently read random challenges, clicked, typed, checked confirmation, saved their own identity markers, and released cleanly. No task-specific automation scripts. Confirmations: `alpha:581166ab` and `Verified: beta:f03740c1`. |
| C. Storage separation and restart | Passed | Distinct same-origin cookie/localStorage/IndexedDB markers survived clean shutdown and restart. The fixture itself needs cookie/localStorage only; IndexedDB was additionally tested for future authentication workflows. |
| D. Fingerprint persistence | Saved configurations passed; observable canvas variation found | Different saved configurations remained byte-identical across restart. User agent, platform, cores, languages, timezone, screen/window metrics, WebGL and sampled audio hash stayed stable. Canvas hashes changed for both profiles despite pinned configuration; do not claim stable canvas output or undetectability. |
| E. Failure handling | Passed | An actual browser with proxy `http://127.0.0.1:9` failed with `NS_ERROR_PROXY_CONNECTION_REFUSED`; no direct launch was recorded. A separately configured wrong expected exit IP rejected acquisition. Both shut down cleanly. |
| E. Supplied proxies and fixed IPs across restart | Unverified | No proxy URL supplied. Both successful acceptance identities were explicitly direct and observed the same exit IP. Agent-01 remains configured to require your proxy; agent-02 is direct as requested. HTTP(S) authentication and SOCKS5 have not been tested against your provider. |
| F. Pause/resume mechanics | Passed | Paused MCP actions were rejected; resume retained the same context and permitted fresh observation. |
| F. Actual human takeover | Unverified | A human must click/interact or sign in in that same window, then allow the agent to continue. No human action was simulated and counted as manual acceptance. |
| Desktop project MCP / custom worker discovery | Unverified after reload | Generated TOML parses successfully. Actual native subagent tests used the generic stdio MCP client because this chat cannot hot-reload new MCP configuration. Open/reload the desktop project and check `/mcp`. |

Machine-readable evidence and screenshots are kept out of Git:

- `.state/acceptance/report.json`: automated browser/storage/fingerprint observations before and after restart. Its B/F entries describe what that scripted harness alone does not verify.
- `.state/acceptance/agent-demo.json` and `artifacts/`: actual Codex worker results and observed screenshots.
- `.state/failure-acceptance/report.json`: proxy/mismatched-IP rejection evidence.
- `.runtime/versions.json`: pinned source, dependency and installed binary information.

Earlier development runs exposed the external macOS resource-path write, a window/input issue, and orphan cleanup of the IP probe. The final implementation reads existing app resources, constrains fingerprint generation with supported options, and keeps the probe on an upstream page lease. Failed window-test artifacts were archived under `.state/acceptance-*-failure/`; initial unused agent-02 development state was archived before the window-generation constraints were selected.

Known limits: only two concurrent profiles have been tested; capacity depends on hardware and Codex limits. Storage snapshots are not complete Firefox profiles, and unclean process recovery requires operator verification. Pinned upstream installation reported npm audit findings (11 moderate, 3 high, 1 critical); dependency upgrades were not folded into this prototype. Services bind to loopback and use per-profile access keys.

Remaining user steps: put your proxy URL and optional expected IP in `.env.local`; reload/open the desktop project and verify `stelz_camofox`; perform one actual manual pause/interact/resume cycle. The installed standalone CLI currently rejects the existing external model catalog, so desktop folders may need to be opened directly until that separate compatibility issue is resolved.
