# Use the service

An identity is a stable browser ID. A controller is one MCP client with exclusive access to that identity.

## Requirements

- macOS on Apple Silicon is the tested platform.
- Install Bun 1.3.8 or later.
- Install Node.js 24 or later.
- Keep the existing Camoufox installation.

## Install

1. Install the release archive with `npm install --global ./stelz-0.2.0.tgz`.
2. Run `stelz init`.
3. Edit the identity configuration if necessary.
4. Run `stelz setup`.

Setup copies the published Camofox package into the service directory. It does not clone a repository.
Setup does not change the installed Camoufox app.

The default service directory is `~/.local/share/stelz`.
Set `STELZ_HOME` to use a different directory. Use the same value for all clients and lifecycle commands.
The current directory does not select an identity or a state directory.
The global CLI ignores automatic project `.env` files.

## Configuration

`identities.json` contains two identity entries. Each entry specifies its ID, loopback port, and network mode.
`secrets.env` contains proxy credentials. Keep this file private.

The default configuration requires a proxy for `identity-01`. It explicitly uses direct development mode for `identity-02`.
Set `IDENTITY_01_PROXY_URL` in `secrets.env`. Optionally set `IDENTITY_01_EXPECTED_IP`.
Camofox supports HTTP(S) proxy authentication and unauthenticated SOCKS5.
Authenticated SOCKS5 is not supported.

Stop the identity before you change its network configuration.
The start command rejects changes to an active identity's configuration.
Only loopback hosts bypass a configured proxy. Proxied identities disable WebRTC.
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

## Persistent state

The service stores identity data in `identities/ID/` inside the service directory.

- `storage/` stores cookie, localStorage, and IndexedDB checkpoints.
- `fingerprint.json` stores the generated device configuration and matching Firefox preferences.
- `running.json` records the supervisor and browser service lifetime.

A client PID identifies a controller. It never selects browser storage or fingerprint data.
The service uses the configured ID for the upstream `userId`. It uses the stable `default` tab group.

Saved configuration does not guarantee stable observable output. Canvas hashes varied in earlier restart tests.
Storage checkpoints do not include all Firefox profile data. No automation-detection guarantee applies.

Earlier prototype data remains in the repository's `.state` directory. This release does not silently rename or delete those identities.
