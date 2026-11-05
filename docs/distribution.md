# Distribution

The workspace root and React UI are private packages. Only `packages/stelz` can produce a release archive.
The package remains `stelz` version `0.2.0`, with the MIT license.
Release preparation and npm publication use separate workflows.

1. Run `bun install --frozen-lockfile --ignore-scripts` in a clean workspace.
2. Run `bun run typecheck`.
3. Run `bun run test`.
4. Run `bun run build`.
5. Run `bun run pack --destination .state/release-candidate` once.
6. Run `bun run verify:release --archive .state/release-candidate/stelz-0.2.0.tgz`.
7. Run `bun run verify:release --archive .state/release-candidate/stelz-0.2.0.tgz --native`.

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
The browser-free `--native` check uses ordinary installation and the staged runtime.
It executes SQLite queries and constructs Impit clients through each relevant dependency resolution path.
CI requires both installation modes on Linux and macOS against the same archive.
The separate `test:prepack` command removes compiled output, then checks that packing rebuilds it.
Run `bun run test:package` on every supported target before release.

## Prepare the release candidate

Run the **Prepare release candidate** workflow on the release source commit.
Its Linux and macOS checks must pass before it builds an archive.
The workflow builds one candidate, checks that archive, and uploads `stelz-release-candidate`.
The artifact contains the tarball, its SHA-256 file, and `candidate.json` with the source commit.
Preparation uses read-only repository permissions and requires no publication secret.

Download the complete artifact from that run. Use the same tarball for all acceptance checks:

```sh
bun run verify:release --archive /path/to/stelz-0.2.0.tgz
PROXY_TEST_ENV=/private/path/proxies.env STELZ_RELEASE_CANDIDATE_RUN=RUN_ID \
  bun run test:package --archive /path/to/stelz-0.2.0.tgz --native --proxy --manual
```

The second command uses ordinary npm installation outside the repository.
It checks native addons, the bundled UI, MCP control, native persistence, proxy routing, and human takeover.
Each suite controls the installed CLI. No suite rebuilds the supplied archive.
Supply two distinct private proxy routes as described in [testing](tests.md#proxy-acceptance).
Complete the human action in the paused browser when prompted.

Successful complete acceptance writes `release/acceptance-0.2.0.json`.
This public record contains the archive hash, workflow run, source commit, platform, and check results.
It omits proxy credentials, profile data, and local paths. Private detailed reports stay under `.state/`.
Commit the acceptance record without changing release source. Tag that commit `v0.2.0`.

## Publish the tested archive

Configure the npm trusted publisher for `souljorje/stelz` and workflow filename `publish.yml`.
Permit direct publication. The job uses OIDC and needs no stored npm token.
The repository and package must be public for automatic provenance.
See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

For a new package name, npm requires an initial package record before trusted-publisher configuration.
The documented [staging flow](https://docs.npmjs.com/staged-publishing/) can create that record without publishing the staged release contents.
The registry creates a public `0.0.0-stage` placeholder. Never approve a bootstrap stage as a Stelz release.
Keep the real release version available for the tested OIDC publication.

Run **Publish verified npm release** with the version, candidate run ID, SHA-256, and distribution tag.
The job downloads the original artifact. It rejects incomplete acceptance, changed source, and a different archive hash.
It repeats installation checks, then publishes that tarball with provenance. It does not rebuild or repack it.
Publication runs serially. npm rejects reuse of an existing version.
After publication, install the exact registry version in a clean directory and check its CLI and UI.
