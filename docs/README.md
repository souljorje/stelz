# Use the service

An identity is a stable browser ID. A controller is one MCP client with exclusive access to that identity.

## Requirements

- macOS on Apple Silicon is the tested platform for the 0.2.0 baseline.
- Install Bun 1.3.8 or later.
- Install Node.js 24 or later.
- Keep the existing Camoufox installation.

See [review fixes and validation limits](review-fixes.md) for the changes after that baseline.

## Install

1. Install the release archive with `npm install --global ./stelz-0.2.0.tgz`.
2. Run `stelz init`.
3. Edit the identity configuration if necessary.
4. Run `stelz setup`.

Setup copies the published Camofox package into the service directory. It does not clone a repository.
Setup does not change the installed Camoufox app.
Stop all identities before setup after a code update.

The default service directory is `~/.local/share/stelz`.
Set `STELZ_HOME` to use a different directory. Use the same value for all clients and lifecycle commands.
The current directory does not select an identity or a state directory.
The global CLI ignores automatic project `.env` files.

## Configuration

`identities.json` contains two identity entries. Each entry specifies its ID, loopback port, network mode, and storage mode.
`secrets.env` contains proxy credentials. Keep this file private.

The default configuration requires a proxy for `identity-01`. It explicitly uses direct development mode for `identity-02`.
New configurations use `storage: "native"` for both identities.
Existing entries without a `storage` field keep `checkpoint` mode. Init never overwrites them.
Set `IDENTITY_01_PROXY_URL` in `secrets.env`. Optionally set `IDENTITY_01_EXPECTED_IP`.
Camofox supports HTTP(S) proxy authentication and unauthenticated SOCKS5.
Authenticated SOCKS5 is not supported.

Stop the identity before you change its network or storage configuration.
The start command rejects changes to an active identity's configuration.
Only loopback hosts bypass a configured proxy. Proxied identities disable WebRTC.
Current launch policy overrides saved device data; a legacy direct-mode pin cannot re-enable WebRTC in proxy mode.
Browser-side IP checks reject failed proxies and unexpected IP addresses. There is no direct fallback.
These settings do not change client LLM traffic.

## Commands

| Command | Effect |
| --- | --- |
| `stelz start identity-02` | Start one visible browser. |
| `stelz start all` | Start both configured identities. |
| `stelz status` | Read state and current controller information. |
| `stelz release identity-02` | Release the controller after current actions finish. Keep the browser open. |
| `stelz pause identity-02` | Block new browser actions. Keep the controller and browser. |
| `stelz resume identity-02` | Check the exit IP before actions resume. |
| `stelz stop all` | Stop both browsers cleanly. Keep their saved state. |

MCP cannot implicitly start a stopped browser. Start it with the CLI first.
A disconnected client cannot stop the browser through process-group cleanup. The browser supervisor runs separately.
An unclean service exit blocks a replacement start. Check the recorded processes before you archive the identity's `running.json`.
Unexpected browser or context loss blocks the service lifetime. Upstream recovery cannot clear the block or create another context.
Stop and start the identity explicitly. An interrupted task is not automatically replayed.

## Persistent state

The service stores identity data in `identities/ID/` inside the service directory.

- `browser-data/` is the native Firefox profile in native mode. The agent controls that same persistent context.
- `native-profile.json` marks a native identity. Switching it back to potentially stale checkpoints is refused.
- `storage/` stores cookie, localStorage, and IndexedDB checkpoints in legacy checkpoint mode only.
- `fingerprint.json` stores generated device properties. New pins use schema 2. Schema 1 pins remain readable and are not rewritten.
- `running.json` records the supervisor and browser service lifetime.

A client PID identifies a controller. It never selects browser storage or fingerprint data.
The service uses the configured ID for the upstream `userId`. It uses the stable `default` tab group.

Native mode does not restore snapshots over an existing profile. A checkpoint identity cannot silently become a fresh native identity:
startup refuses this change if saved checkpoints exist. Keep `storage: "checkpoint"` for that identity or create a new native identity.
Automated conversion of existing checkpoints is not part of this change. No conversion deletes or renames saved data.

Saved device properties do not override current language, location, add-on paths, session history, or Firefox security preferences.
Changing the browser executable still requires an explicit migration; no browser-version migration command is added here.
Saved configuration does not guarantee stable observable output. Canvas hashes varied in earlier restart tests.
No automation-detection guarantee applies.

Earlier prototype data remains in the repository's `.state` directory. This release does not silently rename or delete those identities.
