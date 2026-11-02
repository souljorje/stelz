# Review fixes and validation

Base: `1a6b9a4271f5a35b9e23a45c1ba299de8e29dfd8`.

## Changes

1. Replay only device fingerprint properties. Keep fresh upstream settings and apply proxy security policy last.
   Legacy saved preferences cannot override `media.peerconnection.enabled=false`.
2. Admit one browser launch and one context per service lifetime. Context destruction, close events, recovery attempts,
   and an IP check that completes after context loss cannot restore ready state.
3. Add native profile directories through the pinned upstream's launch/context boundary. New configurations use native mode.
   Existing checkpoint identities remain compatible. Switching storage formats with existing data is refused instead of silently losing logins.
4. Compare browser-observable properties before and after restart, not only the fingerprint file.
   Record canvas/audio differences separately; fail on missing observations or changes to the selected stable properties.

No agent loop, harness dependency, new service, database, or dependency upgrade is introduced.
The Profile Manager field classification is attributed in `THIRD_PARTY_NOTICES.md`.

## Checks run while preparing the pull request

- 20 source-level regression tests passed on Linux, Node.js 22.16.0.
- Strict TypeScript checking passed for the changed plugin/helpers and source-level tests using the available TypeScript 5.8.3.
- The regression tests execute the real plugin hooks with fake browser/network boundaries.
  Native-launch tests use a fake Playwright launcher. They do not establish real browser or proxy behavior.

The preparation environment had no Bun, installed Camoufox, or proxy credentials.
The complete dependency-pinned typecheck, Bun build/unit suite, native browser acceptance, archive test,
headed macOS behavior, real proxy transitions, and human/cross-harness handoff were not run here.
The previous baseline results in `tests.md` do not validate this revision.

## Validation before merge

```sh
bun install --frozen-lockfile
bun run build
bun run typecheck
bun run test
bun run test:integration
bun run test:native
bun run test:package
```

`test:regression` can also run alone without Bun or browser dependencies, using Node with TypeScript transform support.
`test:integration` keeps the checkpoint-mode acceptance coverage.
`test:native` starts two native identities in a new `.state/native-acceptance-*` directory, uses independent MCP SDK clients,
and checks cookies, localStorage, IndexedDB, native profile files, and browser-observable identity across restart.
It records the actual samples in that directory's `report.json`. It uses explicit direct-development mode, not proxies.

Before relying on a fixed IP, run a real direct-to-proxy transition on a disposable identity and verify WebRTC is disabled,
check the browser exit address, and test proxy failure without a direct fallback. No account login is needed for that test.

Existing identities are not migrated automatically. Keep checkpoint mode until a separately validated migration is available.
Browser-version migration and process-birth-identity hardening remain separate work.
