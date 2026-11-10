# Manage profiles

Create, start, and manage visible browsers from the local UI.
If Stelz is not ready yet, follow [Getting started](getting-started.md).

## Open or close the manager

Run `stelz ui --open`. The default address is `127.0.0.1:9380`.
Use `--port 9381` for another port. Without `--open`, the command prints a private session URL.
Keep that URL private and keep the command running while you use the UI.
Reload the same browser session to continue. If its session has expired, start the UI again for a new URL.

Select **Turn off UI** or press Ctrl-C in its terminal to stop the manager.
Running browsers and their pages remain open.
Finish active operations first. The UI asks before discarding unsaved edits.

The UI follows your system theme. Choose **System**, **Light**, or **Dark** in Settings to change it.
Your browser saves the choice locally.

## Create and start a profile

1. Open **Profiles** and select **New profile**.
2. Enter `work`, or another unused name with lowercase letters, digits, and hyphens.
3. Leave **Proxy** blank for a direct connection, or paste details from your provider. See [Configure a proxy](proxies.md).
4. Select **Create profile**.
5. Select **Start** when you want its browser to open.

Creation saves the profile without starting a browser.
Select the whole profile row to open its details. Its Start and Stop buttons act independently.
Overview contains connection settings, typing preferences, and browser windows. Device and Logs contain technical information.

**Ready** describes the browser. A controller label describes the current connection, without a persistent agent identity.
Reading status does not claim control.
**Restart to update** means the browser uses an earlier runtime. Run `stelz restart ID`, or stop and start the profile, when you are ready.
A disabled **Start** means the profile has an issue. Inspect its details or Diagnostics before retrying.

## Connect through MCP

Overview shows a shared MCP command and the profile ID for tool arguments.
The command is identical across profiles in the same service directory.
Register `stelz mcp` once. Copy the stable profile ID into `profileId` when selecting a profile through tools.
Acquire with `{profileId}` to receive status and a fresh opaque `controlHandle`.
Use both fields for control actions and browser tools on that connection.
The UI and status summaries never show handles.

Use `profile_list({})` to discover profiles after creation or import. New profiles require no new MCP registration.
See [Connect your agent](clients.md) for setup, or [Shared MCP tools](mcp.md) for the complete contract.

## Take over manually

Use **Pause** before manual authentication or other manual work.
Find the profile's window, complete your work in that same window, then select **Resume**.
The UI does not resume automatically. Resume can require an IP check.

| Control | Result |
| --- | --- |
| Start | Open the selected stopped profile's browser. |
| Stop | Close that browser after current actions finish and retain saved profile data. |
| Pause | Block new agent actions while keeping the browser and controller. |
| Resume | Permit agent actions after manual work and any required IP check. |
| Release controller | Let another agent acquire the profile while keeping the browser open. |
| Recheck IP | Repeat a failed browser-side network check. |

Closing a profile's browser window also stops that profile. Start it explicitly to open it again.
See [Troubleshooting](troubleshooting.md) for failed checks, timeouts, or uncertain process ownership.

## Find a profile's windows

Each window has a title prefix such as `[work]`, plus a profile color and toolbar badge.
Select the badge to read the full profile name. Short badges and colors can repeat, so check the full ID.

Select the window icon beside **Stop** to show the profile's most recent window.
Open its Overview tab for the **Browser windows** list. Select a page to show that page and its window.
Select **Refresh browser windows** if the list changed.
The control is disabled when the window connection is unavailable.

Showing a window preserves its controller. Pause before manual work.
If macOS refuses foreground activation, select the browser manually, then try **Show window** again.
Refresh an old selection after a browser restart or page closure.

## Rename a profile

Select the pencil beside its name. Enter the new display name and select **Save name**.
Escape or **Cancel rename** discards the edit.
You can rename a running profile.
Its ID, data, proxy references, window title prefix, and MCP command remain unchanged.

## Change typing behavior

Open Overview and select **Default typing mode**:

- **Automatic** uses random pauses for shorter text and bulk entry for longer text.
- **Keyboard input** sends individual keystrokes without artificial delays.
- **Instant input** enters the complete text at once.

Changes apply to future typing actions without restarting the browser.
An agent can override the choice for one call.
See [typing configuration](configuration.md#typing) for timing, inheritance, and exact behavior.

## Change a proxy or move profiles

Stop the profile before changing its connection settings.
Follow [Configure a proxy](proxies.md) to set or remove a route and optional expected IP.

Use **Import** and **Export** to move saved profiles.
Read the [transfer warnings and compatibility requirements](profile-transfer.md) before downloading or importing an archive.

## Delete a profile

Stop it cleanly. Open its details and select **Delete profile**.
Type the exact profile ID shown in the confirmation to continue.
Stelz removes it from the list and archives its data under `STELZ_HOME/trash/`.
Shared secret values remain available to other profiles.
Running profiles and profiles with uncertain ownership or an unclean shutdown cannot be deleted.
Follow [safe recovery](troubleshooting.md) before retrying those profiles.

## Inspect a problem

Diagnostics checks installation, browser location, configuration, and process ownership.
Profile details contain bounded server and supervisor logs.
Settings shows the service directory, runtime versions, and the shared MCP command for existing profiles.
The UI does not change your agent's configuration.

For technical session and transaction behavior, see [Architecture](development/architecture.md).
