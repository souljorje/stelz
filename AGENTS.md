# Working rules

- Be brief. Use TypeScript and Bun for custom code.
- Read `docs/README.md` for service operations.
- Read `skills/stelz-browser/SKILL.md` for the MCP control protocol.
- Use the installed ASD-STE100 skill for documentation.
- For versioning or publication, read [Release Stelz](docs/development/releasing.md). Add Changesets for package changes and publish only the archive checked in CI.
- Preserve global harness configuration and approval protections.
- For short-lived subagents, use `fork_turns: "none"` where the host supports it. Use `fork_context: false` otherwise.

# Service boundary

stelz is a standalone browser service. It must run without Codex, Claude Code, Hermes, or LLM credentials.
Do not add a reasoning loop, agent framework, generic plugin framework, or fleet platform.
Enforce one browser instance per profile. Do not add global browser or saved-profile count limits.

Each MCP connection selects one profile with `stelz mcp --profile ID`. The browser service enforces one controller per profile.
A client releases control with `profile_release`. Disconnect must preserve the browser and its open pages.
Only an explicit lifecycle command stops a browser.

Keep profile state under `STELZ_HOME`. Never derive a profile from a client PID, conversation ID, or harness directory.
Preserve existing profile IDs, data paths, and configured secret references.
Reuse the upstream Camofox server and canonical MCP tool contracts.

Browser tasks must use fresh observations. Pause for human authentication in the same window.
Do not bypass authentication challenges or write website-specific task scripts.
