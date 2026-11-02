# Local Camoufox workers for Codex

One Codex orchestrator assigns one persistent profile to each native Codex worker. A small TypeScript MCP router acquires a profile lease, starts its headed Camofox process, and forwards the upstream browser tools. Codex chooses the actions; there is no additional agent loop, scheduler, queue, dashboard, or cloud service.

The initial limit is **two concurrent browsers**. Add profiles and adjust `maxActive` in `profiles.json` later, within machine and Codex limits. This prototype does not establish large-scale capacity.

## Setup

Requires Bun 1.3.8, Node 24, and the existing Camoufox installation.

```sh
bun install --frozen-lockfile
bun run setup
bun run configure
cp .env.example .env.local
chmod 600 .env.local
```

Setup reuses `~/Library/Caches/camoufox/Camoufox.app/Contents/MacOS/camoufox`; override `CAMOUFOX_EXECUTABLE` if necessary. It does not download a browser or alter the installed app. Node runs upstream Camofox; Bun runs custom TypeScript, compilation, MCP routing, and tests. Upstream dependencies are installed with its original npm lock.

Set `AGENT_01_PROXY_URL` and optionally `AGENT_01_EXPECTED_IP` in `.env.local`. Agent-01 refuses to start without its proxy. Agent-02 is explicitly **direct development mode**, which does not verify fixed IPs. Secrets and `.state/` are gitignored. Do not paste proxy credentials into tasks.

Stop affected profiles and reload MCP after changing network configuration.

HTTP and HTTPS proxy URLs support upstream HTTP authentication; SOCKS5 is supported without authentication. Unsupported protocols/authentication fail clearly. The configured proxy is fixed, without rotating usernames or ports. WebRTC is disabled for proxied profiles using Camoufox's supported option. Only `localhost` and `127.0.0.1` bypass the proxy for local services and the fixture. Browser-side IP checks use `https://api.ipify.org`, including before browser tool dispatch. A failed check or expected-IP mismatch blocks further browser actions without direct fallback. Codex API traffic is unaffected.

## Connect Codex desktop

Open this repository as a trusted local project, reload MCP or start a new chat, and verify `stelz_camofox` appears in `/mcp`. The configuration is project-local; global settings and approval/sandbox protections are preserved. Subagents inherit the parent's MCP servers, so the router takes an explicit profile ID and exclusive lease token. This provides cooperative operational separation, not a hostile-agent sandbox.

`bun run codex` opens the orchestrator project through `codex app`. For a separate session bound to one profile, use `bun run codex agent-01` or `agent-02`, then start a chat in that project. The installed CLI currently rejects the user's external model catalog; if the opener fails, open the corresponding folder in the existing desktop app. This project does not modify that catalog.

Example orchestrator task (run `bun run fixture` in another terminal first):

> Spawn one browser worker for agent-01 and one for agent-02. Each worker must acquire only its assigned profile. Visit http://127.0.0.1:9410/?profile=PROFILE_ID, read the current challenge, click Begin task, enter its profile ID followed by a colon and the challenge in Answer, click Check answer, and verify the confirmation. Save its profile ID as the Identity marker. Use fresh snapshots and MCP browser tools, with no website automation script. Report each outcome independently. If agent-01 lacks a proxy, report it blocked and still complete agent-02. Release each profile when finished.

Individual task for agent-01:

> In your assigned agent-01 browser, open http://127.0.0.1:9410/?profile=agent-01, read its challenge, click Begin task, type `alpha:` followed by that challenge, click Check answer, and verify the result. Use snapshots and MCP tools. Leave the window open after releasing the lease.

Individual task for agent-02:

> In your assigned agent-02 browser, open http://127.0.0.1:9410/?profile=agent-02, read its challenge, click Begin task, type `beta:` followed by that challenge, click Check answer, and verify the result. Use snapshots and MCP tools. Leave the window open after releasing the lease.

## Operation and human intervention

```sh
bun run start agent-02        # optional; workers can start their assigned profile
bun run start all             # reports agent-01 blocked until proxy is supplied
bun run status
bun run pause agent-02
bun run resume agent-02
bun run stop all
```

Pause waits for the current tool action to complete, then rejects subsequent browser actions while retaining the same browser context. Stop the active Codex turn in the desktop app as well. Sign in or interact in the controlled window manually, then run resume and tell Codex to continue from a fresh snapshot. For authentication challenges the agent must pause and request human action. Do not close the reserved IP-check tab. Shutdown checkpoints storage; do not force-quit a browser when testing persistence.

Worker release stops its browser by default. `stopBrowser=false` keeps it visible after releasing the lease. The stop command also clears the worker lease after clean shutdown, allowing reassignment. Restart never deletes profile storage.

After an unclean supervisor/server exit, replacement launch is blocked. Verify the recorded owned processes have exited before archiving that profile's `running.json`; retain its fingerprint and storage files. The prototype does not automatically recover orphan processes.

## State, fingerprints, and verification

- `.state/PROFILE/storage/` contains upstream cookie, localStorage, and IndexedDB checkpoints. This is not a complete Firefox profile: sessionStorage, service-worker caches, downloads, and all browser settings are not promised to persist.
- `.state/PROFILE/fingerprint.json` separately stores the generated configuration and matching Firefox preferences. Upstream resolves default options on each launch; the plugin restores the pinned device configuration before Firefox starts. Network-derived location is resolved separately. Corrupt pins or a changed browser binary stop launch rather than regenerate an identity.
- Generation uses the upstream's supported macOS, window-size, and screen constraints. No user-agent/GPU combination is hand-crafted. Saved configuration stability is distinct from measured browser-observable stability; neither establishes undetectability.
- `.runtime/versions.json` records the actual installed binary checksum and runtimes. Camofox is pinned to commit `39c82094013480b373df6600d44c7f036f58356e` (1.18.1); its lock pins camoufox-js 0.11.5 and Playwright Core 1.62.1. The project lock pins MCP SDK 1.30.0. Profile Manager was inspected at `6d442fd5df6c29cb52c141c2583b0a41981e2276`, but is not installed or used.
- Narrow source patches read macOS resources without writing inside the installed app and pass supported headed-window generation constraints. The plugin uses upstream lifecycle hooks and storage persistence. The router imports the upstream MCP tool definitions, request builder, and response adapter; agent-facing evaluation/cookie-import tools are omitted.

```sh
bun run typecheck
bun run test
bun run test:integration
bun run test:failures
```

Integration explicitly launches two isolated **direct-development test profiles**, exercises MCP, and checks separation and restart persistence. It writes evidence/screenshots under `.state/acceptance/`. It does not count scripted tests as natural-language agent completion, or direct exit-IP observations as supplied-proxy verification. See `TEST_REPORT.md` for actual results and remaining manual steps.

If testing from a sandboxed Codex shell on macOS, native headed launches may require approval to run outside that shell sandbox. MCP tools normally run in their configured local server process; this project does not disable Codex protections.

Optional Google Drive test: manually sign in, then ask the worker to find a file and report its name. Do not move, delete, share, or modify real files.
