---
title: "Manage profiles"
description: "Operations in the local Stelz UI, for when you open it, create or start a profile, take over a browser, or change a profile."
tags: [ui, profile, browser]
sources: []
created: 2026-11-03T12:47:22Z
modified: 2026-11-11T14:27:18Z
---

# Manage profiles

Local UI for visible browsers. Setup first: [Getting started](getting-started.md).

## Open or close the manager

- Run `stelz ui --open`. Default address: `127.0.0.1:9380`. Port in use: `--port 9381`.
- Without `--open`, open the printed private session URL yourself. Keep it private.
- Keep the command running while you use the UI.
- Reload the same browser session to continue. Expired session: start the UI again for a new URL.
- Stop the manager with **Turn off UI** or Ctrl-C. Running browsers and their pages stay open.

## Create and start a profile

1. Open **Profiles** and select **New profile**.
2. Enter `work`, or another unused name with lowercase letters, digits, and hyphens.
3. Leave **Proxy** blank for a direct connection, or paste provider details. See [Configure a proxy](proxies.md).
4. Select **Create profile**. This saves the profile and starts no browser.
5. Select **Start** to open its browser.

- Select a profile row for its details.
- **Ready**: the browser runs. The controller label shows the current connection.
- **Restart to update**: the browser uses an earlier runtime. See [Update Stelz](getting-started.md#update-stelz).
- Disabled **Start**: the profile has an issue. Read its details or Diagnostics.
- **Location alignment** shows known problems before Start. **Check connection** checks the route without starting a browser. See [Location alignment blocks Start](troubleshooting.md#location-alignment-blocks-start) and [IP check policy](configuration.md#ip-check-policy).
- Browser windows show Camoufox's pink cursor marker. The marker can stop at the page boundary.
- Overview shows the shared MCP command and the `profileId`. See [Connect your agent](clients.md).

## Take over manually

1. Select **Pause**.
2. [Find the profile's window](#find-a-profiles-windows). Do your work there.
3. Select **Resume**. The UI does not resume by itself. Resume can need an IP check.

| Button | Action |
| --- | --- |
| Stop | Stop the browser. |
| Pause | Pause agent actions. |
| Resume | Resume agent actions. |
| Release | Release the controller. |
| Recheck IP | Repeat a failed IP check. |

- Closing a profile's browser window stops that profile. Start it again explicitly.
- Choice of action and failures: [Troubleshooting](troubleshooting.md#choose-the-lifecycle-action).

## Find a profile's windows

- Each window has a title prefix such as `[work]`, a profile color, and a toolbar badge.
- Badges and colors can repeat. Select the badge to read the full profile ID.
- Window icon beside **Stop**: shows the profile's focused window, or its first window if none has focus.
- Overview, **Browser windows**: select a page to show it and its window. **Refresh browser windows** updates the list.
- Showing a window keeps its controller. Pause before manual work.
- macOS refuses foreground activation: select the browser manually, then select **Show window** again.

## Rename a profile

- Select the pencil beside the name, enter the new name, select **Save name**. A running profile can be renamed.
- ID, data, proxy references, window title prefix, and MCP command stay the same.

## Change typing behavior

Overview, **Default typing mode**: **Balanced**, **Keyboard input** (service default), or **Instant input**.
Changes apply to later typing actions without a restart. See [Typing](configuration.md#typing).

## Change a proxy or move profiles

- Stop the profile before you change its connection settings. See [Configure a proxy](proxies.md).
- **Import** and **Export**: see [Transfer profiles](profile-transfer.md).

## Delete a profile

1. Stop the profile cleanly.
2. Open its details and select **Delete profile**.
3. Type the exact profile ID.

- Stelz archives its data under `STELZ_HOME/trash/`. Other profiles keep shared secret values.
- Running profiles, profiles with uncertain ownership, and profiles with an unclean shutdown cannot be deleted. See [Troubleshooting](troubleshooting.md).

## Inspect a problem

- Diagnostics: installation, browser location, configuration, process ownership.
- Profile details: bounded server and supervisor logs.
- Settings: service directory, runtime versions, shared MCP command.
