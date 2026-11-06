# Recovery

Call `profile_status({profileId})` before another browser action.
Call `profile_list({})` when the catalog may have changed.
For missing installation or profiles, follow [Setup](../../../docs/bootstrap.md).
For other failures, use the matching procedure in [Troubleshooting](../../../docs/troubleshooting.md).

Use `profile_recheck({profileId, controlHandle})` for the documented IP recheck.
Use `profile_resume({profileId, controlHandle})` after a successful check when the browser remains paused.
Use `profile_release({profileId, controlHandle})` before deliberate handoff.
Each handle belongs to its issuing connection, profile, and browser lifetime.
After release, disconnect, restart, or forced handoff, call `profile_acquire({profileId})` for a new handle.
Never copy another connection's handle or infer one from a controller summary.
CLI diagnostics, stop, and recovery belong to the operator. Never signal unverified PIDs or bypass uncertain ownership.

For the removed MCP `--profile` option or an old control protocol, follow [Migration](../../../docs/clients.md#migrate-an-existing-registration).
Keep the same `STELZ_HOME`. Prepare the updated runtime and explicitly restart old browser services.
Do not migrate profile data or edit global harness configuration.

Never replay an interrupted action automatically. Read a fresh snapshot before continuing.
