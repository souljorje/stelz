# Working rules

- Be brief. Use TypeScript and Bun for custom code.
- Prefix shell commands with `rtk`.
- Read `docs/README.md` for service operations.
- Read `docs/agents.md` for the MCP control protocol.
- Use the installed ASD-STE100 skill for documentation.
- Preserve global harness configuration and approval protections.
- For short-lived subagents, use `fork_turns: "none"` where the host supports it. Use `fork_context: false` otherwise.

# Service boundary

stelz is a standalone browser service. It must run without Codex, Claude Code, Hermes, or LLM credentials.
Do not add a reasoning loop, agent framework, generic plugin framework, or fleet platform.
Keep the tested limit at two browsers.

Each MCP connection selects one identity with `--identity`. The browser service enforces one controller per identity.
A client releases control with `identity_release`. Disconnect must preserve the browser and its open pages.
Only an explicit lifecycle command stops a browser.

Keep identity state under `STELZ_HOME`. Never derive an identity from a client PID, conversation ID, or harness directory.
Reuse the upstream Camofox server and canonical MCP tool contracts.

Browser tasks must use fresh observations. Pause for human authentication in the same window.
Do not bypass authentication challenges or write website-specific task scripts.
