# Recovery

Call `profile_status` before another browser action.
For missing installation or profiles, follow [Setup](../../../docs/bootstrap.md).
For other failures, use the matching procedure in [Troubleshooting](../../../docs/troubleshooting.md).

Use `profile_recheck` for the documented IP recheck and `profile_resume` after a successful check when the browser remains paused.
Use `profile_release` for deliberate handoff. These MCP tools apply to the selected profile and take no profile ID.
CLI diagnostics, stop, and recovery belong to the operator. Never signal unverified PIDs or bypass uncertain ownership.

Never replay an interrupted action automatically. Read a fresh snapshot before continuing.
