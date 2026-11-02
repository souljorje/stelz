# Test results

Tests use macOS 26.5.2 on Apple Silicon, Bun 1.3.8, and Node.js 24.14.0.
The existing browser is Camoufox 152.0.4 beta.30.
The package pins Camofox to npm version 1.18.1. The service records the browser checksum in `runtime/versions.json`.

| Check | Result |
| --- | --- |
| TypeScript checks | Passed. |
| Controller and proxy unit tests | Ten tests passed. |
| Two independent browsers | Passed through standard MCP. Both test identities explicitly used direct development mode. |
| Bound identity and exclusive control | Passed. A second controller failed acquisition while the first controller held access. |
| Deliberate handoff | Passed. The browser lifetime, original tab, visible storage, and fingerprint file remained unchanged. |
| Client disconnect and reconnect | Passed. The service kept the original browser open. |
| Client crash during an action | Passed. The service kept the action lock until the action finished. The next controller retained the browser. |
| Explicit browser restart | Passed. Separate cookie, localStorage, and IndexedDB markers survived. Saved fingerprints remained unchanged. |
| Global archive installation | Passed in an isolated npm prefix and an empty working directory. |
| Runtime independence | Passed without Codex, Claude Code, or Hermes commands in PATH. The test supplied no LLM credentials. |
| Project environment independence | Passed. A project `.env` file could not select a different service directory. |
| Handoff between two agent harnesses | Unverified. See the client limits below. |
| Supplied fixed-IP proxies | Unverified. The test had no proxy credentials. |
| Actual human takeover | Unverified. Pause and resume passed without a simulated human action. |

## Evidence

Run the checks from the development checkout:

```sh
bun run build
bun run typecheck
bun run test
bun run test:integration
bun run test:package
```

`test:integration` uses independent MCP SDK clients. It does not require a harness or a model.
`test:package` installs the npm archive globally into a temporary prefix. It runs browser checks against that installed package.
The package test excludes source files, tests, harness directories, and saved browser state from the archive.
It checks that runtime dependency links do not refer to the source checkout.

The development reports are `.state/standalone-acceptance/report.json` and `.state/package-test/report.json`.
The package report records the temporary install, working directory, service directory, and browser checks.

## Client limits

The installed Codex CLI rejects its existing external model catalog. Its version is 0.142.4.
Claude Code is not installed. The Hermes CLI is available.
No test claimed a live handoff between two ready agent harnesses. The standard MCP handoff test passed independently.
The connection examples follow each client's official configuration documentation.

## Browser limits

The service preserves a generated fingerprint configuration. It does not promise stable output for every observable signal.
Earlier restart tests found different canvas hashes despite unchanged saved configuration.
Storage checkpoints do not preserve the complete Firefox profile.
No test establishes that websites cannot detect automation.

## Package availability

The global package archive is `stelz-0.2.0.tgz`. npm publication remains a separate release step.
No test requires a repository clone to run the installed service.
