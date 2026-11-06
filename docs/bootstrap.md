# Set up Stelz from an agent

Use this guide to connect an agent to a persistent Stelz profile.
Use the requested profile ID, or `work` by default. Stelz itself needs no agent or model credentials.

Preserve profiles, credentials, and client settings. Keep approvals, sandboxing, workspace trust, and authentication checks enabled.
Request intervention only for permissions, missing credentials, authentication, or a required client restart.
Record completed steps, absolute paths, and the next action without credentials. Resume from the first incomplete step.

## 1. Discover before installing

1. Check `uname -s` and `uname -m`. Require local `Darwin` / `arm64`.
   Otherwise stop with: `Unsupported onboarding environment: expected local macOS arm64; observed OS/ARCH.`
   For Rosetta, request a native ARM64 terminal.
2. Find `stelz`, `bun`, `node`, and `npm` on PATH. Check their versions. Require Bun ≥1.4.4 and Node.js ≥24.
3. Select an absolute `STELZ_HOME`: the existing environment value, otherwise `~/.local/share/stelz`.
   Use it for every CLI command and MCP connection, independently of the chat or project directory.
4. For an existing Stelz installation, run `stelz --help`, `stelz doctor`, and `stelz status`.
   Require `profile create` in help. Reuse compatible installations and runtime.
   Check existing profile IDs, which differ from display names.

Preserve the catalog, `secrets.env`, skill directories, and client configuration files.

## 2. Supply missing dependencies and Stelz

Reuse compatible dependencies. Install missing or outdated dependencies as follows:

- **Node:** use the existing version manager or Homebrew's `node@24`.
  Otherwise download an official macOS ARM64 archive from [Node.js](https://nodejs.org/en/download).
  Check its checksum against `SHASUMS256.txt`. Extract it into a new user-owned directory.
- **Bun:** download and inspect the [official installer](https://bun.sh/docs/installation) before running it.
  Install beside an older version instead of overwriting it.
- **Stelz:** run `CAMOFOX_SKIP_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --global stelz`.
  Replace `stelz` with a supplied release archive's absolute path when applicable.
  Request an archive if no release exists. Never install a registry staging placeholder.
  Keep npm lifecycle scripts enabled for native dependencies.
  For an unwritable prefix, select a new user-owned directory with `--prefix`.

Preserve other installations. Request permission before using `sudo` or replacing an installation.
Add the selected Bun and Node directories to this session's PATH and the MCP process's PATH.
Use the selected absolute CLI path as `STELZ_CLI` in commands and client configuration.
In commands below, replace `stelz` with that absolute path.
Resolve its symlinks to find `STELZ_PACKAGE`. An npm installation places the CLI at `<package>/dist/cli.js`.

Find Camoufox through `CAMOUFOX_EXECUTABLE` in the environment or service `secrets.env`, otherwise:
`~/Library/Caches/camoufox/Camoufox.app/Contents/MacOS/camoufox`.
Check its architecture with `file`. Setup and startup check compatibility.
Preserve existing browsers and profiles. Report incompatibility without upgrading the browser or migrating its data.

Without a compatible installation, use the bundled `camoufox-js` to download Camoufox into a new, unoccupied directory:
Keep it outside existing browser installations.

```sh
CAMOUFOX_INSTALL_DIR="/absolute/new/camoufox-directory" node "$STELZ_PACKAGE/node_modules/camoufox-js/dist/__main__.js" fetch
```

Set `CAMOUFOX_EXECUTABLE` to its absolute `Camoufox.app/Contents/MacOS/camoufox` path for setup, lifecycle commands, and MCP.
After initialization, persist only this setting in `secrets.env`. Preserve other assignments and private permissions.

## 3. Initialize and create or reuse the profile

Run `stelz init`. Then run `stelz doctor`. Init preserves existing entries and credentials.
Reuse a working runtime. If missing, run `stelz setup`, which requires all profiles to be safely stopped.
Do not stop unrelated browsers. Report a blocked runtime update as pending.

```sh
stelz profile create work --json
```

Use this command instead of editing profile JSON. New profiles use native storage, a free loopback port, and direct networking.
Existing profiles retain their settings and secret references. Omitted options preserve the route and expected IP.
Conflicting options fail without changes.

| Optional setting | Arguments |
| --- | --- |
| Require direct networking | `--direct` |
| Proxy | `--proxy-url URL` or `--proxy-env NAME` |
| Expected IP | `--expected-ip IP` or `--expected-ip-env NAME` |

Environment inputs import process variables once through the existing private-secret transaction. Future client sessions need not supply them.
Missing or empty proxy variables fail without direct fallback.
Prefer environment inputs to credentials in shell history. Keep credentials out of client configuration and reports.

JSON success goes to stdout with `ok`, `created`, `home`, and a profile summary.
Errors go to stderr as `{ "ok": false, "error": { "code": "...", "message": "..." } }`, with exit status 1.
Follow the requested recovery action without deleting state or changing identity.

Run `stelz start work`. Then run `stelz doctor work`. Repeated starts reuse the same safe lifetime.
Inspect startup failures. Ownership failures require explicit recovery after inspection. Proxy failures require corrected credentials or routing.
Run `stelz ui --open` if the user requested the management UI.

## 4. Install the canonical skill and connect the client

Link `$STELZ_PACKAGE/skills/stelz-browser` into the client's skill location below. Create missing parent directories.
Keep package `docs/` and `skills/` together for relative links. Do not copy the skill alone or create client-specific variants.
Reuse a matching symlink. Create one only if no file, directory, or dangling symlink occupies the destination.
Preserve conflicting installations for user review.

The MCP connection name below is `stelz-work`.
Reuse an entry only when its command, arguments, home, and environment match. Preserve other entries.
For conflicts, request a distinct name or explicit update.
Include `CAMOUFOX_EXECUTABLE` in MCP environment settings if it exists only in the current environment.
After registration, check the target session's actual tools. Configuration alone does not establish connectivity.

### Codex

Skill: `~/.agents/skills/stelz-browser`, or project `.agents/skills/stelz-browser`.
Inspect `codex mcp get stelz-work --json`. Add only an absent entry:

```sh
codex mcp add stelz-work --env "STELZ_HOME=$STELZ_HOME" --env "PATH=$PATH" -- "$STELZ_CLI" mcp --profile work
codex mcp get stelz-work --json
```

For project scope, merge these `mcp_servers` fields into `.codex/config.toml`. Complete normal project-trust prompts without replacing existing settings.
If tools remain absent, start a new session or restart Codex. Resume at verification.
Sources: [Codex MCP](https://developers.openai.com/codex/mcp/) and [skills](https://developers.openai.com/codex/skills/).

### Claude Code

Skill: `~/.claude/skills/stelz-browser`, or project `.claude/skills/stelz-browser`.
Inspect `claude mcp get stelz-work`. Add only an absent entry:

```sh
claude mcp add --env "STELZ_HOME=$STELZ_HOME" --env "PATH=$PATH" --transport stdio --scope user stelz-work -- "$STELZ_CLI" mcp --profile work
```

Check `/mcp` in the target session. Complete normal trust prompts. Reconnect or restart if necessary.
Sources: [Claude MCP](https://code.claude.com/docs/en/mcp) and [skills](https://code.claude.com/docs/en/skills).

### Hermes

Skill: the active Hermes profile's `skills/stelz-browser`, normally `~/.hermes/skills/stelz-browser`.
Read its configuration, normally `~/.hermes/config.yaml`. Add only an absent `mcp_servers.stelz-work` mapping:

```yaml
mcp_servers:
  stelz-work:
    command: /absolute/path/to/stelz
    args: [mcp, --profile, work]
    env:
      STELZ_HOME: /absolute/service/home
      PATH: /absolute/bun/bin:/absolute/node/bin:/usr/bin:/bin
```

Preserve other YAML settings. Run `/reload-mcp` if supported, otherwise start a new Hermes session.
Sources: [Hermes MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp) and [skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills).

## 5. Check browser control

Use the target agent's registered tools. A saved entry, `tools/list`, or separate SDK probe cannot establish end-to-end readiness.

1. Serve the packaged `examples/onboarding-fixture.html` on `127.0.0.1` with a free port, using `Bun.serve` and `Bun.file`.
2. Call `profile_status`. Then call `profile_acquire`. A busy controller requires deliberate handoff, not a new profile.
3. Call `camofox_list_tabs`. Create a tab for the local fixture.
4. Read a fresh `camofox_snapshot`. Click the returned reference for `Verify Stelz`.
5. Read another snapshot. Require `Stelz verified` and an increased persistent count.
6. Call `profile_release`. Require status `ready` with no controller.
7. Acquire again. List tabs. Inspect the same page. Require the same result. Release again.
8. Stop only the fixture server. Leave the browser and pages open.

For website authentication, pause for human action in the same window. Never automate challenges.

## 6. Report and resume

Report each state with evidence or a pending action:

| State | Required evidence |
| --- | --- |
| Installed | Dependency and Stelz versions, prepared runtime |
| Browser ready | Running profile, responding browser-control interface |
| Client configured | Canonical skill and intended MCP entry installed |
| Verified | Target agent completed the fixture interaction and release check |

Mark untested states as pending. For a required restart, give the client, profile ID, service home, and step to resume.
Resume failed runs with the same profile.

See the [acceptance report](onboarding-acceptance.md) for tested scope and interventions.
