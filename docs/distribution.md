# Distribution

The workspace root and React UI are private packages. Only `packages/stelz` can produce a release archive.
The package remains `stelz` version `0.2.0`, with license `UNLICENSED`.
No npm publication workflow is configured.

1. Run `bun install --frozen-lockfile` at the repository root.
2. Run `bun run typecheck`.
3. Run `bun run test`.
4. Run `bun run build`.
5. Run `bun run verify:release`.
6. Run `bun pm pack ./packages/stelz` to create a local archive.

The package prepack hook builds artifacts from the workspace. It never calls pack recursively.
Packing requires the source workspace and its development dependencies. Installing the archive does not require that workspace.
Build copies canonical documentation and examples. Do not edit generated package copies.
The archive includes the optional browser skill, third-party notices, and UI font and library licenses.
It excludes source, tests, browser state, and installed dependencies.

The manual `Prepare release archive` workflow verifies and uploads an archive when an operator selects `workflow_dispatch`.
It has read-only repository permissions. It does not publish to npm, create releases, or require publication secrets.
Full `test:package` acceptance requires Camoufox and remains an explicit local command.

## Prepared browser dependencies

The release bundles the patched Camofox and camoufox-js packages. Consumers do not apply patches or run dependency install scripts to obtain the fixes. Run `stelz setup` explicitly after installation.

Source builds require `bun install --frozen-lockfile` at the workspace root. See [Camofox patches](camofox-patches.md) for the patch workflow and verification. Stop profiles before upgrading, then run setup and restart them explicitly. Bundling does not provide live-upgrade safety.
