# Connect a client

Start the selected profile first. Then configure its MCP connection.
All clients use the same `stelz mcp --profile ID` command.
None require a separate browser-control implementation.

For dependency installation, profile creation, and canonical skill installation, follow [Bootstrap](bootstrap.md).
Check the tools in the target agent session after registration. Start a new session if the client cannot reload MCP.
Report **Verified** only after the agent completes the local-page interaction and releases control with the browser still ready.

The examples configure two servers. Each server selects one profile.
Replace example IDs with your configured IDs. Existing IDs do not change.
Use an absolute `stelz` path if the client cannot find the global command.
If you set `STELZ_HOME`, pass the same value to the client and the lifecycle commands.

## Codex

Copy the entries from [codex.toml](../examples/codex.toml) into the appropriate MCP configuration.
Preserve existing configuration entries. Start a new session if its MCP tools are absent after the change.

The example uses documented `mcp_servers`, `command`, and `args` fields.
See the [official Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

## Claude Code

Merge [claude.json](../examples/claude.json) into the appropriate MCP configuration.
The example uses the standard `mcpServers` format.
See the [official Claude Code MCP documentation](https://code.claude.com/docs/en/mcp).

## Hermes

Merge [hermes.yaml](../examples/hermes.yaml) into `~/.hermes/config.yaml`.
The example uses documented `mcp_servers`, `command`, and `args` fields.
See the [official Hermes MCP documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp).

## Check a handoff

1. Acquire `profile-01` in the first client.
2. Open a test page.
3. Release control or disconnect the first client.
4. Acquire `profile-01` in the second client.
5. Check the original tab and its state.
6. Check that the browser lifetime and fingerprint file did not change.

Do not stop the profile between these steps. Stop would test restart persistence instead of live handoff.
