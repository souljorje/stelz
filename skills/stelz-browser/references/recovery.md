# Recovery

Call `profile_status({profileId})` before another browser action.
Call `profile_list({})` when the catalog may have changed.
For missing installation or profiles, follow [Setup](../../../docs/bootstrap.md).
For other failures, use the matching procedure in [Troubleshooting](../../../docs/troubleshooting.md).

Use `profile_recheck({profileId, controlHandle})` for the documented IP recheck.
Use `profile_resume({profileId, controlHandle})` after a successful check when the browser remains paused.
Use `profile_release({profileId, controlHandle})` before deliberate handoff.
After release, disconnect, restart, or forced handoff, acquire a new handle. See [Control handles](../../../docs/mcp.md#control-handles).
CLI diagnostics, stop, and recovery belong to the operator. Never signal unverified PIDs or bypass uncertain ownership.

Never replay an uncertain or interrupted action. Read a fresh snapshot before continuing.
