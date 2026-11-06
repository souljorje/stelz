# Recovery

1. Call `profile_status` before another browser action.
2. For a missing or stopped profile, follow [Setup](../../../docs/bootstrap.md) to create or start it.
3. For an active controller, wait for deliberate release or operator handoff.
4. For an orphaned profile, ask the operator to run `stelz doctor ID`.
5. For failed IP verification, ask the operator to correct the network. Then call `profile_recheck`.
6. If the profile remains paused, call `profile_resume` after a successful recheck.
7. After a service deadline, ask the operator to stop and start the profile.

Recovery must not signal unverified PIDs. The operator must inspect unknown ownership before further action.
After recorded processes exit, `stelz recover ID` archives an unclean lifetime. It preserves saved browser data.
Never replay an interrupted action automatically. Read a fresh snapshot before the next action.
