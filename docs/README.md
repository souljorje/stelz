# Use the service

A profile has a stable browser ID. A controller is one MCP client with exclusive access to that profile.

## Requirements

- macOS on Apple Silicon is the tested platform.
- Install Bun 1.3.8 or later.
- Install Node.js 24 or later.
- Keep the existing Camoufox installation.

## Install

1. Install the release archive with `npm install --global ./stelz-0.2.0.tgz`.
2. Run `stelz init`.
3. Run `stelz setup`.
4. Run `stelz ui --open`.
5. Create a profile. Configure a proxy if necessary, then start it.

Setup copies the published Camofox package into the service directory. It does not clone a repository.
Setup does not change the installed Camoufox app.
Stop all profiles before setup after a code update.
Setup stages and checks the complete runtime before it replaces the active runtime.
See [Camofox adapter patches](camofox-patches.md) for the eight pinned compatibility changes.

For a source installation, run `bun install --frozen-lockfile` and `bun run build` at the workspace root.
Run `npm pack ./packages/stelz` to create the release archive.
Only `packages/stelz` is publishable. The UI workspace is private.
See [Distribution](distribution.md) for archive verification and the manual workflow.

The default service directory is `~/.local/share/stelz`.
Set `STELZ_HOME` to use a different directory. Use the same value for all clients and lifecycle commands.
The current directory does not select a profile or a state directory.
The global CLI ignores automatic project `.env` files.

## Configuration

`profiles.json` contains `maxActive` and a `profiles` array.
Each profile specifies its ID, loopback port, network mode, and storage mode.
See [profiles.json](../examples/profiles.json) for an empty configuration.
`secrets.env` contains proxy credentials. Keep this file private.

Init creates an empty profile list. It never overwrites existing entries.
Use **New profile** in the UI to create a named profile with an optional proxy.
The service assigns a free loopback port. New profiles use `storage: "native"`.
A profile uses a direct connection unless you supply a proxy.
The catalog permits up to 1000 saved profiles. At most two browsers can be active.
Existing entries without a `storage` field keep `checkpoint` mode. Init never overwrites them.
Select Proxy in the UI to configure a proxy for a stopped profile.
For manual proxy configuration on a new profile, set `mode: "proxy"` and `proxyEnv: "PROFILE_01_PROXY_URL"`.
Set `PROFILE_01_PROXY_URL` in `secrets.env`.
Optionally set `expectedIPEnv: "PROFILE_01_EXPECTED_IP"` and its value in `secrets.env` to require a specific exit IP.
Camofox supports HTTP(S) proxy authentication and unauthenticated SOCKS5.
Authenticated SOCKS5 is not supported.

Stop the profile before you change its network or storage configuration.
The start command rejects changes to an active profile's configuration.
Only loopback hosts bypass a configured proxy. Proxied profiles disable WebRTC.
Current browser policy overrides saved device data. A legacy direct-mode pin cannot re-enable WebRTC in proxy mode.
Proxy policy disables direct failover and enables DNS resolution through SOCKS proxies.
Browser-side IP checks reject failed proxies and unexpected IP addresses.
Checks use ipify, with Cloudflare trace as an independent fallback for unavailable or invalid responses.
A valid unexpected IP fails immediately. The service does not try another provider after an IP mismatch.
All checks run inside the selected browser through its configured route.
Direct mode does not require an IP check unless the profile specifies an expected IP.
Startup, resume, and explicit recheck require a fresh check.
Reported proxy, DNS, and connection failures invalidate cached verification and require a fresh check in the same action queue.
The service does not replay the failed browser action.
Other browser actions reuse a successful check for at most two minutes.
The first action after expiry requires a fresh check. Idle browsers do not poll IP services.
Proxy routing remains mandatory while the service caches verification. External requests fail when the proxy route fails.
Local snapshots and tab lists can succeed during that interval without an external request.
Status reports the last check time and the configured `verificationIntervalMs`.
`verificationStatus` records `unverified`, `verified`, or `verification_failed`, separately from the browser phase.
`verificationFresh` reports whether the next action can reuse the result.
An expired result remains the last observed verdict. The next browser action must verify again.
`verificationRequired` is false only for direct profiles without an expected IP.

Set `STELZ_IP_CHECK_INTERVAL_MS` in `secrets.env` to select an integer from `0` to `120000`.
The default is `120000`. Value `0` requires a fresh check before each browser action.
An environment variable overrides the file value. Stop and start the profile to apply changes.
The cache belongs to one browser lifetime. A restart never reuses a previous successful check.
Periodic checks bound the age of observed IP evidence. They do not guarantee continuous IP stability.
IP verification checks network health. It does not enforce proxy routing or provide a network kill switch.
Browser proxy settings enforce the configured route.
Host firewall or container egress rules may also be necessary for unattended use.
Such rules must restrict browser outbound traffic to approved proxy endpoints and required local services.
stelz does not install host firewall or container egress rules.
After a failed check, correct the network and run `stelz recheck ID`.
If the profile remains paused, resume it after the recheck succeeds.
These settings do not change client LLM traffic.

## Compatibility

Existing `identities.json` files with an `identities` array and state under `identities/ID/` remain supported.
The service does not require a move of running browser data.
The legacy `--identity` option and `identity_*` MCP tools remain supported aliases.

Existing IDs, such as `identity-01`, remain unchanged. Keep configured secret references unchanged.
The `profile-01` IDs and `PROFILE_01_*` secret names in examples are suggestions for new configuration.

## Typing

The `camofox_type` tool enters text one character at a time by default, with variable timing and short pauses.
The service enters the exact requested text. It does not add deliberate errors.
Typing replaces existing field contents. Empty text clears the field.
Date and similar controls keep their specialized input behavior.
All MCP clients use the same service setting. Their tool arguments do not change.

For bulk entry, set `STELZ_TYPING_MODE=instant` in the service's `secrets.env` file.
The default value is `paced`. An environment variable overrides the file value.
Stop the profile before you change this setting. Start it again to apply the setting.
Paced input rejects text that requires more than 30 seconds of planned typing before it changes the field.
Use instant mode for larger inputs. The existing 60-second browser action limit still applies.
If typing stops with incomplete input, read a fresh snapshot before another action. The service does not replay the text.

## Commands

| Command | Effect |
| --- | --- |
| `stelz ui [--port PORT] [--open]` | Serve the local profile UI. The default port is 9380. |
| `stelz start profile-02` | Start one visible browser. |
| `stelz start all` | Start configured profiles, subject to the active browser limit. |
| `stelz status` | Read state and current controller information. |
| `stelz doctor [ID]` | Inspect configuration, process ownership, and service status. |
| `stelz logs ID [--lines 1-500]` | Read bounded server and supervisor logs. |
| `stelz release profile-02` | Release the controller after current actions finish. Keep the browser open. |
| `stelz pause profile-02` | Block new browser actions. Keep the controller and browser. |
| `stelz resume profile-02` | Resume actions after any required IP check. |
| `stelz recheck profile-01` | Repeat a failed IP check without replacing the browser. |
| `stelz stop all` | Stop active configured browsers cleanly. Keep their saved state. |
| `stelz recover profile-02` | Archive an unclean lifetime after its recorded processes exit. |

See [Use the local UI](ui.md) for UI sessions, lifecycle controls, and network edits.

A profile can have several native windows. Their title prefixes, colors, and toolbar badges identify the profile.
The UI can show a window without changing its controller.
See [Find a profile's windows](ui.md#find-a-profiles-windows).

MCP cannot implicitly start a stopped browser. Start it with the CLI or UI first.
A disconnected client cannot stop the browser through process-group cleanup. The browser supervisor runs separately.
An unclean service exit blocks a replacement start.
If the supervisor exits while its server remains active, status reports `orphaned`.
Run `stelz doctor ID` to inspect the recorded processes. Run `stelz stop ID` to stop the server.
Check for browser processes that outlived the server. Recovery cannot check browser descendants.
Then run `stelz recover ID` to archive the unclean lifetime. Recovery refuses live processes and unknown ownership.
If ownership is unknown, inspect the processes before you take further action.
After an upgrade, `stelz stop ID` can stop a legacy service through its authenticated endpoint.
The profile configuration must match its recorded start configuration.
The command checks the saved profile and service instance. It never signals unverified PIDs.
A clean-stop receipt does not override live PIDs with unknown ownership.
Closing a browser window stops its profile. The UI reports Stopped after shutdown.
Start the profile explicitly when you need it again.
Upstream browser restart or session replacement still blocks the service lifetime.
Stop and start a blocked profile explicitly. An interrupted task is not automatically replayed.

The service limits each browser action or IP check to 60 seconds.
If an operation exceeds that limit, browser actions remain blocked because the operation may still be active.
Stop and start the profile before you continue. Release, pause, and stop wait for the bounded operation.
An MCP client timeout does not cancel an operation in the service.

## Persistent state

The service stores new profile data in `profiles/ID/` inside the service directory.
Existing state paths remain supported. See [Compatibility](#compatibility).

- `browser-data/` is the native Firefox profile in native mode. The agent controls that same persistent context.
- `native-profile.json` marks a native profile. The service refuses to replace native data with potentially stale checkpoints.
- `storage/` stores cookie, localStorage, and IndexedDB checkpoints in legacy checkpoint mode only.
- `fingerprint.json` stores generated device properties. New pins use schema 2. Schema 1 pins remain readable and are not rewritten.
- `running.json` records the supervisor and browser service lifetime.
- `window-addon/` contains the generated browser add-on for profile labels and window controls.

A client PID identifies a controller. It never selects browser storage or fingerprint data.
The service uses the configured ID for the upstream `userId`. It uses the stable `default` tab group.

Native mode does not restore snapshots over an existing profile. A checkpoint profile cannot silently become a fresh native profile:
startup refuses this change if saved checkpoints exist. Keep `storage: "checkpoint"` for that profile or create a new native profile.
Automated conversion of existing checkpoints is not part of this change. No conversion deletes or renames saved data.
An existing `browser-data/` directory also prevents checkpoint mode if the native marker is missing.
If a marked native profile loses its browser-data directory, startup fails. Restore the original directory before starting that profile.

Saved device properties do not override current language, location, add-on paths, session history, or Firefox security preferences.
WebGL2 support follows the saved GPU properties. Fresh GPU samples cannot change this capability after restart.
Changing the browser executable still requires an explicit migration. This release has no command to migrate browser versions.
Saved configuration does not guarantee stable observable output. Canvas hashes varied in earlier restart tests.
No automation-detection guarantee applies.
