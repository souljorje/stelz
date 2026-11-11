---
title: "Camofox integration"
description: "Pinned dependencies, compatibility patches, location preparation, setup activation, and native dependencies of the Camofox server. Read before you change a dependency patch or upgrade a pin."
tags: [development, camofox]
sources: []
created: 2026-11-06T13:49:16Z
modified: 2026-11-11T14:13:54Z
---

# Camofox integration

Camofox is the HTTP automation server that controls the Camoufox browser through Playwright.
Stelz patches it and adds persistent profile ownership and exclusive MCP control. See [Architecture](architecture.md) for the request path.

## Pinned dependencies and patches

Bun applies committed patches from `patches/` during workspace installation.
The root `package.json` pins Camofox (`@askjo/camofox-browser`) to `1.18.1` and the official `camoufox` launcher to `0.5.8`.
The Camofox patch changes its launcher dependency to that version, so no override is necessary.
`src/versions.ts` records the upstream source commit.

Setup checks each patched location in the prepared source (`src/browser/camofox-adapter.ts`).
It fails when a patch is missing, duplicated, or changed. It does not rewrite the source.
The patches cover eighteen areas:

| Area | What the patch does |
| --- | --- |
| Locator fill and type route | Forwards each call's typing mode. Supports balanced pacing, keyboard events, and bulk entry. |
| Scroll tab activation | Activates the selected native tab and moves the pointer to the viewport center before it sends wheel input. Keeps the tab lock and deadline. |
| Click retry guard | Checks the target with a trial click that sends no input. Falls back to a forced, DOM, or mouse click only when that check fails. A failure after input returns a non-retryable conflict that asks for a fresh snapshot. |
| Orphan page reaper | Closes only pages that Camofox created, registered, or tried to close. Pages that a person or a website opens stay open. |
| Browser health probe | Disables the probe. Its test context opens a visible window, and a failure only requests a replacement browser, which Stelz refuses. |
| Official launcher import | Imports `Camoufox`, `launchOptions`, and `VirtualDisplay` from `camoufox`. |
| Virtual display | Passes the 1280x720x24 screen to the official display, which removes its own X lock and socket files on kill. Drops the Camofox cleanup code. |
| External executable shim | Disables the Camofox executable shim, which writes `version.json` into the shared Camoufox cache. The plugin passes the executable to the launcher. |
| Bundled downloader | Removes `postinstall.js`, `lib/camoufox-download.js`, and their scripts. Browser installation stays explicit. |
| Launch options | Prepares launch options through the plugin. Replaces the GeoIP retry, so a failed proxied launch never retries without GeoIP. |
| Geolocation permission | Grants no geolocation permission to the context of a proxied browser. |
| Window and screen bounds | Preserves the explicit desktop window and screen policy. |
| Proxy WebRTC policy | Disables WebRTC for proxied browsers. |
| Browser start | Uses persistent profile and saved device handling. |
| Context claim | Reuses the selected persistent profile context. |
| Initial page claim | Registers the original blank page as the first managed tab. Protects startup with page leases and a separate initialization deadline. |
| New page creation | Creates each new page through the plugin, which first hands out the original blank page. |
| Native persistence guard | Keeps Firefox in charge of persistent browser data. |

Typing keeps the tab lock until input finishes. A typing timeout returns a terminal error without a retry instruction.
The caller must inspect fresh state. The service does not replay incomplete input. See [Failures and network policy](architecture.md#failures-and-network-policy).
Remove a patch only when upstream provides the same behavior and the replacement passes regression tests and browser acceptance.

## Change a dependency patch

1. Run `bun install --frozen-lockfile --ignore-scripts` at the repository root.
2. Run `bun patch PACKAGE@VERSION` for the pinned dependency.
3. Edit the prepared dependency.
4. Run `bun patch --commit PACKAGE@VERSION --ignore-scripts`.
5. Include the generated patch, root manifest, and Bun lockfile in the change.
6. Run `bun run check` and the relevant checks from [Testing](testing.md) and [Acceptance](acceptance.md).

Keep exact versions until a separate compatibility review approves an upgrade.
Only `src/browser/camoufox.ts` imports `camoufox` internals. Its unit test fails when an upgrade removes one of them.
Update `src/browser/camofox-adapter.ts` when a required patched location changes.

## Location preparation

Stelz checks the proxy exit IP itself (`src/runtime/public-ip.ts`) and reads the managed MaxMind database itself.
The official helpers memoize results per proxy, cannot be cancelled, have no error codes, and download into the shared cache.
Stelz passes `geoip: false` to the launcher and merges the prepared location into `config`.
It removes `permissions.default.geo`, so coordinates never grant website permission.
Camofox cannot retry a failed proxied launch with GeoIP disabled.

The lifecycle path checks current inputs before reservation and again before server launch.
A per-profile lock serializes checks. Network requests do not hold the global admission lock.
Configuration changes invalidate old results.
The plugin verifies IP, timezone, and languages before Ready. It checks geolocation as configured, not observed.
See [Managed location data](../configuration.md#managed-location-data) and [IP check policy](../configuration.md#ip-check-policy).

## Runtime setup

Setup locates the installed packages. It does not download or patch upstream source.
It prepares the paired browser, the location data, and the official pinned fingerprint model. See [Run setup](../getting-started.md#2-run-setup).
Start refuses to launch without the fingerprint model and never downloads.
Setup reads the upstream Camoufox cache only. It never calls upstream code that writes or prunes that cache.

Setup copies Camofox files, the launcher, and the compiled Stelz plugin into a staged runtime generation.
Other dependency links resolve to the supplying package installation. Keep that installation available while the runtime uses it.
Symlinks in copied source block setup.
Staging checks cover prepared patch matches, exported contracts, plugin functions, and Node syntax. Setup checks the complete runtime before activation.
`versions.json` records package and dependency versions, the upstream source commit, the browser path, and its executable hash.
See [Source layout and runtime updates](architecture.md#source-layout-and-runtime-updates) for generations and cleanup.
To apply an update, see [Update Stelz](../getting-started.md#update-stelz) or [Run Stelz from a checkout](../../CONTRIBUTING.md#run-stelz-from-a-checkout).

## Native dependencies

`better-sqlite3` and `impit` are direct dependencies of the Stelz root package at pinned versions.
The bundled Camofox manifests delegate native dependency installation to that package, so ordinary npm installation supplies native packages for the target machine.
Setup links them into the staged runtime. The ZIP libraries `yazl` and `yauzl` also install as ordinary runtime dependencies.
Installation with lifecycle scripts disabled does not establish native-addon execution. See [Installed-package acceptance](acceptance.md#installed-package-acceptance) and [Archive contents](releasing.md#archive-contents).
