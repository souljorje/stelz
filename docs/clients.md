# Connect your agent

Connect Codex, Claude Code, or Hermes to the `work` browser you created in [Getting started](getting-started.md).
The result is one agent with browser tools for that profile.
Keep the browser running during registration.

## Before registration

Check `stelz status work`. The browser must be ready before an agent can acquire it.
Use the same service directory as the UI.
For a default global npm installation, prepare these shell variables:

```sh
export STELZ_HOME="${STELZ_HOME:-$HOME/.local/share/stelz}"
STELZ_CLI="$(command -v stelz)"
STELZ_PACKAGE="$(npm root --global)/stelz"
```

For a custom npm prefix, select its installed `lib/node_modules/stelz` directory instead.
Resolve a symlinked CLI to confirm the package directory if installations differ.
The MCP process needs Bun and Node.js on PATH, even when your agent starts from a desktop application.
The examples pass the current PATH explicitly.

Keep proxy credentials in Stelz's private configuration, outside client configuration and reports.
Persist a custom Camoufox executable in the service's `secrets.env`, as described in [Getting started](getting-started.md#2-locate-or-download-camoufox).

Install the canonical browser skill through a directory symlink. Keep the package's `docs/` and `skills/` together.
Reuse a matching existing link. Preserve conflicting files, directories, and dangling links for review.
Do not copy the skill alone or replace another installation.

## Codex

Inspect `codex mcp get stelz-work --json`. For an absent entry, run:

```sh
codex mcp add stelz-work --env "STELZ_HOME=$STELZ_HOME" --env "PATH=$PATH" -- "$STELZ_CLI" mcp --profile work
codex mcp get stelz-work --json
```

Install the skill at user scope, only when that destination is absent:

```sh
mkdir -p "$HOME/.agents/skills"
ln -s "$STELZ_PACKAGE/skills/stelz-browser" "$HOME/.agents/skills/stelz-browser"
```

For project scope, use `.agents/skills/stelz-browser` and merge [the TOML example](../examples/codex.toml) into the project's `.codex/config.toml`.
Set the example's command, `STELZ_HOME`, and PATH to the same values as above.
Preserve other entries and complete normal project-trust prompts.
Start a new Codex session if the current session does not expose the new tools.
Then complete [verification](#verify-the-connection).

Sources: [OpenAI MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) and [skills](https://learn.chatgpt.com/docs/build-skills).

## Claude Code

Inspect `claude mcp get stelz-work`. For an absent entry, run:

```sh
claude mcp add --env "STELZ_HOME=$STELZ_HOME" --env "PATH=$PATH" --transport stdio --scope user stelz-work -- "$STELZ_CLI" mcp --profile work
```

Install the skill only when its destination is absent:

```sh
mkdir -p "$HOME/.claude/skills"
ln -s "$STELZ_PACKAGE/skills/stelz-browser" "$HOME/.claude/skills/stelz-browser"
```

Project skills use `.claude/skills/stelz-browser`. For project MCP scope, use `--scope project` instead of `--scope user`.
[The JSON example](../examples/claude.json) shows the equivalent server fields.
Check `/mcp` in the target session. Complete normal trust prompts and reconnect or start a new session if needed.
Then complete [verification](#verify-the-connection).

Sources: [Claude Code MCP](https://code.claude.com/docs/en/mcp) and [skills](https://code.claude.com/docs/en/skills).

## Hermes

Merge [the YAML example](../examples/hermes.yaml) into the active Hermes profile's configuration, normally `~/.hermes/config.yaml`.
Replace its absolute command, service directory, and PATH examples with your selected values.
Keep other mappings. Reuse `stelz-work` only when its command, arguments, home, and environment match.

Install the skill in the active Hermes profile's skill directory, normally:

```sh
mkdir -p "$HOME/.hermes/skills"
ln -s "$STELZ_PACKAGE/skills/stelz-browser" "$HOME/.hermes/skills/stelz-browser"
```

Preserve an existing destination. Use `/reload-mcp` after changing MCP configuration, or start a new session.
Then complete [verification](#verify-the-connection).

Sources: [Hermes MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp) and [skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills).

## Verify the connection

Use the agent session that owns the new connection. Configuration alone does not establish that tools work.
Serve the packaged local demonstration page in another terminal:

```sh
STELZ_PACKAGE="$(npm root --global)/stelz"
STELZ_FIXTURE="$STELZ_PACKAGE/examples/onboarding-fixture.html" bun -e '
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch: () => new Response(Bun.file(process.env.STELZ_FIXTURE))
});
console.log(server.url.href);
'
```

For a custom installation, use its actual package directory.
Copy the printed loopback URL. Ask your agent:

> Use the Stelz tools for `work`. Check status and acquire control. Open this local URL: PASTE_URL. Read a fresh accessibility snapshot. Click **Verify Stelz** using its observed element reference. Read another snapshot and confirm **Stelz verified** with an increased persistent check count. Release control and leave the browser open. Acquire again, confirm the same page and result, then release again.

The agent must use `profile_status`, `profile_acquire`, and actual `camofox_*` tools, followed by `profile_release`.
Do not substitute a separate SDK script for the agent's interaction.
Successful verification leaves the same browser **Ready**, without a controller, and the demonstration page still open.
Stop the demonstration server with Ctrl-C after the check. This keeps the browser open.
For missing tools, conflicts, or failures, follow [Troubleshooting](troubleshooting.md).

## Multiple profiles and handoff

Create `research` in the UI for a second agent. Start it and register a distinct connection, such as `stelz-research`.
Use the same registration procedure with `--profile research` and its own connection name.
Each profile accepts one controller. Separate profiles can run concurrently.

To hand `work` to another agent, release its controller or disconnect the first agent.
The second agent acquires `work` and checks its existing tabs and page state.
Keep the browser running throughout. Stopping it would test saved-state restoration instead of a live handoff.
