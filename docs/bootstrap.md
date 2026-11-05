# Set up Stelz from an agent

Give a local coding agent this prompt:

> Read https://github.com/souljorje/stelz/blob/main/docs/bootstrap.md. Set up Stelz, create or reuse the persistent profile `work`, and connect it to your browser tools. Preserve existing state and settings. Report each readiness state.

This procedure supports local macOS on Apple Silicon. Stelz runs without an agent or model credentials.
Complete the steps you can perform. Request intervention only for permissions, missing credentials, human authentication, or a required client restart.
Do not disable approvals, sandboxing, workspace trust, or authentication checks.

## 1. Discover before installing

Read this document before making changes. Keep a short checkpoint of completed steps, absolute paths, and the next required action.
Never include credentials in that checkpoint.

Check `uname -s` and `uname -m`. Require `Darwin` and `arm64`.
For another result, stop with: `Unsupported onboarding environment: expected local macOS arm64; observed OS/ARCH.`
If the shell runs through Rosetta, request a native ARM64 terminal. Do not attempt a different platform's installation.

Find `stelz`, `bun`, `node`, and `npm` on PATH. Check their versions.
Stelz requires Bun 1.4.4 or later and Node.js 24 or later.
Select one absolute `STELZ_HOME`, using the existing environment value or `~/.local/share/stelz`.
Keep that value for every CLI command and MCP connection. Do not infer it from the chat or project directory.

If Stelz exists, run `stelz --help`, `stelz doctor`, and `stelz status`.
Check that help lists `profile create`. Reuse a working installation and compatible runtime.
Inspect existing profile IDs before creating one. A display name is not an ID.
Do not replace an existing catalog, `secrets.env`, skill directory, or client configuration file.

## 2. Supply missing dependencies and Stelz

Reuse compatible dependencies. Do not upgrade or replace a browser that holds existing profile data.

- If Node is missing or older than version 24, use the existing Node version manager or Homebrew's `node@24` package.
  If neither is available, install an official macOS ARM64 archive from [Node.js downloads](https://nodejs.org/en/download).
  Verify its checksum against the release's `SHASUMS256.txt` and extract it into a new user-owned directory.
  Add its `bin` directory to this session's PATH. Preserve other Node installations.
- If Bun is missing, use the [official Bun installer](https://bun.sh/docs/installation).
  Download and inspect the installer before running it. Add its `bin` directory to this session's PATH.
  If an older Bun is present, install the required version in a separate directory instead of overwriting it.
- Install Stelz with `CAMOFOX_SKIP_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --global stelz`.
  For development, replace `stelz` with the supplied release archive's absolute path.
  Do not use a registry staging placeholder as a release. If no release is available, request a release archive.
  Keep npm lifecycle scripts enabled: native dependencies can need them.
  If the global prefix is not writable, use `--prefix` with a new user-owned directory and its absolute CLI path.
  Do not use `sudo` or replace an existing installation without the necessary permission.

Record the selected executable as `STELZ_CLI`. Resolve symlinks to locate its package directory, `STELZ_PACKAGE`.
For npm installations, the resolved CLI is `<package>/dist/cli.js`.
Use the selected absolute executable in place of `stelz` in every command below.
Use absolute paths in client configuration. Include the selected Bun and Node directories in the MCP process's PATH.

Find Camoufox in the existing `CAMOUFOX_EXECUTABLE` setting or the default path:
`~/Library/Caches/camoufox/Camoufox.app/Contents/MacOS/camoufox`.
Use `file` to check the executable's architecture. Setup and browser startup provide the final compatibility check.

If no compatible installation exists, use the `camoufox-js` version bundled with the selected Stelz package:

```sh
CAMOUFOX_INSTALL_DIR="/absolute/new/camoufox-directory" node "$STELZ_PACKAGE/node_modules/camoufox-js/dist/__main__.js" fetch
```

Use a new directory outside any existing browser installation. Do not run `fetch` against an occupied browser directory.
The macOS executable inside it is `Camoufox.app/Contents/MacOS/camoufox`.
Set `CAMOUFOX_EXECUTABLE` to that absolute path for setup, lifecycle commands, and the MCP connection.
For persistence, add only that setting to the service's existing `secrets.env` after initialization, preserving all other assignments and private permissions.
If an existing browser is incompatible, preserve it and its profiles. Report the compatibility failure instead of migrating browser data.

## 3. Initialize and create or reuse the profile

Run `stelz init` with the selected `STELZ_HOME`. Initialization preserves existing entries and credentials.
Run `stelz doctor` again. If the runtime is missing, run `stelz setup`.
If the installed runtime already works, reuse it. Setup requires every existing profile to be stopped safely.
Do not stop unrelated browsers to complete onboarding. Report an explicit runtime update as pending when necessary.

```sh
stelz profile create work --json
```

Use the requested ID instead of `work` when supplied. New profiles use native storage and a free loopback port.
An existing ID is reused without rewriting it. Omitted network options retain its existing route and expected IP.
An unspecified route on a new profile is direct. Use `--direct` to require direct networking explicitly.
Existing checkpoint profiles stay in checkpoint mode. This command does not migrate them.

For a proxy, supply one of `--proxy-url URL` or `--proxy-env NAME`.
For an expected IP, supply one of `--expected-ip IP` or `--expected-ip-env NAME`.
Environment input reads the named variable from this process, then stores the value through the catalog's existing private-secret transaction.
It is a one-time import, not a dependency on the client's future environment.
On reuse, existing secret references remain unchanged. Conflicting values produce an error without changing the profile.
An absent or empty proxy variable fails. It never selects direct networking.
Do not place credentials in client configuration or repeat them in reports. Prefer environment input over literal credentials in shell history.

`--json` writes a success object to stdout with `ok`, `created`, `home`, and a profile summary.
Errors go to stderr as `{ "ok": false, "error": { "code": "...", "message": "..." } }` with exit status 1.
Use the error's requested recovery action. Do not delete state and retry with another identity.

Run `stelz start work`, then `stelz doctor work`. Repeated starts reuse the same safe browser lifetime.
If startup fails, preserve the profile and inspect its diagnostics.
Ownership failures require inspection and explicit recovery. Proxy failures require the correct credentials or route.

## 4. Install the canonical skill and connect the client

The canonical skill ships at `$STELZ_PACKAGE/skills/stelz-browser`.
Install a directory symlink to it in the selected client's supported skill location.
Create a missing parent directory, then use `ln -s` only when the destination is absent, including absence of a dangling symlink.
Reuse an existing matching link. Preserve any different installation and report the conflict.
Do not create separate edited skill variants for different clients.

The examples below use `stelz-work` as the connection name.
First inspect an existing entry with that name. Reuse an exact match of command, arguments, service home, and relevant environment.
If it differs, preserve it and request a distinct name or an explicit update. Do not remove another server to make room.

### Codex

Use `~/.agents/skills/stelz-browser`, or `.agents/skills/stelz-browser` for a project-scoped installation.
Inspect `codex mcp get stelz-work --json` before adding an absent entry:

```sh
codex mcp add stelz-work --env "STELZ_HOME=$STELZ_HOME" --env "PATH=$PATH" -- "$STELZ_CLI" mcp --profile work
codex mcp get stelz-work --json
```

Include `CAMOUFOX_EXECUTABLE` if it is an environment-only override.
Codex supports skill symlinks. Check the current tool inventory after registration.
For project scope, merge the same `mcp_servers` fields into `.codex/config.toml` in a trusted project.
Preserve existing fields. Complete any required project-trust prompt through the normal client flow.
If the tools are absent, start a new Codex session or restart the client, then resume at verification.
Keep existing approval and trust settings. [Codex MCP](https://developers.openai.com/codex/mcp/) and [skills](https://developers.openai.com/codex/skills/) describe these supported mechanisms.

### Claude Code

Use `~/.claude/skills/stelz-browser`, or `.claude/skills/stelz-browser` for project scope.
Inspect `claude mcp get stelz-work`, then add only an absent entry:

```sh
claude mcp add --env "STELZ_HOME=$STELZ_HOME" --env "PATH=$PATH" --transport stdio --scope user stelz-work -- "$STELZ_CLI" mcp --profile work
```

Run `/mcp` in the target session and check its actual tools. Accept required trust prompts through the normal client flow.
Reconnect or restart if necessary. See [Claude MCP](https://code.claude.com/docs/en/mcp) and [skills](https://code.claude.com/docs/en/skills).

### Hermes

Use the active Hermes profile's `skills/stelz-browser` directory, normally `~/.hermes/skills/stelz-browser`.
Read the active configuration, normally `~/.hermes/config.yaml`. Preserve every unrelated mapping and setting.
Add only the absent `mcp_servers.stelz-work` entry with absolute paths:

```yaml
mcp_servers:
  stelz-work:
    command: /absolute/path/to/stelz
    args: [mcp, --profile, work]
    env:
      STELZ_HOME: /absolute/service/home
      PATH: /absolute/bun/bin:/absolute/node/bin:/usr/bin:/bin
```

Merge this mapping. Preserve the rest of the YAML file. Include an environment-only browser override if used.
Run `/reload-mcp` if the installed version supports it, otherwise start a new Hermes session.
Verify the tools associated with `stelz-work` in that session.
See [Hermes MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp) and [skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills).

## 5. Verify from the target agent

A saved entry or successful `tools/list` does not establish end-to-end readiness.
Use the target agent's registered tools for the following check. A separate SDK probe establishes browser control only.

1. Start a temporary HTTP fixture on `127.0.0.1`, with a free port. Serve a page with a button and an observable result.
   The installed package includes `examples/onboarding-fixture.html`. Bun can serve it with `Bun.serve` and `Bun.file`.
2. Call `profile_status`, then `profile_acquire`. A busy controller requires deliberate handoff, not a new profile.
3. Call `camofox_list_tabs`. Create a tab for the local fixture.
4. Read a fresh `camofox_snapshot`. Find **Verify Stelz**, then click its returned element reference.
5. Read another snapshot. Require **Stelz verified** and the incremented persistent check count.
6. Call `profile_release`. Check status again. The browser must remain ready, with no active controller.
7. Acquire again, list tabs, and inspect the same page. Confirm its result remains, then release again.
8. Stop only the temporary fixture server. Leave the browser and its pages available.

For an actual website's authentication challenge, pause and request human action in the same window.
Never automate authentication challenges as part of this check.

## 6. Report and resume

Return this table with evidence and any pending action:

| State | Required evidence |
| --- | --- |
| Installed | Compatible dependencies, selected Stelz version, and prepared runtime |
| Browser ready | Selected profile started and browser-control interface responded |
| Client configured | Canonical skill installed and the intended MCP entry saved |
| Verified | The target agent completed the local-page interaction and release check |

Mark untested stages as pending. If a restart is required, give the client, profile ID, service home, and exact verification step to resume.
Do not claim **Verified** from configuration alone. A failed run can resume with the same prompt and profile.

The [onboarding acceptance report](onboarding-acceptance.md) records test coverage and required interventions.
