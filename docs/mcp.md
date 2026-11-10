# Shared MCP tools

Register `stelz mcp` once in each client configuration. Use the same `STELZ_HOME` as the CLI and UI.
One connection can control multiple profiles. Each profile permits one browser instance and one controller.
Stelz has no agent identities or agent count limits.
Each profile has its own action queue. Separate profiles can execute actions concurrently.

See [Connect your agent](clients.md) for registration and verification.

## Fixed tool catalog

MCP `tools/list` returns 18 fixed tools, including when the profile catalog is empty.
Profile creation does not add tools or require another registration.
Use `profile_list({})` to read the current catalog after profiles change.

| Profile tool | Arguments | Result and effect |
| --- | --- | --- |
| `profile_list` | `{}` | Read a fresh catalog and profile status. Does not acquire control. |
| `profile_create` | `{profileId}` | Create a direct profile or safely reuse an existing profile unchanged. Leaves a new browser stopped. |
| `profile_start` | `{profileId}` | Explicitly start the selected profile or reuse its safe running lifetime. Does not acquire control. |
| `profile_status` | `{profileId}` | Read profile status and a controller summary. Does not acquire control. |
| `profile_acquire` | `{profileId}` | Acquire exclusive control of a running profile. Return status and a fresh opaque `controlHandle`. |
| `profile_release` | `{profileId, controlHandle}` | Release control after current actions finish. Preserve the browser, pages, and current phase. |
| `profile_pause` | `{profileId, controlHandle}` | Pause browser actions for human work in the same window. Retain control. |
| `profile_resume` | `{profileId, controlHandle}` | Resume after human work and any required IP check. Retain control. |
| `profile_recheck` | `{profileId, controlHandle}` | Repeat the browser IP check. Preserve a pause. |

All nine browser tools require `profileId` and `controlHandle` alongside their existing Camofox arguments:

| Browser tool | Purpose |
| --- | --- |
| `camofox_create_tab` | Open a page. |
| `camofox_list_tabs` | Read the tabs that Stelz manages. Tabs that a person opens stay open but are not listed. |
| `camofox_snapshot` | Read a fresh accessibility snapshot. |
| `camofox_click` | Click an observed element. |
| `camofox_type` | Enter text. |
| `camofox_navigate` | Navigate a tab. |
| `camofox_scroll` | Scroll a page. |
| `camofox_screenshot` | Capture a tab image. |
| `camofox_close_tab` | Close a tab. |

Read the full argument schemas through `tools/list`.
Stelz preserves canonical Camofox browser arguments and adds the required profile and control fields.
`camofox_type` also accepts `mode`: `balanced`, `keyboard`, or `instant`.
See [Typing](configuration.md#typing) for typing behavior.

If a tool call includes a `progressToken`, Stelz sends a progress notification every 10 seconds until the call ends.
Set your client to reset its request timeout on progress, because some calls, such as `camofox_type`, can take minutes.

`camofox_evaluate` and `camofox_import_cookies` remain excluded.
Previously planned browser controls remain [deferred](development/architecture.md#planned-browser-controls).

## Control handles

Every successful `profile_acquire` returns a fresh public handle.
Use that returned value only on the connection, profile, and browser lifetime that issued it.
Treat it as opaque. Do not derive it from a profile ID, process ID, agent name, or controller summary.
Keep the current handle separately for each profile that the connection controls.
List and status return controller summaries without handles.
The connection cannot acquire a profile while its previous acquisition remains active or pending.
Release its current handle before another acquisition.

Release, disconnect, browser restart, and forced operator handoff invalidate the affected control.
Acquire again before further control calls. Use the new handle and read fresh browser state.
Never reuse a handle from another connection, profile, or browser lifetime.
Do not publish handles in reports, configuration, or handoff notes.

## Runtime workflow

1. Call `profile_list({})`.
2. Select the intended stable profile ID.
3. Call `profile_create({profileId})` if the profile is missing.
4. Call `profile_status({profileId})`.
5. Call `profile_start({profileId})` if the browser is stopped.
6. Call `profile_acquire({profileId})`.
7. Retain the returned `controlHandle` with that profile ID.
8. Call `camofox_list_tabs` with both fields.
9. Read a fresh snapshot before selecting an action.
10. Check each action with a fresh observation.
11. Call `profile_release` with both fields when finished or before handoff.

Creation never reconfigures an existing profile. It preserves its route, expected IP, port, data, and secret references.
Use the CLI or UI for configuration, proxies, deletion, import, stop, recovery, and forced handoff.
Acquisition never starts a stopped browser. New profiles need an explicit start.

For human authentication, pause with the profile's current handle.
Wait for the human in the same browser window. Resume with that handle after the human finishes.
Read a fresh snapshot after resume. Do not bypass authentication challenges.

Release and disconnect preserve running browsers and open pages.
Release explicitly before a planned handoff. The next connection acquires its own handle for the existing browser.
Conversation history stays with the previous client.
See [Troubleshooting](troubleshooting.md) for conflicts, stale handles, and uncertain process ownership.
