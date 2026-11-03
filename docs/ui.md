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
The UI asks before discarding unsaved network edits.
Start `stelz ui` again to obtain a new session URL.

For a source checkout, first run `bun run build`.
Then run `bun run ui --open`.
The release archive contains the built UI, including its fonts.
The installed UI requires no development server, remote assets, agent harness, or model credentials.
The HTTP API uses Hono on Bun. The React interface uses the same local session and API routes.

## Local session

The session URL contains a temporary token in its fragment.
The UI exchanges this token for an HttpOnly session cookie and removes the fragment.
Each URL token works once.
Reload the same browser session to continue.
Restart `stelz ui` to obtain another session URL if necessary.

Keep the session URL private.
The UI server accepts only its loopback host and requests from its own origin.
Browser service keys and saved proxy credentials remain on the backend.

## Identity controls

Init creates no preset identities. Existing identities remain unchanged.
Select **New identity** and enter a name.
Supply a proxy URL if necessary. Leave it blank to use a direct connection.
Creation saves the identity without starting a browser.
The service assigns its port and uses a native persistent profile.
You can configure its network later in the Network tab.

The identity table shows browser phase and controller ownership separately.
A ready browser can still have an active MCP controller.
Reading status does not acquire or release a controller.

- **Start** starts the selected stopped identity.
- **Stop** stops its browser after current actions finish.
- **Pause** blocks new actions for human authentication in the same browser window.
- **Resume** permits actions after the human finishes and any required IP check succeeds.
- **Release controller** permits a deliberate handoff and keeps the browser open.
- **Recheck IP** repeats the browser-side network check.

The UI does not resume a paused browser automatically.
Closing its browser window stops the identity. Start it explicitly to open it again.
A failed IP check keeps actions blocked.
An operation timeout can require an explicit stop and start.
See [Use the service](README.md) for process inspection and recovery procedures.

## Delete an identity

Stop the identity cleanly. Open its details and select **Delete identity**.
Type its exact name to confirm deletion.
The service removes the identity from the list and archives its complete directory under `STELZ_HOME/trash/`.
The archive includes its configuration and saved browser profile.
The service retains secret values because other identities can share them.
Running identities, uncertain process ownership, and unclean lifetimes cannot be deleted.
Inspect and recover an unclean lifetime before deleting it.

An interrupted creation or deletion leaves a private transaction record.
The next creation, deletion, network save, or explicit start completes it before continuing.
Read-only status does not change the transaction. Conflicting manual edits block recovery.

## Network configuration

Stop an identity before you edit its network configuration.
Direct mode is the default. A proxy is optional.
Select **Direct (no proxy)** to use the connection without a proxy.
Direct mode requires no IP lookup unless you set an expected exit IP.
The Network tab permits direct or proxy mode, a replacement proxy URL, and an expected exit IP.
A blank replacement proxy field preserves the saved credential.
An empty expected IP removes that check in direct mode.
Proxy mode always requires a successful browser-side IP check.

The UI never shows saved proxy authentication.
Environment overrides make the affected fields read-only.
The UI refuses edits to shared secret references.
A conflicting save requires a fresh configuration before another save.
The backend checks process ownership and configuration again before it writes.

An interrupted save leaves a private transaction record in the service directory.
The next explicit start completes the recorded save or rollback before it starts the browser.
Read-only status does not complete the transaction.
Conflicting manual edits block recovery.
Run `stelz doctor ID` to inspect the failure.

Identity IDs cannot be renamed after creation. Storage mode, saved device properties, and browser versions remain read-only.
All identity state stays under `STELZ_HOME`.
The catalog permits up to 1000 saved identities. The tested active browser limit remains two.

## Diagnostics

The Diagnostics view reports installation, executable, configuration, and process ownership checks.
Identity details contain bounded server and supervisor logs.
The Settings view shows the service directory and runtime versions.
Use the MCP command shown with the same service directory.
The UI does not modify client harness configuration.
