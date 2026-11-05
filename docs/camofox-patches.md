# Camofox adapter patches

Bun applies these eight compatibility changes to pinned Camofox 1.18.1 and camoufox-js 0.11.5 during workspace installation.
The root `patchedDependencies` field selects the committed files under `patches/`.
The release archive bundles both prepared packages and their transitive JavaScript dependencies.
Setup checks the prepared files without rewriting dependency source.
Setup rejects missing, duplicate, or changed matches before atomic activation.
Setup copies dependencies and checks the complete staged runtime before atomic activation.
Setup retains symlink rejection, stopped-profile checks, process ownership, admission locks, and rollback cleanup.

| Patch | Reason | Removal criterion |
| --- | --- | --- |
| Locator fill | Route text through the configured paced or instant typing helper. | Upstream supplies the same configurable typing behavior. |
| Executable resource link | Prevent changes to an installed macOS app bundle. | Upstream reads app resources without writing symlinks. |
| camoufox-js properties path | Read macOS properties from Contents/Resources. | The pinned library resolves that resource path itself. |
| Window and screen bounds | Preserve the existing desktop window and screen selection policy. | Upstream supports equivalent explicit bounds through configuration. |
| Proxy WebRTC policy | Disable WebRTC for proxied browsers. | Upstream enforces the same policy on every proxy browser start. |
| Browser start | Route browser start through persistent profile and fingerprint handling. | Upstream provides equivalent persistent-context ownership and device replay. |
| Context claim | Reuse the selected persistent profile context. | Upstream claims that context without creating a replacement. |
| Native persistence guard | Prevent checkpoint restoration over native Firefox storage. | Upstream disables checkpoint persistence for native storage. |

Remove a patch only after the replacement passes offline regression tests and explicit browser acceptance.
An upstream version change requires a separate compatibility review. This restructuring does not change patch behavior.

## Development

Run `bun install --frozen-lockfile --ignore-scripts` at the workspace root.
Use `bun patch PACKAGE@VERSION` to prepare an editable dependency.
Edit the prepared package. Run `bun patch --commit PACKAGE@VERSION --ignore-scripts` to save the change.
Commit the generated patches, root manifest, and Bun lockfile together.
Keep the exact dependency versions until a separate compatibility review approves an upgrade.

## Release checks

Prepare release dependencies with lifecycle scripts disabled in a clean workspace.
Run `bun run build`, `bun run typecheck`, and `bun run test`.
Run `bun run verify:release` to check the packed archive and its installation with npm lifecycle scripts disabled.
The verifier compares the shipped modified files with the tested dependency files.
It checks the launcher resolved from Stelz and the launcher resolved from Camofox.
The archive permits transitive dependency sources and licenses. It rejects browser data, secrets, caches, and compiled native binaries.
Run `bun run pack` to prepare a standalone npm archive from Bun's dependency tree.

Camofox depends on `better-sqlite3`, a native addon. The launcher also uses the native `impit` package.
Stelz declares these packages directly at their existing versions. The release tree omits their bundled copies and platform binaries.
The temporary bundled manifests delegate these dependencies to Stelz. Prepared workspace manifests and JavaScript source remain unchanged.
Ordinary npm installation supplies native packages for the target machine. Setup links them into the staged runtime.
The packaging and setup checks do not prove native-addon or browser execution with lifecycle scripts disabled.
Run `bun run test:package` with ordinary npm installation on each supported target before release.
Check native-addon installation and browser startup there. Do not ship the build machine's compiled `.node` files.
Proxy and human-takeover acceptance require their separate supported-machine checks.

## Upgrade

1. Stop the profiles.
2. Upgrade Stelz.
3. Run `stelz setup`.
4. Start the profiles explicitly.

Runtime dependency links still refer to the installed package.
Live upgrade and rollback guarantees remain unchanged. Profile storage and controller ownership remain unchanged.
