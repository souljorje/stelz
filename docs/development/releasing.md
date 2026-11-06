# Release Stelz

Changesets manages package versions, changelogs, Git tags, npm publication, and GitHub releases.
The repository contains one package, `stelz`, with the MIT license.
Read the current version from the root `package.json`.
The Release workflow in `.github/workflows/publish.yml` is the publication path.
It runs on pushes to `main` and manual dispatch, restricted to `souljorje/stelz` on `main`.
It uses npm trusted publishing. Do not add an npm token secret or a parallel manual publication procedure.

## Add a Changeset

1. Run `bun run changeset` for a change that needs a package release.
2. Select `stelz`.
3. Choose the version increment.
4. Describe the effect on users.
5. Include the generated `.changeset/*.md` file with the change.

| Increment | Use |
| --- | --- |
| `patch` | A fix that preserves current contracts. |
| `minor` | A feature, or a breaking change while the version starts with `0`. |
| `major` | A breaking change after `1.0.0`. |

Changesets combines pending entries and uses the largest increment.
Run `bun run changeset status` to inspect the plan.
Tests and internal tooling alone do not require a Changeset.
Changes to shipped package behavior or content require a release entry when they need publication.

## Workflow and version review

The `plan` job uses Changesets to select a version, publish, or inactive mode.
It suppresses publication when the current version's `vVERSION` tag already exists.
The `checks` job calls `.github/workflows/ci.yml`.
That workflow builds, checks TypeScript, and runs automated tests on Linux and macOS.

| Selected mode | Result after required checks |
| --- | --- |
| Version | Create or update the version PR on `changeset-release/main`. |
| Publish | Pack and validate the planned unpublished version before publication. |
| None | Run checks without versioning or publication. |

The version job runs `bun run version:packages` through Changesets.
It updates `package.json`, `bun.lock`, and `CHANGELOG.md` and consumes the pending Changesets.
Review the version, changelog, and CI results before merging that PR.
The workflow explicitly dispatches CI for the bot-created branch because its token does not trigger ordinary PR workflows.
The workflow never approves or merges a PR.

The shared setup action installs Node.js 24, Bun from the `packageManager` pin, and its pinned npm version.
It installs frozen dependencies with lifecycle scripts disabled and skips browser downloads.
Checks and packaging have read-only repository access.
The version job has permissions to update the PR and dispatch its checks.
Only publication has `id-token: write` for npm OIDC.

## One validated publication archive

After the merged version PR selects publish mode, the workflow follows this sequence:

1. Require successful CI on Linux and macOS.
2. Download the Changesets publish plan.
3. Run `bun run pack --publish-plan FILE` once in the `pack` job.
4. Upload `release-artifacts/` as the `stelz-package` artifact.
5. Download that artifact in the Linux and macOS installation jobs.
6. Run `bun run test:install --archive release-artifacts/packages/*.tgz` on both platforms.
7. Repeat installation with `--native` on both platforms.
8. Download the same artifact in the publication job after all installation checks succeed.
9. Check the archive's SHA-256 file.
10. Run Changesets publication through `bun run release`.
11. Create the Git tag and GitHub release through the Changesets action.
12. Attach the tarball and checksum to the GitHub release.

`pack` builds the package and prepares one final publication tarball through the Changesets plan.
The plan records tarball integrity. The package directory also contains its SHA-256 file.
Installation checks and publication use the same saved tarball bytes.
The publication job does not rebuild or repack them.
`release` uses `changeset publish --from-pack-dir release-artifacts`.
The workflow enables npm provenance and uses OIDC through the configured trusted publisher.

The installation checks cover package contents, prepared dependencies, CLI, bundled UI, and staged runtime setup.
The first mode disables npm lifecycle scripts.
The native mode uses ordinary npm installation, executes SQLite queries, and constructs Impit clients.
Neither mode starts Camoufox. CI does not establish browser, proxy, or human acceptance.
See [Testing](testing.md#installed-package-acceptance) for local candidate checks.

## Archive contents and dependency preparation

The root manifest defines package contents.
The archive includes compiled CLI, supervisor, plugin, UI, fonts, licenses, logos, screenshots, documentation, examples, and the optional browser skill.
It uses canonical documentation directly, without generated copies.
It excludes Stelz source, tests, browser state, credentials, and compiled native binaries in bundled dependencies.
Profile ZIP archives are a separate format. See [Profile transfer](../profile-transfer.md).

The package bundles prepared Camofox and `camoufox-js` dependencies, including transitive JavaScript sources and licenses.
Bun applies committed patches during workspace installation.
Packing resolves dependency links into a temporary physical tree.
It removes bundled native packages and their platform binaries before creating the final archive.
Only that temporary tree changes. Prepared workspace source remains unchanged.

`better-sqlite3` and `impit` remain pinned direct dependencies of Stelz.
Ordinary npm installation supplies their target-machine packages.
`yazl` and `yauzl` also install as ordinary runtime dependencies.
Setup links installed dependencies into its staged runtime and checks prepared source without rewriting it.
See [Camofox integration](camofox-integration.md) for compatibility patches and setup activation.

## Browser changes and local candidates

Before releasing browser changes, run the relevant visible-browser checks against a local package archive.
Run `bun run pack` to prepare that candidate.
Use its printed archive path for every acceptance command. Do not repack between checks.
`--destination DIRECTORY` selects another local output directory.
Local candidate preparation does not publish a package or replace the Release workflow.

For full package acceptance, run `bun run test:package --archive FILE --proxy --manual`.
The package suite includes native persistence, profile transfers, shared-connection concurrency, and typing.
Add `--windows` to check visible window controls.
Supply two distinct private proxy routes as described in [Proxy and human acceptance](testing.md#proxy-and-human-acceptance).
Complete human authentication and takeover in the same visible browser when prompted.
Keep credentials and private reports outside Git. Tests use disposable profiles.
Run the relevant package acceptance on each supported browser target.
Record any target or check that remains untested.

The workflow still validates its own final archive before publication.
Local browser results supplement those checks. They do not establish that another archive passed browser acceptance.
Keep the source commit, archive hash, environment, checks, and limits with acceptance evidence.
Historical reports under `reports/` do not approve a new release.

## Publication status

npm can report **Validating** after an upload.
Wait for the registry version before checking installation and integrity from npm.
Do not repeat publication solely because npm is still reviewing the upload.
Inspect the signed-in npm version history for pending validation.

Report the version, source commit, workflow result, tag, GitHub release, and npm availability.
State incomplete checks explicitly. An upload alone does not establish registry availability.

## Repository configuration

GitHub must permit Actions-created PRs through **Allow GitHub Actions to create and approve pull requests**.
An owner must approve a change to that setting.
The workflows do not approve PRs or change branch protections.
Preserve repository protections and client approval policies.

The npm trusted publisher must select `souljorje/stelz` and workflow `publish.yml`.
Keep the repository and package public for automatic provenance.
See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) for provider configuration.
