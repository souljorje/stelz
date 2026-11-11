---
title: "Shared MCP tools"
description: "The 18 fixed MCP tools of stelz mcp, their arguments, and the control-handle contract. Read it to call or integrate the tools."
tags: [mcp, agent, reference]
sources: []
created: 2026-11-06T16:47:49Z
modified: 2026-11-11T14:13:54Z
---

# Shared MCP tools

`stelz mcp` gives one MCP connection 18 fixed tools that control many profiles.
Register it once per client configuration with the same `STELZ_HOME` as the CLI and UI. See [Connect your agent](clients.md).
Each profile permits one browser instance, one controller, and one action queue. Separate profiles can run actions concurrently. Stelz has no agent identities or agent count limits.

## Tools

`tools/list` returns the same 18 tools, including when the profile catalog is empty. Profile creation adds no tools. Call `profile_list({})` for the current catalog.

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

All nine browser tools require `profileId` and `controlHandle` with their Camofox arguments. Read the full schemas through `tools/list`.

| Browser tool | Purpose |
| --- | --- |
| `camofox_create_tab`, `camofox_close_tab` | Open or close a page. |
| `camofox_list_tabs` | Read the tabs that Stelz manages. Tabs that a person opens stay open but are not listed. |
| `camofox_snapshot` | Read a fresh accessibility snapshot. |
| `camofox_click`, `camofox_scroll`, `camofox_navigate` | Click an observed element, scroll, or navigate a tab. |
| `camofox_type` | Enter text. Also accepts `mode`: `balanced`, `keyboard`, or `instant`. See [Typing](configuration.md#typing). |
| `camofox_screenshot` | Capture a tab image. |

`camofox_evaluate` and `camofox_import_cookies` stay excluded. Previously planned browser controls remain [deferred](development/architecture.md#planned-browser-controls).
If a call includes a `progressToken`, Stelz sends a progress notification every 10 seconds until the call ends.
Set your client to reset its request timeout on progress, because some calls, such as `camofox_type`, can take minutes.

## Control handles

- Every successful `profile_acquire` returns a fresh opaque handle. Do not derive it from a profile ID, process ID, agent name, or controller summary.
- Use it only on the connection, profile, and browser lifetime that issued it. Keep one handle for each profile.
- List and status return controller summaries without handles.
- A connection cannot acquire a profile while its previous acquisition is active or pending. Release first.
- Release, disconnect, browser restart, and forced operator handoff invalidate the control. Acquire again, use the new handle, and read fresh browser state.
- Release and disconnect preserve running browsers and open pages. The next connection acquires its own handle.

## Limits of the tools

- Creation never reconfigures an existing profile. It keeps its route, expected IP, port, data, and secret references.
- Use the CLI or UI for configuration, proxies, deletion, import, stop, recovery, and forced handoff.
- For call order, readiness, and human authentication, follow the [browser skill](../skills/stelz-browser/SKILL.md#do-a-browser-task). For conflicts and stale handles, see [Troubleshooting](troubleshooting.md).
