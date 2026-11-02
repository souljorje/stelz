# Instructions for agents

The service contains no reasoning loop. The client harness owns reasoning and conversation history.
Each MCP connection must select one configured identity with `stelz mcp --identity ID`.

## Procedure

1. Call `identity_status`.
2. Ask the operator to start a stopped identity with `stelz start ID`.
3. Call `identity_acquire`.
4. Read the open tabs with `camofox_list_tabs`.
5. Read a fresh `camofox_snapshot` before you select an action.
6. Use the returned element references for clicks and typing.
7. Check the result with a fresh snapshot.
8. Call `identity_release` when another client needs control.

An active controller causes another acquisition to fail. Wait for deliberate release or operator handoff.
Do not start another browser to avoid a controller conflict.

## Authentication and manual work

1. Call `identity_pause` when authentication requires a human.
2. Tell the operator which action is necessary in the same window.
3. Wait for the operator's result.
4. Call `identity_resume`.
5. Read a fresh snapshot before the next action.

Do not bypass authentication challenges.
Do not close the reserved IP-check tab.

## Tool interface

`identity_status`, `identity_acquire`, `identity_release`, `identity_pause`, and `identity_resume` take no arguments.
The browser tools use the upstream Camofox schemas. Read them through standard MCP `tools/list`.
Do not add identity IDs, controller tokens, or conversation IDs to browser tool arguments.
The connection already fixes the identity.

## Handoff

Release and disconnect do not close pages or change the saved fingerprint configuration.
The next controller sees the same open browser page and browser state.
It does not receive the previous client's conversation or reasoning history.
Only an explicit lifecycle command stops the browser.
