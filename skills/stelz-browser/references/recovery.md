# Recovery

1. Call `profile_status` before another browser action.
2. For an unknown profile, ask the operator to create it in the local UI.
3. For a stopped profile, ask the operator to run `stelz start ID`.
4. For an active controller, wait for deliberate release or operator handoff.
5. For an orphaned profile, ask the operator to run `stelz doctor ID`.
6. For failed IP verification, ask the operator to correct the network. Call `profile_recheck`.
7. If the profile remains paused, call `profile_resume` after a successful recheck.
8. After a service deadline, ask the operator to stop and start the profile.

Recovery must not signal unverified PIDs. The operator must inspect unknown ownership before further action.
After recorded processes exit, `stelz recover ID` archives an unclean lifetime. It preserves saved browser data.
Never replay an interrupted action automatically. Read a fresh snapshot before the next action.
