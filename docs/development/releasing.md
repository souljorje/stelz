---
title: "Release Stelz"
description: "Changesets, the Release workflow, archive validation, local release candidates, and publication checks. Read before you version, pack, or publish the stelz package."
tags: [development, release]
sources: []
created: 2026-11-06T13:49:16Z
modified: 2026-11-11T14:13:54Z
---

# Release Stelz

Changesets manages versions, changelogs, Git tags, npm publication, and GitHub releases for the `stelz` package.
The Release workflow in `.github/workflows/publish.yml` is the only publication path. Do not add an npm token secret or a manual publication procedure.

## Add a Changeset

1. Run `bun run changeset` for a change that needs a package release.
2. Select `stelz`, choose the increment, and describe the effect on users.
3. Include the generated `.changeset/*.md` file with the change.

| Increment | Use |
| --- | --- |
| `patch` | A fix that preserves current contracts. |
| `minor` | A feature, or a breaking change while the version starts with `0`. |
| `major` | A breaking change after `1.0.0`. |

Changesets uses the largest pending increment. Run `bun run changeset status` to inspect the plan.
Tests and internal tooling alone do not require a Changeset.

## Workflow

The workflow runs on pushes to `main` and manual dispatch, restricted to `souljorje/stelz` on `main`. It publishes through npm trusted publishing.
CI and the release installation checks run on Ubuntu only while GitHub macOS runners are paused. The macOS matrix entries stay commented in both workflows. Restore them to resume two-platform checks.
The `plan` job selects version, publish, or none mode. It changes publish mode to none when the tag `vVERSION` already exists.
The `checks` job calls `.github/workflows/ci.yml` with `skip-package: true`.
In version mode, the workflow runs `bun run version:packages` and creates or updates the version PR on `changeset-release/main`.
That updates `package.json`, `bun.lock`, and `CHANGELOG.md` and consumes the pending Changesets.
Review the version, changelog, and CI results before you merge the PR.
The workflow dispatches CI for that branch, because the bot token does not trigger PR workflows. It never approves or merges a PR.

After the merged version PR selects publish mode, the workflow follows this sequence:
1. Require successful CI.
2. Download the Changesets publish plan.
3. Run `bun run pack --publish-plan FILE` once in the `pack` job.
4. Upload `release-artifacts/` as the `stelz-package` artifact.
5. In the `installation` job, download the artifact and run `bun run test:install --archive release-artifacts/packages/*.tgz`. Repeat with `--native`.
6. In the `publish` job, download the same artifact after the installation job succeeds. Check its SHA-256 file.
7. Run `bun run release`, which runs `changeset publish --from-pack-dir release-artifacts` with npm provenance and OIDC.
8. Create the Git tag and GitHub release through the Changesets action.
9. Attach the tarball and checksum to the GitHub release.

Installation and publication use the same tarball bytes. The publication job does not rebuild or repack.
Neither installation mode starts Camoufox, so CI does not establish browser, proxy, or human acceptance.
Only the publication job has `id-token: write`.

## Archive contents

The root manifest defines package contents. The archive includes the compiled CLI, supervisor, plugin, UI, fonts, licenses, logos, screenshots, documentation, examples, and the optional browser skill.
It excludes Stelz source, tests, browser state, credentials, and compiled native binaries in bundled dependencies.
The package bundles only prepared Camofox with its transitive JavaScript sources and licenses.
Packing removes packages that no manifest reaches, such as `camoufox-js` from Camofox registry metadata.
It resolves dependency links into a temporary tree and removes bundled native packages and platform binaries from that tree. Prepared workspace source stays unchanged.
The installation check rejects any `camoufox-js` file, browser data, secrets, caches, and compiled native binaries.
It also compares modified dependency files with the prepared workspace and checks the launcher resolved from Stelz and from Camofox.
See [Native dependencies](camofox-integration.md#native-dependencies) for the packages that npm installs on the target machine.

## Local candidates for browser changes

Before you release browser changes, run the relevant visible-browser checks against a local archive.
1. Run `bun run pack`. `--destination DIRECTORY` selects another output directory.
2. Use the printed archive path for every acceptance command. Do not repack between checks.
3. Run the checks from [Installed-package acceptance](acceptance.md#installed-package-acceptance). For proxy checks, see [Proxy and human acceptance](acceptance.md#proxy-and-human-acceptance).
4. Run the relevant package acceptance on each supported browser target. Record any target or check that stays untested.

Local preparation does not publish a package or replace the Release workflow.
Put acceptance evidence in the pull request description, with the source commit, archive hash, environment, checks, and limits.
Keep credentials and private reports outside Git.

## Publication status

npm can report **Validating** after an upload. Wait for the registry version before you check installation and integrity. Do not repeat publication while npm reviews the upload.
Report the version, source commit, workflow result, tag, GitHub release, and npm availability. State incomplete checks.

## Repository configuration

GitHub must permit Actions-created PRs through **Allow GitHub Actions to create and approve pull requests**. An owner must approve a change to that setting.
The npm trusted publisher must select `souljorje/stelz` and workflow `publish.yml`.
Keep the repository and package public for automatic provenance. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
