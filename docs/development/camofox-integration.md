# Camofox integration

Camoufox is the Firefox-based browser executable. Camofox is the HTTP automation server that controls it through Playwright.
The official `camoufox` launcher prepares browser launch options. Stelz supplies persistent profile ownership and exclusive MCP control.
See [Architecture](architecture.md) for the request path and service boundaries.

## Pinned dependencies and patches

Bun applies committed compatibility patches during workspace installation.
The root `package.json` pins Camofox (`@askjo/camofox-browser`) to `1.18.1` and the official `camoufox` launcher to `0.5.8`.
The Camofox patch changes its launcher dependency to that same version. No override is necessary.
Its `patchedDependencies` field selects the files under `patches/`.
The upstream source commit is recorded in `src/versions.ts`.

The patches cover thirteen compatibility areas:

| Area | Purpose | Removal criterion |
| --- | --- | --- |
| Locator fill and type route | Forward each call's typing mode. Support automatic pacing, keyboard events, and bulk entry. | Upstream provides equivalent configurable typing behavior and timeout handling. |
| Scroll tab activation | Activate the selected native tab before Playwright waits for a frame and sends wheel input. Keep the existing tab lock and deadline. | Upstream activates the target before wheel preparation and passes background-tab and parallel-profile acceptance. |
| Click retry guard | Check the target with a trial click that sends no input. Fall back to a forced, DOM, or mouse click only when that check fails. Input gets the remaining action budget, because Camoufox confirms each mouse event. A failure after input returns a non-retryable conflict that asks for a fresh snapshot. | Upstream no longer repeats a click that may have reached the page. |
| Official launcher import | Import `Camoufox`, `launchOptions`, and `VirtualDisplay` from `camoufox`. | Upstream depends on the official launcher. |
| Virtual display | Pass the 1280x720x24 screen to the official display. It removes its X lock and socket files on kill. | Upstream uses the official display with an equivalent screen. |
| External executable shim | Disable the Camofox executable shim. It writes `version.json` into the shared Camoufox cache. The Stelz plugin passes the executable to the launcher. | Upstream passes an external executable without cache writes. |
| Bundled downloader | Remove `postinstall.js`, `lib/camoufox-download.js`, and their scripts. Browser installation stays explicit. | Upstream installs no browser during package installation. |
| Window and screen bounds | Preserve the explicit desktop window and screen policy. | Upstream supports equivalent explicit bounds through configuration. |
| Proxy WebRTC policy | Disable WebRTC for proxied browsers. | Upstream enforces the same policy on every proxy browser start. |
| Browser start | Use persistent profile and saved device handling. | Upstream provides equivalent persistent-context ownership and device replay. |
| Context claim | Reuse the selected persistent profile context. | Upstream claims that context without creating a replacement. |
| Initial page claim | Register the original blank page as the first managed tab. Protect startup with canonical page leases and a separate initialization deadline. | Upstream reuses and protects the native startup page without opening a duplicate. |
| Native persistence guard | Keep Firefox in charge of persistent browser data. | The replacement leaves upstream storage snapshots disabled for native profiles. |

Typing retains the tab lock until input finishes.
The service deadline blocks subsequent actions after a timeout.
Typing timeouts return a terminal error without a retry instruction.
The caller must inspect fresh state after recovery. The service does not replay incomplete input.

Remove a patch only after its replacement passes regression tests and explicit browser acceptance.
Review upstream upgrades separately. Saved device settings do not guarantee stable observable fingerprints or website acceptance.

## Change a dependency patch

1. Run `bun install --frozen-lockfile --ignore-scripts` at the repository root.
2. Run `bun patch PACKAGE@VERSION` for the pinned dependency.
3. Edit the prepared dependency.
4. Run `bun patch --commit PACKAGE@VERSION --ignore-scripts`.
5. Include the generated patch, root manifest, and Bun lockfile in the change.
6. Run `bun run check` and the relevant checks from [Testing](testing.md).

Keep exact versions until a separate compatibility review approves an upgrade.
Only `src/browser/camoufox.ts` imports `camoufox` internals. Its unit test fails when an upgrade removes one of them.
Update `src/browser/camofox-adapter.ts` when required prepared-source checks change.
Its checks reject missing, duplicate, or changed matches.
Setup validates prepared source. Setup does not rewrite it.

## Location preparation and verification

Stelz checks the proxy exit IP itself (`src/runtime/public-ip.ts`) and reads the managed MaxMind database itself.
The official helpers memoize results per proxy, cannot be cancelled, have no error codes, and download into the shared cache.
Stelz passes `geoip: false` to the launcher and merges the prepared location into `config`.
It removes `permissions.default.geo`, so coordinates never grant website permission.
Stelz supplies the existing deterministic country-language policy. Valid zero coordinates remain valid.
Camofox cannot retry a failed proxied launch with GeoIP disabled. It no longer grants blanket geolocation permission.

The shared lifecycle path checks current inputs before reservation and again before server launch.
A per-profile lock serializes checks. Network requests do not hold the global admission lock.
Private result identities bind the resolved secrets, profile, policy, engine, launcher, and database.
Public results contain no credential identities. Configuration changes invalidate old results.
The plugin verifies IP, timezone, and languages before Ready. It checks geolocation as configured, not observed.
Blank startup and MCP gating do not establish that Firefox sends no background website traffic.

## Runtime setup

The release archive bundles only the prepared Camofox package with its transitive JavaScript dependencies and licenses.
Camofox registry metadata still names `camoufox-js`. Packing removes packages that no manifest reaches. Archive checks reject any `camoufox-js` file.
Setup locates the installed packages. It does not download or patch upstream source.
It prepares the paired browser, the location data, and the official pinned fingerprint model. See [Run setup](../getting-started.md#2-run-setup).
Start refuses to launch without the fingerprint model. Start never downloads.
Setup reads the upstream Camoufox cache only. It never calls upstream code that writes or prunes that cache.

Setup copies Camofox files, the launcher, and the compiled Stelz plugin into a staged runtime generation.
Other dependency links resolve to the supplying package installation. Symlinks in copied source block setup.

The staging checks cover prepared patch matches, exported contracts, plugin functions, and Node syntax.
`versions.json` records package and dependency versions, the upstream source commit, the browser path, and its executable hash.
Setup checks the complete runtime before activation. See [Source layout and runtime updates](architecture.md#source-layout-and-runtime-updates) for generations, locks, and cleanup.

Start compares the installed plugin bytes with the current package.
An outdated plugin requires setup before a new browser can start.
Setup does not migrate browser data or the saved browser executable identity.

## Native dependencies and archive checks

`better-sqlite3` and `impit` remain direct dependencies at their pinned versions.
The temporary release tree removes their bundled copies and platform binaries.
Its bundled manifests delegate native dependency installation to the Stelz root package.
Prepared workspace manifests and JavaScript source remain unchanged.
Ordinary npm installation supplies native packages for the target machine.
Setup links them into the staged runtime.
The ZIP libraries `yazl` and `yauzl` also install as ordinary runtime dependencies.

Run `bun run pack` once to create a local candidate.
Use the resulting archive path for `bun run test:install --archive FILE` and its `--native` mode.
The installer compares modified dependency files with the prepared workspace.
It checks the launcher resolved from Stelz and from Camofox.
The archive permits transitive sources and licenses. It rejects browser data, secrets, caches, and compiled native binaries.

Installation with lifecycle scripts disabled does not establish native-addon or browser execution.
The browser-free `--native` check uses ordinary installation.
It executes SQLite queries and constructs Impit clients through the relevant resolution paths.
`bun run test:package --archive FILE` checks actual browser behavior from the installed archive.
Proxy and human-takeover checks require their separate inputs and operator action.
See [Testing](testing.md) for procedures and [Releasing](releasing.md) for the single publication workflow.

## Apply a package or source update

1. Update the installed package, or build the changed source checkout.
2. Run `stelz setup`, or `bun run setup` from that checkout, with the same `STELZ_HOME`.
3. Restart the running profiles that must use the update. See [Update Stelz](../getting-started.md#update-stelz).

Runtime links still refer to the supplying installation. Keep it available while the runtime uses it.
Profile IDs, storage paths, and controller rules remain unchanged by setup.
See [Configuration](../configuration.md), [Troubleshooting](../troubleshooting.md), and [Architecture](architecture.md#source-layout-and-runtime-updates).
