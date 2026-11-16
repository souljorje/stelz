---
"stelz": minor
---

Add `stelz/sdk`, a script SDK for Bun. A script calls `start(profileId)` to start a browser, and `acquire(profileId, work)` to control a running profile. `acquire` never starts a browser and always releases control, and the browser and its tabs stay open.

- `work` receives a `Browser` with `tabs()`, `page(tabId)`, `open(url)`, `pause()`, `resume()`, and `captureFailure(directory)`. A `Page` has `navigate`, `click`, `type`, `select`, `press`, `scroll`, `snapshot`, `expectElement`, `expectText`, and `evaluate`.
- The SDK calls the same code as the MCP tools, with the same names, rules, and role-and-name targets. It does not start a child `stelz mcp` process.
- A script runs with Bun, on the machine of the service. Select the service directory with `STELZ_HOME`.
- The SDK installs no signal handlers. The next `acquire` takes over from a script that died.

The `package.json` file now has an `exports` field. It exports `stelz/sdk` only. See [Script SDK](https://github.com/souljorje/stelz/blob/main/docs/sdk.md).
