# Contribute to Stelz

Before you change what Stelz does, read [Stelz as a product](docs/product.md) and [Architecture](docs/development/architecture.md).
New code: TypeScript and Bun. Preserve other contributors' edits and client approval protections.

## Prepare and submit a change

1. Install Node.js 24+ and the Bun version in `package.json` `packageManager`. Then, from the repository root:

   ```sh
   bun install --frozen-lockfile --ignore-scripts
   bunx lefthook install   # once per clone
   ```

   Hooks apply to every worktree of the clone. New BB worktrees install them through `.bb-env-setup.sh`.
   - Pre-commit: typecheck, regression tests, and the Bun tests that import changed files. Misses tests that reach a change only through a CLI subprocess.
   - Pre-push: `bun run check`.
2. Make the change. Run `bun run check`: build, typecheck, and all tests that need no browser.
3. Run more tests from [Testing](docs/development/testing.md) and [Acceptance](docs/development/acceptance.md).
   - `bunx lefthook run browser`: the browser suites for the files that your branch changes.
   - Browser, proxy, UI, transfer, and package changes: the matching acceptance checks.
   - Keep credentials and private browser data outside Git.
4. If the change needs a package release, run `bun run changeset`. Select `stelz` and describe the effect on users. See [Releasing](docs/development/releasing.md).
5. Open a pull request: problem, new behavior, checks, acceptance results, and remaining limits.
   Conventional commit messages. Split large changes into logical commits.

Dependency patches: [Camofox integration](docs/development/camofox-integration.md).

## Run Stelz from a checkout

```sh
bun run build
bun link       # adds `stelz` to ~/.bun/bin, which runs this checkout's dist/
stelz setup
```

- After a change: `bun run build`, `stelz setup`, then `stelz restart all` to move running profiles to the new runtime.
- Running profiles load dependencies from the checkout's `node_modules`. Restart them after `bun install` or a switch to a branch with other dependencies.
- Remove the command: `bun unlink`.
- Release acceptance uses the packed archive instead. See [Installed-package acceptance](docs/development/acceptance.md#installed-package-acceptance).

## Documentation

Start at the [documentation index](docs/index.md). Contributor documents: [Development](docs/development/index.md).
Apply the ASD-STE100 writing rules. Keep each fact in one document, and link to it from other documents.
