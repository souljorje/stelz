# Prepared Camofox dependencies

Stelz retains Camofox 1.18.1 and camoufox-js 0.11.5. The same eight compatibility edits are now Bun-managed patches in the workspace-root `patches/` directory. Root `package.json` and `bun.lock` record the patches. Only the published `packages/stelz/package.json` declares `bundleDependencies`.

## Development

Run `bun install --frozen-lockfile` from the workspace root with the pinned Bun version. Bun applies the committed patches. Do not use an unpatched npm installation to build a release; the build checks the prepared dependencies before producing artifacts.

To revise a patch, use `bun patch @askjo/camofox-browser@1.18.1` or `bun patch camoufox-js@0.11.5`, edit the prepared package, and run `bun patch --commit` with the same package selector. Commit the resulting patch and lockfile changes together. Never edit Bun's cached package files directly.

| Edit | Purpose | Removal criterion |
| --- | --- | --- |
| Locator fill | Delegate typing to Stelz without changing the upstream locks. | Upstream offers equivalent interaction customization. |
| Executable resource link | Leave installed macOS app bundles unchanged. | Upstream reads resources without writing into the app. |
| Launcher properties path | Read properties from macOS Contents/Resources. | The supported launcher resolves the resource itself. |
| Window and screen bounds | Preserve existing desktop constraints. | Equivalent upstream configuration is available. |
| Proxy WebRTC policy | Preserve the existing proxy launch policy. | Equivalent behavior passes browser acceptance without the edit. |
| Browser launch | Delegate persistent-context creation. | Upstream supports the required context ownership. |
| Context claim | Reuse the original persistent context. | Upstream does not create a replacement context. |
| Native persistence guard | Do not restore checkpoints over native data. | Upstream can disable checkpoint persistence per native profile. |

## Release and installation

The Stelz npm archive includes the prepared Camofox and camoufox-js packages, with their dependency closure and licenses. It does not compile the upstream server into one JavaScript bundle. Consumers do not need the workspace's patch files or a patching install hook.

`stelz setup` copies the prepared dependency files into its staged runtime, verifies the required edits, installs the Stelz plugin/configuration, validates imports, and activates the runtime atomically. It never applies source replacements. Missing or ambiguous prepared edits fail before activation; existing profiles and the previous runtime remain intact. Existing stopped-profile, ownership, admission-lock, and filesystem checks remain in place.

`bun run verify:release` installs the actual tarball with `npm install --ignore-scripts` outside the checkout. It checks both Stelz's launcher and the launcher Camofox resolves, compares the modified files with the tested build, and runs browser-free setup. `bun run test:package` performs the installed real-browser acceptance separately on a supported desktop. Neither check proves browser behavior merely because patch markers exist.

Stop profiles before a package upgrade, install the new Stelz release, run setup, then restart explicitly. Bundling does not make active package upgrades safe. Upstream version changes and browser-version migration remain separate changes.
