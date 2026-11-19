---
title: "Camofox integration"
description: "Pinned dependencies, patches, location preparation, setup activation, and native dependencies of Camofox, to read before you change a patch or a pin."
tags: [development, camofox]
sources: []
created: 2026-11-06T13:49:16Z
modified: 2026-11-15T12:00:00Z
---

# Camofox integration

Camofox and Camoufox: see [Technology](architecture.md#technology). Request path: see [Architecture](architecture.md#request-path).

## Pinned dependencies and patches

- Bun applies the committed patches in `patches/` during workspace installation.
- Pins in the root `package.json`: Camofox (`@askjo/camofox-browser`) `1.19.0`, official `camoufox` launcher `0.5.9`.
- The Camofox patch sets its launcher dependency to that version and its optional MCP SDK range to the Stelz SDK range. No override is necessary, and the archive holds one SDK copy.
- `src/versions.ts` records the upstream source commit.
- Setup checks each patched location in the prepared source (`src/browser/camofox-adapter.ts`). It fails when a patch is missing, duplicated, or changed.

| Area | Patch |
| --- | --- |
| Locator fill and type route | Forwards each call's typing mode: balanced, keyboard, bulk. |
| Scroll tab activation | Activates the native tab, moves the pointer to the viewport center, then sends wheel input. Keeps tab lock and deadline. |
| Click retry guard | Trial click first. See the click retry guard note below. |
| Orphan page reaper | Closes only pages that Camofox created, registered, or tried to close. |
| Browser health probe | Disabled. Its test context opens a visible window, and Stelz refuses the replacement browser it requests. |
| Official launcher import | Imports `Camoufox`, `launchOptions`, and `VirtualDisplay` from `camoufox`. |
| Virtual display | 1280x720x24 screen on the official display. Drops the Camofox cleanup code. |
| Bundled downloader | Removes `postinstall.js`, `lib/camoufox-download.js`, and their scripts. |
| Launch options | Prepared by the plugin. Replaces the GeoIP retry. A failed proxied launch never retries without GeoIP. |
| Crashed tab and popup | Disabled. Camofox does not close a crashed tab or resize a popup. |
| Browser start | Persistent profile and saved device handling. |
| Context claim | Reuses the selected persistent profile context. |
| Initial page claim | Original blank page becomes the first managed tab. Page leases and a separate initialization deadline protect startup. |

Stelz does these without a patch:

- Plugins: setup stages only the `local-profile` plugin. Camofox does not load its persistence plugin, so Firefox keeps control of persistent browser data.
- Executable: the supervisor passes the browser path in `STELZ_CAMOUFOX_EXECUTABLE`. Camofox sees none of its own executable variables, so its executable shim stays off. The shim writes `version.json` into the shared Camoufox cache. The `CAMOUFOX_EXECUTABLE` override in `secrets.env` is unchanged.
- Memory restart: the supervisor sets both memory limits (`NO_MEMORY_RESTART` in `src/profiles/config.ts`) to the largest safe integer. Camofox never restarts a browser for memory.
- Window, screen, and WebRTC: `prepareProfileLaunch` sets the desktop window and screen bounds. It turns WebRTC off for proxied browsers. See [IP check policy](../configuration/network.md#ip-check-policy).
- Rendering: `prepareProfileLaunch` sets upstream `canvas_noise: true` to prevent a separate browser launch for GPU detection. Camoufox 158 replaces canvas/WebGL readback with random data. WebGPU exposure follows the saved OS/GPU, but its adapter request returns null. This differs from launcher 0.5.8, which added no canvas noise. After device replay, Stelz derives DPR and WebGPU preferences again with upstream rules.
- Model: Start binds `fpgen-js` to the validated model directory after launcher initialization. An inherited `FPGEN_DATA_DIR` cannot select another model. Missing or incomplete prepared files block Start.
- Geolocation: `launchProfileBrowser` and `claimProfileContext` drop the context permissions. No website gets a permission.
- New pages: `claimProfileContext` replaces `newPage()` on the claimed context. The first call returns the original blank page. Each Camofox route that creates a page uses it.
- Click guard and page ownership: the patched server imports these functions from the built plugin.

- Click retry guard: a trial click sends no input. Forced, DOM, or mouse fallback runs only when the trial fails. A failure after input returns a non-retryable conflict that asks for a fresh snapshot.
- Typing keeps the tab lock until input finishes. Timeout effects: [Typing](../configuration/typing.md).
- Remove a patch only when upstream provides the same behavior and the replacement passes `bun run test` and the browser suite.

## Change a dependency patch

1. Install dependencies (see [Testing](testing.md#choose-a-check)).
2. Run `bun patch PACKAGE@VERSION` for the pinned dependency.
3. Edit the prepared dependency.
4. Run `bun patch --commit PACKAGE@VERSION --ignore-scripts`.
5. Include the generated patch, root manifest, and Bun lockfile in the change.
6. Run `bun run check` and the relevant checks from [Testing](testing.md) and [Acceptance](acceptance.md).

- Keep exact versions until a separate compatibility review approves an upgrade.
- Bun writes the registry manifest of Camofox into `bun.lock`, not the patched one. After a version change, give the `@askjo/camofox-browser` lock entry the dependencies of the patched manifest. Then run `bun install --frozen-lockfile`. Otherwise the archive holds a second MCP SDK.
- Stelz exposes only the tools and properties that `src/browser/catalog.ts` lists. Classify each new upstream tool as an entry or as excluded, because the catalog test fails on an unclassified tool. Review each new property and background timer before you list or enable it.
- Only `src/browser/camoufox.ts` imports `camoufox` internals. Its unit test fails when an upgrade removes one of them.
- Update `src/browser/camofox-adapter.ts` when a required patched location changes.

## Internal tab state

`tab_snapshot` reads the tab state of Camofox in process. Camofox does not document this structure, so a Camofox upgrade can break it.

- Path: `ctx.sessions` → session by profile ID → `tabGroups` → tab by tab ID. Each tab has `refs` and `lastSnapshot`.
- `refs` is a `Map` from a ref to `{role, name, nth}`. A ref in an iframe also has `frameName` and `frameUrl`. `lastSnapshot` is the full annotated page. The snapshot route windows only its reply, at 80000 characters.
- `src/browser/tab-state.ts` checks the shape on each call. If the shape differs, the call fails with `Stelz cannot read the page state of Camofox…`. Stelz does not guess. The route reply must also agree with the tab state: `totalChars` is the length of `lastSnapshot`, and `refsCount` is the size of `refs`.
- The stale-ref guard compares the identity of a ref (`role`, `name`, `nth`, and the frame) in `refs` with the identity that the controller saw.
- Camofox gives refs to the first 500 nodes (`MAX_SNAPSHOT_NODES` in `server.js`). `REF_LIMIT` in `src/browser/snapshot-view.ts` repeats it.
- The ref marker is ` [eN]` after the role and the name. `src/browser/aria.ts` reads it with the same name pattern as `annotateAriaSnapshotRefs`.
- The plugin loads `normalizedAccessibleName` and `SKIP_PATTERNS` from `lib/aria-annotate.js`, and `INTERACTIVE_ROLES` from `lib/interactive-roles.js`. It loads them by path from `STELZ_UPSTREAM`, as it loads the tool contracts. A static import cannot work: the plugin runs from `plugins/local-profile/` inside the Camofox tree, and `src/` has no path to that tree.
- The plugin drops the embedded `snapshot` from a click reply with `semantic_target_mismatch` and from the 409 and 422 replies of `extract`. It adds a hint to read `tab_snapshot`.
- A role/name `target`, the observation after an action, and the polls of `tab_wait` use the same snapshot route and the same tab-state read, in the same queued action. Only `tab_snapshot` and the observation give the page to a controller, so only they update its baseline, latest view, and reliable refs. The read for a target and the polls do not. They still rebuild the refs of the tab, and the stale-ref guard sees that.
- After an upgrade, run `bun run test` and `bun run test:browser`. Check each item in this list against `server.js`.

## Location preparation

- Stelz checks the proxy exit IP itself (`src/runtime/public-ip.ts`) and reads the managed MaxMind database itself.
- Stelz passes `geoip: false` to the launcher and merges the prepared location into `config`.
- The lifecycle path checks current inputs before reservation and again before server launch.
- A per-profile lock serializes checks. Network requests do not hold the global admission lock.
- Configuration changes invalidate old results.
- The plugin checks geolocation as configured, not observed.
- See [Managed location data](../configuration/network.md#managed-location-data) and [IP check policy](../configuration/network.md#ip-check-policy).

## Runtime setup

- [Release sources](../../src/browser/release-sources.json) lists browser and GeoIP download sources in priority order.
- Use a GitHub release page URL or a direct HTTPS URL to a JSON manifest.
- Set `tag` and `assets` in the manifest. Each asset needs `name`, `size` in bytes, an HTTPS `url`, and a lowercase hex `sha256`.
- The launcher selects the browser build. The source list applies to the specified `build`. Every browser source must match the configured SHA-256 digests.
- Other dependency links resolve to the supplying package installation. Keep that installation available while the runtime uses it.
- Symlinks in copied source block setup.
- Staging checks: prepared patch matches, exported contracts, plugin functions, Node syntax. Setup checks the complete runtime before activation.
- `versions.json` records package and dependency versions, the upstream source commit, the browser path, and its executable hash.
- Generations and cleanup: [Source layout and runtime updates](source-layout.md).
- Applying an update: [Update Stelz](../getting-started.md#update-stelz) or [Run Stelz from a checkout](../../CONTRIBUTING.md#run-stelz-from-a-checkout).

## Native dependencies

- `better-sqlite3` and `impit` are direct dependencies of the Stelz root package at pinned versions.
- The bundled Camofox manifests delegate native dependency installation to that package. Ordinary npm installation supplies native packages for the target machine.
- Setup links them into the staged runtime.
- `yazl` and `yauzl` also install as ordinary runtime dependencies.
- Checks: [Installed-package acceptance](acceptance.md#installed-package-acceptance). Packing: [Archive contents](releasing.md#archive-contents).
