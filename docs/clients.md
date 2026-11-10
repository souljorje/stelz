# Connect your agent

Connect Codex, Claude Code, or Hermes to Stelz with one `stelz mcp` registration.
Each connection can control multiple profiles through explicit profile IDs and control handles.
The same 18 tools remain available as profiles change. No per-profile registration is necessary.

## Before registration

Registration works with an empty catalog. A browser must be running before an agent can acquire it.
Use `profile_create({profileId})` and `profile_start({profileId})` when runtime creation and startup are necessary.
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

Merge [the TOML example](../examples/codex.toml) into the project's `.codex/config.toml` as the shared `stelz` entry.
Set its command, `STELZ_HOME`, and PATH to the values above.
Preserve other entries and complete normal project-trust prompts.
Inspect the resulting registration with:

```sh
codex mcp get stelz --json
```

Install the skill at project scope, only when that destination is absent:

```sh
mkdir -p .agents/skills
ln -s "$STELZ_PACKAGE/skills/stelz-browser" .agents/skills/stelz-browser
```

Start a new Codex session if the current session does not expose the new tools.
Then complete [verification](#verify-the-connection).

Sources: [OpenAI MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) and [skills](https://learn.chatgpt.com/docs/build-skills).

## Claude Code

Inspect `claude mcp get stelz`. For an absent project entry, run:

```sh
claude mcp add --env "STELZ_HOME=$STELZ_HOME" --env "PATH=$PATH" --transport stdio --scope project stelz -- "$STELZ_CLI" mcp
```

Install the skill only when its destination is absent:

```sh
mkdir -p .claude/skills
ln -s "$STELZ_PACKAGE/skills/stelz-browser" .claude/skills/stelz-browser
```

[The JSON example](../examples/claude.json) shows the equivalent server fields.
Check `/mcp` in the target session. Complete normal trust prompts and reconnect or start a new session if needed.
Then complete [verification](#verify-the-connection).

Sources: [Claude Code MCP](https://code.claude.com/docs/en/mcp) and [skills](https://code.claude.com/docs/en/skills).

## Hermes

The operator can merge [the YAML example](../examples/hermes.yaml) into the active Hermes profile's configuration, normally `~/.hermes/config.yaml`.
Agents must preserve global harness configuration. If no project scope is available, provide this entry to the operator.
Replace its absolute command, service directory, and PATH examples with your selected values.
Keep other mappings. Reuse `stelz` only when its command, arguments, home, and environment match.

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

> Use the shared Stelz tools. List profiles and select `work`. Create it if missing and start it if stopped.
> Check its status and acquire control. Keep the returned handle with profile ID `work`.
> Pass both fields to every control and browser call. Open this local URL: PASTE_URL.
> Read a fresh accessibility snapshot. Click **Verify Stelz** using its observed element reference.
> Read another snapshot. Check for **Stelz verified** and an increased persistent check count.
> Release control and leave the browser open. Acquire again with a fresh handle.
> Check the same page and result, then release again.

The agent must use `profile_list({})`, `profile_status({profileId: "work"})`, and `profile_acquire({profileId: "work"})`.
It must pass `profileId` and the returned `controlHandle` to actual `camofox_*` tools and `profile_release`.
Each successful acquisition returns a fresh handle for that connection, profile, and browser lifetime.
List and status return controller summaries without handles.
See [Shared MCP tools](mcp.md) for the complete contract.
Do not substitute a separate SDK script for the agent's interaction.
Successful verification leaves the same browser **Ready**, without a controller, and the demonstration page still open.
Stop the demonstration server with Ctrl-C after the check. This keeps the browser open.
For missing tools, conflicts, or failures, follow [Troubleshooting](troubleshooting.md).

## Multiple profiles and handoff

Call `profile_list({})` to discover profiles created after registration.
Create `research` through `profile_create({profileId: "research"})`, the CLI, or the UI.
Start it explicitly with `profile_start({profileId: "research"})`, the CLI, or the UI.
Reuse the same registration. One connection can acquire both `work` and `research` and retain a separate handle for each.
Different agents can control separate profiles concurrently. Each profile permits one controller and has its own action queue.
There are no agent identities or agent count limits.

Before handing `work` to another agent, call `profile_release` with its profile ID and current handle.
Disconnect also releases control while preserving browsers and pages.
The second agent acquires `work` through its existing shared connection and receives a new handle.
It checks existing tabs and reads a fresh snapshot before an action.
Keep the browser running throughout. Stopping it would test saved-state restoration instead of a live handoff.
