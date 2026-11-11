---
title: "Release Stelz"
description: "Changesets, the Release workflow, archive contents, and publication checks, to read before you version, pack, or publish the stelz package."
tags: [development, release]
sources: []
created: 2026-11-06T13:49:16Z
modified: 2026-11-11T15:05:26Z
---

# Release Stelz

- Changesets manages versions, changelogs, Git tags, npm publication, and GitHub releases for `stelz`.
- The Release workflow in `.github/workflows/publish.yml` is the only publication path.
- Do not add an npm token secret or a manual publication procedure.

## Add a Changeset

1. Run `bun run changeset` for a change that needs a package release.
2. Select `stelz`, choose the increment, and describe the effect on users.
3. Include the generated `.changeset/*.md` file with the change.

| Increment | Use |
| --- | --- |
| `patch` | A fix that preserves current contracts. |
| `minor` | A feature, or a breaking change while the version starts with `0`. |
| `major` | A breaking change after `1.0.0`. |

- Changesets uses the largest pending increment. `bun run changeset status` shows the plan.
- Tests, internal tooling, and documentation alone need no Changeset.

## Workflow

- Runs on pushes to `main` and manual dispatch. Restricted to `souljorje/stelz` on `main`. Publishes through npm trusted publishing.
- Release installation checks run on the same platforms as [Continuous integration](testing.md#continuous-integration).
- The `plan` job selects version, publish, or none mode. It changes publish mode to none when the tag `vVERSION` already exists.
- The `checks` job calls `.github/workflows/ci.yml` with `skip-package: true`.
- Version mode runs `bun run version:packages`. It creates or updates the version PR on `changeset-release/main`, updates `package.json`, `bun.lock`, and `CHANGELOG.md`, and consumes the pending Changesets.
- Review the version, changelog, and CI results before you merge the version PR.
- The workflow dispatches CI for that branch, because the bot token does not trigger PR workflows. It never approves or merges a PR.

Publish mode starts after the merged version PR:

1. Make sure that CI passed.
2. Download the Changesets publish plan.
3. Run `bun run pack --publish-plan FILE` once in the `pack` job.
4. Upload `release-artifacts/` as the `stelz-package` artifact.
5. In the `installation` job, download the artifact and run `bun run test:install --archive release-artifacts/packages/*.tgz`. Repeat with `--native`.
6. In the `publish` job, download the same artifact after the installation job succeeds. Check its SHA-256 file.
7. Run `bun run release`: `changeset publish --from-pack-dir release-artifacts` with npm provenance and OIDC.
8. Create the Git tag and GitHub release through the Changesets action.
9. Attach the tarball and checksum to the GitHub release.

- Installation and publication use the same tarball bytes. The publication job does not rebuild or repack.
- Only the publication job has `id-token: write`.
- Before you release browser changes, run the relevant checks from [Installed-package acceptance](acceptance.md#installed-package-acceptance).
- npm can report **Validating** after an upload. Wait for the registry version before you check installation and integrity. Do not repeat publication while npm reviews the upload.

## Archive contents

- The root manifest defines package contents: the built runtime, README, and LICENSE. Documentation and the browser skill stay in the repository.
- Only prepared Camofox is bundled. Packing removes packages that no manifest reaches (such as `camoufox-js`), and bundled native packages and platform binaries.
- `test:install` checks the archive. See [Native dependencies](camofox-integration.md#native-dependencies).

## Repository configuration

- GitHub must permit Actions-created PRs through **Allow GitHub Actions to create and approve pull requests**. An owner must approve a change to that setting.
- The npm trusted publisher must select `souljorje/stelz` and workflow `publish.yml`.
- Keep the repository and package public for automatic provenance. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
