---
title: "Manage profiles"
description: "Operations in the local Stelz UI: open it, create and start profiles, find windows, take over manually, set typing, delete, and inspect."
tags: [ui, profile, browser]
sources: []
created: 2026-11-03T12:47:22Z
modified: 2026-11-11T14:13:54Z
---

# Manage profiles

Create, start, and manage visible browsers from the local UI. To set up first, see [Getting started](getting-started.md).

## Open or close the manager

Run `stelz ui --open`. The default address is `127.0.0.1:9380`. If that port is occupied, use `--port 9381`.
The command prints a private session URL. Without `--open`, open that URL yourself. Keep that URL private and keep the command running.
Reload the same browser session to continue. If its session expired, start the UI again for a new URL.
Select **Turn off UI** or press Ctrl-C to stop the manager. Running browsers and their pages remain open.

## Create and start a profile

1. Open **Profiles** and select **New profile**.
2. Enter `work`, or another unused name with lowercase letters, digits, and hyphens.
3. Leave **Proxy** blank for a direct connection, or paste details from your provider. See [Configure a proxy](proxies.md).
4. Select **Create profile**.
5. Select **Start** when you want its browser to open.

Creation saves the profile without starting a browser. Select a profile row to open its details.
**Ready** means the browser runs. A controller label shows the current connection.
Browser windows show Camoufox's pink cursor marker. The marker can stop at the page boundary.
**Restart to update** means the browser uses an earlier runtime. Run `stelz restart ID` when you are ready.
A disabled **Start** means the profile has an issue. Inspect its details or Diagnostics.
For a proxy, **Location alignment** shows known problems before Start, and **Check connection** checks the route without starting a browser.
Start always checks the route again. **Ready to start** does not mean that a browser runs.
See [Location alignment blocks Start](troubleshooting.md#location-alignment-blocks-start).

Overview shows the shared MCP command and the `profileId`. See [Connect your agent](clients.md).

## Take over manually

1. Select **Pause** before manual authentication or other manual work.
2. [Find the profile's window](#find-a-profiles-windows) and do your work in that window.
3. Select **Resume**. The UI does not resume automatically. Resume can require an IP check.

| Control | Result |
| --- | --- |
| Stop | Close that browser after current actions finish and retain saved profile data. |
| Pause | Block new agent actions while keeping the browser and controller. |
| Resume | Permit agent actions after manual work and any required IP check. |
| Release | Let another agent acquire the profile while keeping the browser open. |
| Recheck IP | Repeat a failed browser-side network check. |

Closing a profile's browser window also stops that profile. Start it explicitly to open it again.
For failed checks, timeouts, or uncertain process ownership, see [Troubleshooting](troubleshooting.md).

## Find a profile's windows

Each window has a title prefix such as `[work]`, plus a profile color and toolbar badge.
Short badges and colors can repeat. Select the badge to read the full profile ID.

Select the window icon beside **Stop** to show the profile's focused window, or its first window if none has focus.
Open Overview and its **Browser windows** list to show a specific page and its window. Select **Refresh browser windows** if the list changed.
Showing a window preserves its controller. Pause before manual work.
If macOS refuses foreground activation, select the browser manually, then select **Show window** again.

## Rename a profile

Select the pencil beside its name, enter the new name, and select **Save name**. You can rename a running profile.
Its ID, data, proxy references, window title prefix, and MCP command stay the same.

## Change typing behavior

Open Overview and select **Default typing mode**:

- **Balanced** uses paced typing for shorter text and bulk entry for longer text.
- **Keyboard input** uses variable pauses and occasional corrected typos. One input can take up to 3 minutes. This is the service default.
- **Instant input** enters the complete text at once.

Changes apply to future typing actions without a restart. An agent can override the choice for one call.
See [Typing](configuration.md#typing).

## Change a proxy or move profiles

Stop the profile before you change its connection settings. See [Configure a proxy](proxies.md).
To move saved profiles with **Import** and **Export**, see [Transfer profiles](profile-transfer.md).

## Delete a profile

Stop the profile cleanly. Open its details, select **Delete profile**, and type the exact profile ID.
Stelz archives its data under `STELZ_HOME/trash/`. Shared secret values remain available to other profiles.
Running profiles and profiles with uncertain ownership or an unclean shutdown cannot be deleted. See [Troubleshooting](troubleshooting.md).

## Inspect a problem

Diagnostics checks installation, browser location, configuration, and process ownership.
Profile details contain bounded server and supervisor logs. Settings shows the service directory, runtime versions, and the shared MCP command.
