---
title: "Shared MCP tools"
description: "The MCP tools of stelz mcp, the --tools groups, the scripts switch, tool results, and the control-handle contract, to read when you call or integrate the tools."
tags: [mcp, agent, reference]
sources: []
created: 2026-11-06T16:47:49Z
modified: 2026-11-15T09:00:00Z
---

# Shared MCP tools

- One connection to `stelz mcp` controls many profiles.
- See [Connect your agent](clients.md).
- Each profile: one controller, one action queue. Separate profiles can run actions concurrently.
- No agent identities.

## Tool groups

`stelz mcp --tools core|full|NAME,NAME`. The default is `core`.

| Value | Tools |
| --- | --- |
| `core` | The nine `profile_*` tools and 13 browser tools. The browser tools have **core** in the table below. |
| `full` | Every listed tool. |
| `NAME,NAME` | The named tools. |

- A comma-separated list can mix `core`, `full`, and tool names. For example, `core,tab_forward` is `core` plus `tab_forward`.
- A name that is not a listed tool stops `stelz mcp` at startup. This includes held tools and misspelled names.
- The tool list stays fixed for the connection. `tools/list` returns the same tools, including when the profile catalog is empty. Profile creation adds no tools.
- `profile_list({})` returns the current catalog.
- Scripts tools follow the rules in [Scripts](#scripts).

## Tools

| Profile tool | Arguments | Effect |
| --- | --- | --- |
| `profile_list` | `{}` | Returns a fresh catalog and profile status. |
| `profile_create` | `{profileId}` | Creates a direct profile or safely reuses an existing one unchanged. Leaves a new browser stopped. |
| `profile_start` | `{profileId}` | Starts the profile or reuses its safe running lifetime. Does not acquire control. |
| `profile_status` | `{profileId}` | Returns profile status and a controller summary. |
| `profile_acquire` | `{profileId}` | Acquires exclusive control of a running profile. Returns status and a fresh opaque `controlHandle`. Never starts a stopped browser. |
| `profile_release` | `{profileId, controlHandle}` | Releases control after current actions finish. Preserves the browser, pages, and phase. |
| `profile_pause` | `{profileId, controlHandle}` | Pauses browser actions for human work in the same window. Retains control. |
| `profile_resume` | `{profileId, controlHandle}` | Resumes after human work and any required IP check. Retains control. |
| `profile_recheck` | `{profileId, controlHandle}` | Repeats the browser IP check. Preserves a pause. |

Every browser tool requires `profileId` and `controlHandle` with its own arguments. Full schemas: `tools/list`.

| Browser tool | Group | Purpose |
| --- | --- | --- |
| `tab_create`, `tab_close` | core | Open or close a tab. |
| `tab_list` | core | Read the tabs that Stelz manages. Tabs that a person opens stay open but are not listed. |
| `tab_navigate`, `tab_back` | core | Go to a URL or search macro. Go back one history entry. |
| `tab_snapshot` | core | Read a fresh accessibility snapshot. |
| `tab_click`, `tab_press`, `tab_select`, `tab_scroll` | core | Click an observed element, press a key, choose an option in a native list, or scroll. |
| `tab_type` | core | Enter text. Also accepts `mode`. See [Typing](configuration/typing.md). |
| `tab_screenshot` | core | Capture a tab image. `fullPage` captures the whole page. |
| `tab_wait` | core | Wait for a page to settle. `timeout` is 0 to 60000 ms. The default is 10000. |
| `tab_forward`, `tab_refresh` | full | Go forward one history entry. Reload the page. |
| `tab_mouse_wheel`, `tab_drag` | full | Wheel over an element or a point. Drag between two points. |
| `tab_ax`, `tab_actionables`, `tab_table_rows`, `tab_links`, `tab_images`, `tab_extract` | full | Read the raw accessibility tree, candidate targets, table rows, links, images, or structured data. |
| `tab_evaluate`, `tab_init_script` | full, with [scripts](#scripts) | Run JavaScript in a page. `tab_evaluate` takes `timeoutMs`, a whole number from 1000 to 120000. The default is 30000. |

- Stelz holds `tab_activate` and every upstream tool that it has not reviewed. It lists none of them. Stelz has no tool for cookies, storage, file upload, or the viewport. Cookie import and storage import stay in the CLI or UI.
- A call with a `progressToken` gets a progress notification every 10 seconds until it ends.
- Set your client to reset its request timeout on progress. Some calls, such as `tab_type`, can take minutes.
- Each call has its own time limit. See [Typing](configuration/typing.md).

## Tool results

- A JSON result is one compact JSON text block.
- `tab_snapshot`: the first line is JSON with `url`, `refsCount`, `truncated`, and `nextOffset`. `nextOffset` appears only when more text remains. The page text follows as plain text, not JSON-escaped. A screenshot, when present, is an image block.
- `tab_screenshot`: one image block.
- A failed call returns `isError: true` and one text block. A location failure is JSON with `error` and `location`.
- Results have no `structuredContent`.

## Scripts

- `tab_evaluate` and `tab_init_script` run arbitrary JavaScript in a page. They are off by default.
- The `allowScripts` setting of a profile controls them. A person sets it with `stelz profile config ID --allow-scripts` or with **Allow scripts** in the UI. MCP cannot change it. `--no-allow-scripts` turns it off.
- A connection lists a scripts tool only when both rules hold:
  - `--tools full` or the tool name selects it. `core` never lists it.
  - At least one profile has `allowScripts: true` when the connection starts. After the first profile allows scripts, reconnect.
- Each call checks the setting of its own profile. A call on a profile without it fails. The message names the CLI command and the UI setting.
- Turning the setting off does not remove scripts that `tab_init_script` registered. They stay until their tab closes.
- A `tab_evaluate` that passes its `timeoutMs` returns an error. The script can still run in the page. Read a snapshot. Do not run the script again. The profile stays ready.
- A `tab_evaluate` that passes the service time limit blocks the browser lifetime, like any other action. See [Typing](configuration/typing.md).

## Control handles

- Every successful `profile_acquire` returns a fresh opaque handle. Do not derive it from a profile ID, process ID, agent name, or controller summary.
- Use it only on the connection, profile, and browser lifetime that issued it. Keep one handle for each profile.
- List and status return controller summaries without handles.
- A connection cannot acquire a profile while its previous acquisition is active or pending. Release first.
- Release, disconnect, browser restart, and forced operator handoff invalidate the control. Acquire again, use the new handle, and read fresh browser state.
- Release and disconnect preserve running browsers and open pages. The next connection acquires its own handle.

## Limits of the tools

- Creation never reconfigures an existing profile. It keeps its route, expected IP, port, data, and secret references.
- Configuration and lifecycle changes stay with people. See [Stelz as a product](product.md#rules).
- Call order, readiness, and human authentication: [browser skill](../skills/stelz-browser/SKILL.md#do-a-browser-task).
- Conflicts and stale handles: [Troubleshooting](troubleshooting/index.md).
