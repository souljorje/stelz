# Camofox integration

Camoufox is the Firefox-based browser executable. Camofox is the HTTP automation server that controls it through Playwright.
`camoufox-js` prepares browser launch options. Stelz supplies persistent profile ownership and exclusive MCP control.
See [Architecture](architecture.md) for the request path and service boundaries.

## Pinned dependencies and patches

Bun applies committed compatibility patches during workspace installation.
The root `package.json` pins Camofox (`@askjo/camofox-browser`) to `1.18.1` and `camoufox-js` to `0.13.0`.
The `camoufox-js` override makes Camofox use that same launcher version.
Its `patchedDependencies` field selects the files under `patches/`.
The upstream source commit is recorded in `src/versions.ts`.

The patches cover eight compatibility areas:

| Area | Purpose | Removal criterion |
| --- | --- | --- |
| Locator fill and type route | Forward each call's typing mode. Support automatic pacing, keyboard events, and bulk entry. | Upstream provides equivalent configurable typing behavior and timeout handling. |
| Executable resource link | Prevent changes to an installed macOS app bundle. | Upstream reads app resources without writing symlinks. |
| `camoufox-js` properties path | Read macOS properties from `Contents/Resources`. | The pinned library resolves that resource path itself. |
| Window and screen bounds | Preserve the explicit desktop window and screen policy. | Upstream supports equivalent explicit bounds through configuration. |
| Proxy WebRTC policy | Disable WebRTC for proxied browsers. | Upstream enforces the same policy on every proxy browser start. |
| Browser start | Use persistent profile and saved device handling. | Upstream provides equivalent persistent-context ownership and device replay. |
| Context claim | Reuse the selected persistent profile context. | Upstream claims that context without creating a replacement. |
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
Update `src/browser/camofox-adapter.ts` when required prepared-source checks change.
Its checks reject missing, duplicate, or changed matches.
Setup validates prepared source. Setup does not rewrite it.

## Runtime setup

The release archive bundles the prepared Camofox and `camoufox-js` packages with their transitive JavaScript dependencies and licenses.
Setup locates those installed packages. It does not download or patch upstream source.
It uses the existing Camoufox executable and leaves that installation unchanged.

Setup holds the admission lock and requires stopped profiles.
Symlinks in copied source, unsafe state, unknown process ownership, and unclean lifetimes block setup.
It creates a private staging directory under `STELZ_HOME`.
It copies Camofox files, the launcher, and the compiled Stelz plugin into that directory.
Other dependency links resolve to the supplying package installation.

The staging checks cover prepared patch matches, exported contracts, plugin functions, and Node syntax.
`versions.json` records package and dependency versions, the upstream source commit, the browser path, and its executable hash.
Setup checks the complete runtime before activation.
For a replacement, it exchanges complete runtime directories atomically.
A filesystem without atomic exchange support must fail rather than use two separate renames.
Cleanup removes staging data, or the previous runtime after a successful exchange.

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

1. Stop all profiles cleanly.
2. Update the installed package, or build the changed source checkout.
3. Run `stelz setup`, or `bun run setup` from that checkout, with the same `STELZ_HOME`.
4. Start the required profiles explicitly.

Runtime links still refer to the supplying installation. Keep it available while the runtime uses it.
Profile IDs, storage paths, and controller rules remain unchanged by setup.
The shared MCP protocol requires the updated runtime and explicit restarts of old browser services.
Updating only the client registration leaves those old services unchanged.
Keep the same `STELZ_HOME`. This protocol update requires no browser data migration.
Follow [Registration migration](../clients.md#migrate-an-existing-registration) without editing global harness configuration.
See [Configuration](../configuration.md), [Troubleshooting](../troubleshooting.md), and [Architecture](architecture.md#source-layout-and-runtime-updates).
