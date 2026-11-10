# Working rules

- Be brief. Use TypeScript and Bun for custom code.
- Keep all documentation concise. Reference existing details instead of repeating them.
- Review code for DRY and YAGNI. Fix only concrete findings.
- After a fix, run only the browser suites that `bunx lefthook run browser` selects. Run the full archive suites once per candidate. See `docs/development/testing.md`.
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

Register `stelz mcp` once per client configuration. Each connection can control many profiles.
Keep the 18 fixed tools. Use `profile_list` for a fresh catalog.
Pass `profileId` to create, start, status, and acquire.
Acquisition returns status and a fresh opaque `controlHandle` for that connection, profile, and browser lifetime.
Pass both fields to release, pause, resume, recheck, and all nine Camofox tools.
Never expose handles in status or catalog summaries.
Enforce one controller and one action queue per profile. Do not add agent identities or agent count limits.
A client must call `profile_release` before handoff. Release and disconnect must preserve browsers and open pages.
Only an explicit lifecycle command stops a browser.

Runtime creation makes direct profiles or safely reuses existing profiles unchanged. Start remains explicit.
Keep configuration, proxies, deletion, import, stop, recovery, and forced handoff in the CLI or UI.
Preserve profile-import `--profile` selectors. Stelz has no backward compatibility with earlier versions or their data.
Do not migrate browser data or edit global harness configuration. Previously planned browser controls remain deferred.

Keep profile state under `STELZ_HOME`. Never derive a profile from a client PID, conversation ID, or harness directory.
Preserve existing profile IDs, data paths, and configured secret references.
Reuse the upstream Camofox server and canonical browser arguments, with the required profile and control fields.
Require fresh location preflight for each new proxied lifetime. Verify the browser before Ready or acquisition.
Use `stelz setup` to prepare shared location data. Never download prerequisites during Start or MCP calls.
A failed startup closes only its owned attempt and preserves the location failure and native data.

Browser tasks must use fresh observations. Pause for human authentication in the same window.
Do not bypass authentication challenges or write website-specific task scripts.

Use local fixtures and synthetic proxy inputs for routine tests. Never copy everyday profile proxies into test inputs.
Live checks require a declared test proxy, which the operator must keep separate from everyday profiles. Reserve a separate proxy and persistent test profile for occasional public-site checks.
See `docs/development/testing.md` for the dedicated-input declarations and test-home setup.
