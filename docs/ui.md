# Use the local UI

Run `stelz ui --open` after installation.
The command serves the UI at `127.0.0.1:9380` and opens its session URL.
Use `--port PORT` to select another loopback port.
Without `--open`, the command prints the session URL.

Keep the command running while you use the UI.
Press Ctrl-C to stop the UI server.
The browsers and their open pages remain active.
Select **Turn off UI** in the header to end the UI session and stop its server.
The button also expires the session cookie. Running browsers stay open.
Finish active UI operations before using the button.
The UI asks before discarding unsaved edits.
Start `stelz ui` again to obtain a new session URL.

For a source checkout, first run `bun run build`.
Then run `bun run ui --open`.
The release archive contains the built UI, including its fonts.
The installed UI requires no development server, remote assets, agent harness, or model credentials.
The HTTP API uses Hono on Bun. The React interface uses the same local session and API routes.

## Theme

The UI follows the system theme by default, including changes while it is open.
Select **System**, **Light**, or **Dark** in Settings.
Your browser saves this choice locally.

## Local session

The session URL contains a temporary token in its fragment.
The UI exchanges this token for an HttpOnly session cookie and removes the fragment.
Each URL token works once.
Reload the same browser session to continue.
Restart `stelz ui` to obtain another session URL if necessary.

Keep the session URL private.
The UI server accepts only its loopback host and requests from its own origin.
Browser service keys and saved proxy credentials remain on the backend.

## Profile controls

Init creates no preset profiles. Existing profiles remain unchanged.
Open **Profiles**. Select **New profile** and enter a name.
Supply a proxy URL if necessary. Leave it blank to use a direct connection.
Creation saves the profile without starting a browser.
The service assigns its port and uses a native persistent profile.
Overview contains its connection settings, typing preferences, and browser windows.
Device and Logs contain the technical information.

The profile table shows browser phase and controller ownership separately.
A ready browser can still have an active MCP controller.
Reading status does not acquire or release a controller.
Select a profile row to open its details. Start and Stop buttons act independently.
Profile details show applicable lifecycle actions.
For a stopped profile, Start stays visible and disabled when unavailable.
Deletion is available only for a cleanly stopped profile.

- **Start** starts the selected stopped profile.
- **Stop** stops its browser after current actions finish.
- **Pause** blocks new actions for human authentication in the same browser window.
- **Resume** permits actions after the human finishes and any required IP check succeeds.
- **Release controller** permits a deliberate handoff and keeps the browser open.
- **Recheck IP** repeats the browser-side network check.

The UI does not resume a paused browser automatically.
Closing its browser window stops the profile. Start it explicitly to open it again.
A failed IP check keeps actions blocked.
An operation timeout can require an explicit stop and start.
See [Use the service](README.md) for process inspection and recovery procedures.

## Rename a profile

Select the pencil beside the profile name. Enter the new name and select **Save name**.
Escape or **Cancel rename** discards the edit.
The name updates in the profile list and heading. It can change while the browser is running.
The profile ID, saved data, proxy references, and MCP commands remain unchanged.
Browser window title prefixes continue to show the stable profile ID.

## Import and export

Use **Import** or **Export** in the Profiles heading to transfer one or more profiles as a ZIP archive.
Export requires cleanly stopped profiles. Import previews destination IDs and display names before saving the selected batch.
The archive includes saved logins and available proxy credentials. Keep it private.
See [Import and export profiles](profile-transfer.md) for compatibility requirements and CLI commands.

## Typing mode

Open a profile's Overview tab. Select **Default typing mode** under **Typing**:

- **Automatic** uses random pauses for text with an estimated typing duration of at most 10 seconds. Longer text uses bulk entry.
- **Keyboard input** sends individual keystrokes without artificial delays.
- **Instant input** enters the complete text at once.

Changes save automatically and apply to future typing actions without a browser restart.
The selector shows the profile's effective mode. Profiles without an override use the service setting until you choose another mode.
Typing changes preserve unsaved network edits. Pending profile operations temporarily disable the selector.
The setting applies only to the selected profile. Each agent can override it with the `camofox_type` tool's `mode` argument.

## Find a profile's windows

Each browser window uses its profile's color and a title prefix, such as `[profile-02]`.
The toolbar badge shows the short profile label. Select the badge to read the full profile name.
The profile table and detail heading use the same color and label.
Website titles and page content remain unchanged.

Camofox tools call pages tabs. A tab can appear in a separate native window within the same profile.
Use the full title prefix to identify the profile. Short badges and colors can repeat.
The profile color identifies the profile. The status dot shows the browser phase.

Select the window icon beside **Stop** to show that profile's most recent window.
The control is disabled when the window connection is unavailable.
Open a running profile's Overview tab to see its **Browser windows** list.
Select a page in the list to show that page and its window.
The service restores a minimized window before it shows the page.
macOS can refuse foreground activation from a background service.
If this occurs, select the profile's browser manually. Then select **Show window** again.
The list updates while the Overview tab is visible. Select **Refresh browser windows** for an immediate update.

Showing a window keeps the current controller and browser lifetime.
Pause the profile before manual authentication or other manual work.
An old window selection fails if the browser restarts or the page closes.
Refresh the list before you select the window again.

After a source update, apply the browser labels and window controls:

1. Stop all profiles.
2. Run `bun run build` in the source checkout.
3. Run `bun run setup` with the same `STELZ_HOME`.
4. Start each profile explicitly.

For an installed release, stop all profiles. Update the package.
Run `stelz setup` with the same `STELZ_HOME`.
For new profiles, the service creates its private add-on under `STELZ_HOME/profiles/ID/window-addon/`.
Existing state paths remain supported. See [Compatibility](README.md#compatibility).
The add-on communicates only with that profile's authenticated loopback service.
The installed Camoufox app remains unchanged.

## Delete a profile

Stop the profile cleanly. Open its details and select **Delete profile**.
Type its exact profile ID, shown above the confirmation field, to confirm deletion.
The service removes the profile from the list and archives its complete directory under `STELZ_HOME/trash/`.
The archive includes its configuration in `profile.json` and its saved browser data in `profile/`.
The service retains secret values because other profiles can share them.
Running profiles, uncertain process ownership, and unclean lifetimes cannot be deleted.
Inspect and recover an unclean lifetime before deleting it.

An interrupted creation or deletion leaves a private transaction record.
The next creation, deletion, network save, or explicit start completes it before continuing.
Read-only status does not change the transaction. Conflicting manual edits block recovery.

## Network configuration

Stop a profile before you edit its network configuration.
A proxy is optional. An empty **Proxy URL** uses a direct connection.
The **Connection** section in Overview shows the saved proxy address and optional expected exit IP.
Change the address to replace the proxy. Clear it and save to remove the proxy.
An unchanged address preserves its saved authentication, including when you change only the expected IP.
These fields are visible without opening a disclosure or selecting a connection mode.
A direct connection requires no IP lookup unless you set an expected exit IP.
An empty expected IP removes that requirement for a direct connection.
A proxy connection always requires a successful browser-side IP check.

The UI never shows saved proxy authentication.
Environment overrides and shared secrets keep their values read-only.
**Remove proxy** disconnects this profile from a managed proxy. It preserves the secret for other profiles.
A conflicting save requires a fresh configuration before another save.
The backend checks process ownership and configuration again before it writes.

An interrupted save leaves a private transaction record in the service directory.
The next explicit start completes the recorded save or rollback before it starts the browser.
Read-only status does not complete the transaction.
Conflicting manual edits block recovery.
Run `stelz doctor ID` to inspect the failure.

Display names are editable. Profile IDs, storage mode, saved device properties, and browser versions remain read-only.
All profile state stays under `STELZ_HOME`.
The service has no saved-profile count limit or global active-browser limit.
Each profile has at most one browser instance. Other running profiles do not disable Start.

## Diagnostics

The Diagnostics view reports installation, executable, configuration, and process ownership checks.
Profile details contain bounded server and supervisor logs.
The Settings view shows the service directory and runtime versions.
Use the MCP command shown with the same service directory.
The UI does not modify client harness configuration.
