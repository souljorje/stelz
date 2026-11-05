# Distribution

The workspace root and React UI are private packages. Only `packages/stelz` can produce a release archive.
The package remains `stelz` version `0.2.0`, with license `UNLICENSED`.
No npm publication workflow is configured.

1. Run `bun install --frozen-lockfile --ignore-scripts` in a clean workspace.
2. Run `bun run typecheck`.
3. Run `bun run test`.
4. Run `bun run build`.
5. Run `bun run verify:release`.
6. Run `bun run pack` to create a local archive.

The package prepack hook builds artifacts from the workspace.
Release preparation uses Bun to resolve workspace links, then packs a temporary standalone tree with npm.
The internal preparation steps disable lifecycle scripts to prevent recursion.
Packing requires the source workspace and its development dependencies. Installing the archive does not require that workspace.
Build copies canonical documentation and examples. Do not edit generated package copies.
The archive includes the optional browser skill, third-party notices, and UI font and library licenses.
It excludes Stelz source, tests, browser state, and credentials.
It bundles the prepared Camofox and camoufox-js packages, including transitive JavaScript sources and licenses.
Bun applies the committed dependency patches during workspace installation. End-user setup only checks those changes.
The release verifier installs the exact packed archive with npm lifecycle scripts disabled and compares the modified dependency files.
It rejects compiled native binaries and browser data in bundled dependencies.

The native packages `better-sqlite3` and `impit` remain separate direct dependencies at their existing pinned versions.
The temporary release tree moves their declarations from the bundled manifests to Stelz's manifest.
This prevents npm from treating missing native packages as bundled dependencies.
Their JavaScript and native binaries come from ordinary npm dependency installation on the target machine.
Setup links these native packages from the installed Stelz package into the staged runtime.
Native addon execution requires separate checks after ordinary package installation.
The packaging check does not establish browser execution with lifecycle scripts disabled.
Run `bun run test:package` on every supported target before release.

The manual `Prepare release archive` workflow verifies and uploads an archive when an operator selects `workflow_dispatch`.
It has read-only repository permissions. It does not publish to npm, create releases, or require publication secrets.
Full `test:package` acceptance requires Camoufox and remains an explicit local command.
