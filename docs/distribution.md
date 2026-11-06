# Distribution

The repository contains one package. Its root manifest defines the release archive and development dependencies.
The package remains `stelz` version `0.2.1`, with the MIT license.
Release preparation and npm publication use separate workflows.

1. Run `bun install --frozen-lockfile --ignore-scripts` in a clean workspace.
2. Run `bun run check`.
3. Run `bun run pack` once.
4. Run `bun run test:install`.
5. Run `bun run test:install --native`.

`pack` builds once and saves the archive and checksum in `release-artifacts/`.
Bun resolves dependency links into a temporary archive. npm packs the extracted release directory after native dependency preparation.
The preparation steps disable lifecycle scripts. There is no implicit prepack build.
Verification uses the saved archive. It does not build or pack another archive.
Use `--destination DIRECTORY` for another output directory. Verification then requires `--archive FILE`.
Packing requires the source workspace and its development dependencies. Installing the archive does not require that workspace.
The archive uses canonical documentation and examples directly.
For profile data archives, see [Import and export profiles](profile-transfer.md).
The archive includes the optional browser skill and UI font and library licenses.
It excludes Stelz source, tests, browser state, and credentials.
It bundles the prepared Camofox and camoufox-js packages, including transitive JavaScript sources and licenses.
Bun applies the committed dependency patches during workspace installation. End-user setup only checks those changes.
The package installation test installs the exact packed archive with npm lifecycle scripts disabled and compares the modified dependency files.
It rejects compiled native binaries and browser data in bundled dependencies.

The native packages `better-sqlite3` and `impit` remain separate direct dependencies at their existing pinned versions.
The temporary release tree moves their declarations from the bundled manifests to Stelz's manifest.
This prevents npm from treating missing native packages as bundled dependencies.
Their JavaScript and native binaries come from ordinary npm dependency installation on the target machine.
The ZIP libraries `yazl` and `yauzl` install as ordinary runtime dependencies.
Setup links these native packages from the installed Stelz package into the staged runtime.
Native addon execution requires separate checks after ordinary package installation.
The packaging check does not establish browser execution with lifecycle scripts disabled.
The browser-free `--native` check uses ordinary installation and the staged runtime.
It executes SQLite queries and constructs Impit clients through each relevant dependency resolution path.
The Release workflow requires both installation modes on Linux and macOS against the same archive.
Run `bun run test:package` on every supported target before release.

## Release procedure

Changesets manages version and changelog updates through a release PR.
See [Release Stelz](releasing.md) for workflow triggers, acceptance, publication, and instructions for agents.
