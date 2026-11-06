# Release Stelz

Changesets manages the version, changelog, Git tag, npm publication, and GitHub release.
The Release workflow in `.github/workflows/publish.yml` runs on pushes to `main` and manual dispatch.
It uses the existing npm trusted publisher. Do not add an npm token secret.

## Add a Changeset

Run `bun run changeset` for each change that needs a package release.
Select `stelz`, choose an increment, and describe the effect on users.
Commit the generated `.changeset/*.md` file with the implementation.

- Choose `patch` for a fix that preserves current contracts.
- Choose `minor` for a feature or a breaking change while the version starts with `0`.
- Choose `major` for a breaking change after `1.0.0`.

Changesets combines pending entries and uses the largest increment.
Run `bun run changeset status` to inspect the planned version.
Tests and internal tooling alone do not require a Changeset.

## Release flow

| State on main | Workflow behavior |
| --- | --- |
| Pending Changesets | Update one version PR on `changeset-release/main`. |
| No Changesets and an unpublished version | Build, test, and publish that version. |
| No Changesets and a published version | Run checks without another publication. |

The version PR updates `package.json`, `bun.lock`, and `CHANGELOG.md` and consumes its Changesets.
Review its version, changelog, and CI results before merging.
The workflow explicitly dispatches CI for bot-created PRs because `GITHUB_TOKEN` does not trigger ordinary PR workflows.
It never approves or merges a PR.

After merging the version PR, the Release workflow performs these steps:

1. Run build, typecheck, and automated tests on Linux and macOS.
2. Prepare patched Camofox dependencies and exclude native binaries from the package archive.
3. Use Changesets to pack one tarball and record its integrity in its publish plan.
4. Install that archive on Linux and macOS, both with lifecycle scripts disabled and with native addons enabled.
5. Publish the same archive through Changesets and npm OIDC, then create its Git tag and GitHub release.
6. Attach the tarball and checksum to the GitHub release.

The archive is built once. Installation checks and publication use those same bytes.
There is no separate release-candidate workflow, acceptance JSON, manual tag, or hand-entered archive hash.
Only the publish job has OIDC publishing permission.

## Browser changes

Before releasing changes to browser behavior, run the relevant headed tests against a local package archive.
Use `bun run pack`, then `bun run test:package --archive PATH --proxy --manual` for the full package checks.
The package suite includes native persistence and profile transfers.
Supply two distinct private proxy routes as described in [Proxy acceptance](tests.md#proxy-acceptance).
Complete human authentication and takeover in the same visible browser when prompted.
Keep credentials and private browser reports outside Git. Tests use disposable profiles.

## Publication status

npm can report **Validating** after a successful upload.
Wait for the registry version before checking installation and integrity from npm.
Do not rerun publication solely because npm is still reviewing the upload.
Check the signed-in npm version history for pending validation.

An agent must report the version, source commit, workflow result, tag, GitHub release, and npm availability.
State incomplete checks explicitly. An upload alone does not prove that the registry serves the new version.

## Repository setup

GitHub must permit Actions-created PRs through **Allow GitHub Actions to create and approve pull requests**.
An owner must approve this setting change. The workflows do not approve PRs or change branch protections.
The npm trusted publisher must allow publication from `souljorje/stelz`, workflow `publish.yml`.
Keep the repository and package public for automatic provenance.
See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
