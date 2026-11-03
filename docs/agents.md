# Instructions for agents

The service contains no reasoning loop. The client harness owns reasoning and conversation history.
Each MCP connection must select one configured identity with `stelz mcp --identity ID`.

## Procedure

1. Call `identity_status`.
2. Ask the operator to create an unknown identity in the UI. Ask them to start a stopped identity with `stelz start ID`.
3. Call `identity_acquire`.
4. Read the open tabs with `camofox_list_tabs`.
5. Read a fresh `camofox_snapshot` before you select an action.
6. Use the returned element references for clicks and typing.
7. Check the result with a fresh snapshot.
8. Call `identity_release` when another client needs control.

An active controller causes another acquisition to fail. Wait for deliberate release or operator handoff.
Do not start another browser to avoid a controller conflict.
If status reports `orphaned`, ask the operator to inspect the identity with `stelz doctor ID`.
If an IP check fails, ask the operator to correct the network. Then call `identity_recheck`.
If the identity remains paused, call `identity_resume` after the recheck succeeds.
After a successful recheck, read a fresh snapshot before the next action.
If an operation exceeds its service deadline, ask the operator to stop and start the identity.

## Authentication and manual work

1. Call `identity_pause` when authentication requires a human.
2. Tell the operator which action is necessary in the same window.
3. Wait for the operator's result.
4. Call `identity_resume`.
5. Read a fresh snapshot before the next action.

Do not bypass authentication challenges.
Do not close the reserved IP-check tab.

## Tool interface

`identity_status`, `identity_acquire`, `identity_release`, `identity_pause`, `identity_resume`, and `identity_recheck` take no arguments.
The browser tools use the upstream Camofox schemas. Read them through standard MCP `tools/list`.
Do not add identity IDs, controller tokens, or conversation IDs to browser tool arguments.
The connection already selects the identity.

## Handoff

Release and disconnect do not close pages or change the saved fingerprint configuration.
The next controller sees the same open browser page and browser state.
It does not receive the previous client's conversation or reasoning history.
Only an explicit lifecycle command stops the browser.
Closing the browser window also stops its identity. The next start remains explicit.
