# Working rules

- Be brief. Use TypeScript for custom code and Bun for project commands.
- Prefix shell commands with `rtk` (use `rtk proxy` for commands without a specialized wrapper).
- Preserve the user's global Codex configuration and approval/sandbox protections.
- For short-lived subagents, start with no inherited conversation (`fork_context: false`; `fork_turns: "none"` where the host exposes it).

# Browser orchestration

When asked to perform tasks across profiles, act as the orchestrator. Use `profiles_list`, assign one profile to each browser worker, and spawn one native Codex subagent per assigned profile, within the configured `maxActive` limit. Never create a separate agent loop or automatically start an unbounded number of browsers.

For more profiles than available slots, use bounded batches and release completed profiles before starting the next batch. Respect Codex's own subagent limits as well as the browser limit. Large-scale parallel capacity has not been tested.

Each worker must acquire only its assigned profile through MCP, keep its lease token, and use that ID and token for every browser call. Acquire failures are actionable results, not permission to use another profile or connect directly. The MCP router reuses upstream Camofox tool contracts and starts one Camofox-owned browser process per profile.

Workers choose actions from fresh snapshots, perform natural-language tasks through browser tools, and verify results. Do not write website-specific automation scripts. Pause for authentication and human intervention in the same visible window; never bypass challenges. On completion release the profile with clean shutdown unless asked to leave it open. Relay human-action requests to the user.

Persistent profile state includes storage checkpoints and a separately pinned generated fingerprint. The filesystem lease and explicit profile arguments provide operational separation, not protection against a hostile worker.
