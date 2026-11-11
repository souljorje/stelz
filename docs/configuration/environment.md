---
title: "Environment and service directory"
description: "Service directory, environment variables, their precedence, and how setup selects the browser executable."
tags: [configuration, reference, setup]
sources: []
created: 2026-11-06T13:49:16Z
modified: 2026-11-11T14:55:54Z
---

# Environment and service directory

## Service directory and precedence

- `STELZ_HOME` selects the service directory. Default: `~/.local/share/stelz`.
- Use an absolute path, so that each CLI, UI, and MCP connection uses the same service. The current project and client PID do not select profile storage.
- Order for settings that use `secrets.env`:
  1. Process environment value (an empty string counts).
  2. `STELZ_HOME/secrets.env`.
  3. The default.
- `STELZ_HOME` and transfer limits use only the process environment.
- Empty `STELZ_HOME` or `CAMOUFOX_EXECUTABLE`: uses its default. Empty typing, IP interval, or location policy value: invalid.
- `secrets.env` is a dotenv-style data file, not a shell script. Keep credentials out of client configuration and reports.

## Environment settings

| Setting | Source | Accepted value and default |
| --- | --- | --- |
| `STELZ_HOME` | Process only | Service directory. Default: `~/.local/share/stelz`. |
| `CAMOUFOX_EXECUTABLE` | Process, then `secrets.env` | Absolute path to the paired Camoufox build. Stelz does not expand `~`. See [Browser executable](#browser-executable). |
| `STELZ_TYPING_MODE` | Process, then `secrets.env` | Typing mode. Default: `keyboard`. See [Typing](typing.md). |
| `STELZ_IP_CHECK_INTERVAL_MS` | Process, then `secrets.env` | Decimal integer from `0` to `120000`, without leading zeros. Default: `120000`. |
| `STELZ_LOCATION_POLICY` | Process, then `secrets.env` | `warn` or `strict`. Default: `warn`. See [Managed location data](network.md#managed-location-data). |
| Name in `proxyEnv` | Process, then `secrets.env` | Proxy URL. See [Supported proxy URLs](../proxies.md#supported-proxy-urls). |
| Name in `expectedIPEnv` | Process, then `secrets.env` | Expected IP. Missing or empty: no constraint. See [Supported proxy URLs](../proxies.md#supported-proxy-urls). |
| `STELZ_TRANSFER_*` | Process only | Transfer limits. See [Profile archive format](archive.md). |

- A running browser gets the executable, network, service typing, and IP interval settings at launch. A change needs stop and start of the profile. Start refuses a changed launch configuration while the previous lifetime is active.
- `HTTP_PROXY` and `HTTPS_PROXY` do not select a profile's route.

## Browser executable

Supported build: only the one that the launcher pairs with, currently `156.0.1-beta.36`.
Setup uses the first available source:

1. The executable in `CAMOUFOX_EXECUTABLE`, if set.
2. Stelz's own copy in `STELZ_HOME/browsers/<version>-<build>/`.
3. The paired build in the upstream Camoufox cache. Setup copies it into `STELZ_HOME/browsers/` and does not change the cache.
4. A download of the paired release. Setup verifies the published SHA-256 digest.

- Another installation of the paired build: set `CAMOUFOX_EXECUTABLE` to the absolute path of the executable inside `Camoufox.app/Contents/MacOS/`, not the `camoufox` command on PATH. Otherwise leave it unset.
- A file that is not the paired build: setup fails and tries no other source. Start also rejects other builds. Stelz does not upgrade a profile's browser.
