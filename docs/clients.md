---
title: "Connect your agent"
description: "Register Codex, Claude Code, or Hermes with Stelz, install the browser skill, check the connection, and hand a profile between agents."
tags: [agent, mcp, skill]
sources:
  - "https://learn.chatgpt.com/docs/extend/mcp?surface=cli"
  - "https://learn.chatgpt.com/docs/build-skills"
  - "https://code.claude.com/docs/en/mcp"
  - "https://code.claude.com/docs/en/skills"
  - "https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp"
  - "https://hermes-agent.nousresearch.com/docs/user-guide/features/skills"
created: 2026-11-02T15:09:08Z
modified: 2026-11-11T14:27:18Z
---

# Connect your agent

Register `stelz mcp` once per client. The 18 tools serve all profiles. See [Shared MCP tools](mcp.md).

## Before registration

- Registration works with an empty catalog. An agent can acquire only a running browser.
- Use the same service directory as the UI.

Default global npm installation:

```sh
export STELZ_HOME="${STELZ_HOME:-$HOME/.local/share/stelz}"
STELZ_CLI="$(command -v stelz)"
STELZ_PACKAGE="$(npm root --global)/stelz"
```

- Custom npm prefix: use its `lib/node_modules/stelz` directory. Symlinked CLI: resolve it to find the package directory.
- The MCP process needs Bun and Node.js on PATH, even when a desktop application starts your agent. The examples pass the current PATH.
- Custom Camoufox executable: see [Browser executable](configuration/environment.md#browser-executable).
- Install the skill as a directory symlink, as the client sections show. Keep the package's `docs/` and `skills/` together.
- Reuse a matching link. Preserve conflicting files, directories, and dangling links. Do not replace another installation.

## Codex

Merge [the TOML example](../examples/codex.toml) into the project's `.codex/config.toml` as the `stelz` entry.

- Set its command, `STELZ_HOME`, and PATH to the values above.
- Keep `tool_timeout_sec` at 240 or more, so a 3-minute `camofox_type` call can finish.
- Preserve other entries.

Inspect the registration:

```sh
codex mcp get stelz --json
```

Install the skill at project scope, only when that destination is absent:

```sh
mkdir -p .agents/skills
ln -s "$STELZ_PACKAGE/skills/stelz-browser" .agents/skills/stelz-browser
```

Codex loads a project's configuration only after you trust the project. Start a new session if the current one lacks the tools. Then [verify the connection](#verify-the-connection).

## Claude Code

Inspect `claude mcp get stelz`. Absent project entry:

```sh
claude mcp add --env "STELZ_HOME=$STELZ_HOME" --env "PATH=$PATH" --transport stdio --scope project stelz -- "$STELZ_CLI" mcp
```

Install the skill only when its destination is absent:

```sh
mkdir -p .claude/skills
ln -s "$STELZ_PACKAGE/skills/stelz-browser" .claude/skills/stelz-browser
```

- Equivalent server fields: [JSON example](../examples/claude.json).
- Check `/mcp` in the target session. Reconnect or start a new session if needed.
- Then [verify the connection](#verify-the-connection).

## Hermes

The operator merges [the YAML example](../examples/hermes.yaml) into the active Hermes profile's configuration, normally `~/.hermes/config.yaml`.

- Agents must not edit global harness configuration. Give the entry to the operator.
- Replace its command, service directory, and PATH with your values.
- Keep `timeout` at 240 seconds or more.
- Reuse `stelz` only when its command, arguments, home, and environment match.

Install the skill in the active Hermes profile's skill directory, normally:

```sh
mkdir -p "$HOME/.hermes/skills"
ln -s "$STELZ_PACKAGE/skills/stelz-browser" "$HOME/.hermes/skills/stelz-browser"
```

- Preserve an existing destination.
- After a configuration change, use `/reload-mcp` or start a new session. Then [verify the connection](#verify-the-connection).

## Verify the connection

Use the agent session that owns the new connection. In another terminal, serve the packaged local demonstration page:

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

Copy the printed loopback URL. Ask your agent:

> Use the shared Stelz tools. List profiles and select `work`. Create it if missing and start it if stopped.
> Check its status and acquire control. Keep the returned handle with profile ID `work`.
> Pass both fields to every control and browser call. Open this local URL: PASTE_URL.
> Read a fresh accessibility snapshot. Click **Verify Stelz** using its observed element reference.
> Read another snapshot. Check for **Stelz verified** and an increased persistent check count.
> Release control and leave the browser open. Acquire again with a fresh handle.
> Check the same page and result, then release again.

- The agent must use its actual `profile_*` and `camofox_*` tools. See the [browser skill](../skills/stelz-browser/SKILL.md#do-a-browser-task).
- Do not substitute a separate SDK script.
- Success: the browser is **Ready**, has no controller, and keeps the demonstration page open.
- Stop the demonstration server with Ctrl-C. The browser stays open.
- Failures: [Troubleshooting](troubleshooting/index.md).

## Multiple profiles and handoff

- `profile_list({})` finds profiles created after registration.
- Create and start `research` with `profile_create({profileId: "research"})` and `profile_start({profileId: "research"})`, the CLI, or the UI.
- One connection can acquire `work` and `research`. It keeps a separate handle for each.

Handoff:

1. The first agent releases `work`. See the [browser skill](../skills/stelz-browser/SKILL.md#do-a-browser-task).
2. The second agent acquires `work` through its own shared connection and receives a new handle.

Keep the browser running. The second agent sees the same pages and session.
