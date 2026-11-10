# Contribute to Stelz

Stelz is a standalone browser service. Read [Architecture](docs/development/architecture.md) before changing service boundaries.
Use TypeScript and Bun for new code. Preserve other contributors' edits and existing client approval protections.

## Prepare and submit a change

1. Install Node.js 24 or later and the Bun version in `package.json`'s `packageManager` field.
   Install the pinned development dependencies from the repository root:

   ```sh
   bun install --frozen-lockfile --ignore-scripts
   ```

   Install the Git hooks once per clone:

   ```sh
   bunx lefthook install
   ```

   Git shares the hooks with every worktree of the clone. New BB worktrees install them through `.bb-env-setup.sh`.
   Before each commit, the hooks check TypeScript and run the regression tests and the Bun tests that import the changed files.
   That selection misses tests that reach a change only through a CLI subprocess. Before each push, the hooks run `bun run check`.

2. Make the change. Run the standard checks:

   ```sh
   bun run check
   ```

   This command builds the package, checks TypeScript, and runs the tests that require no browser.

3. Select additional tests from [Testing](docs/development/testing.md).
   `bunx lefthook run browser` runs the browser suites for the files that your branch changes.
   Browser, proxy, UI, transfer, and package changes need the relevant acceptance checks.
   Record results and limits. Keep credentials and private browser data outside Git.

4. Add a Changeset when the change needs a package release:

   ```sh
   bun run changeset
   ```

   Select `stelz` and describe the effect on users. Include the Changeset with the change.
   See [Releasing](docs/development/releasing.md) for version increments, archive validation, and publication.

5. Submit a pull request. Describe the problem, resulting behavior, checks, and remaining limits.
   Use conventional commit messages. Separate large changes into logical commits.

For dependency patches, follow [Camofox integration](docs/development/camofox-integration.md).
Use plain English in documentation. Keep dated acceptance results in `docs/development/reports/`.

## Run Stelz from a checkout

Link the checkout to use your local build as the `stelz` command:

```sh
bun run build
bun link
stelz setup
```

`bun link` adds `stelz` to `~/.bun/bin`. Bun's installer puts that folder on `PATH`. The command runs the checkout's `dist/` files.
After a change, run `bun run build` and `stelz setup`. Then run `stelz restart all` to move running profiles to the new runtime.
Running profiles load dependencies from the checkout's `node_modules`. Restart them after `bun install` or after a switch to a branch with other dependencies.
Run `bun unlink` to remove the command. For release acceptance, install the packed archive instead. See [Installed-package acceptance](docs/development/testing.md#installed-package-acceptance).

## Service rules

- Keep browser state under `STELZ_HOME`. Preserve profile IDs, data paths, and configured secret references.
- Permit one browser instance and one MCP controller per profile. Do not add global profile or browser limits.
- Release and disconnect must preserve the browser and its pages. Browser shutdown requires an explicit lifecycle action.
- Keep reasoning and conversation history in the client. The service must run without an agent harness or model credentials.
- Reuse the upstream Camofox server and MCP contracts. Read the [canonical browser skill](skills/stelz-browser/SKILL.md) for client behavior.
- Use fresh browser observations. Pause for human authentication in the same window. Do not bypass authentication challenges.

## Documentation

| Reader or task | Page |
| --- | --- |
| User documentation index | [Documentation](docs/README.md) |
| Installation and first UI task | [Getting started](docs/getting-started.md) |
| Agent installation orchestration | [Bootstrap](docs/bootstrap.md) |
| Client registration and verification | [Clients](docs/clients.md) |
| Local profile controls | [UI](docs/ui.md) |
| Network configuration | [Proxies](docs/proxies.md) |
| Profile archives | [Profile transfer](docs/profile-transfer.md) |
| Failures and recovery | [Troubleshooting](docs/troubleshooting.md) |
| Command reference | [CLI](docs/cli.md) |
| Files and settings | [Configuration](docs/configuration.md) |

Contributor documents cover implementation details and reproducible checks.
Historical reports describe only the recorded environments and runs.
