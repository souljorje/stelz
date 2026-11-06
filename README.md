# stelz

[MIT license](LICENSE)

stelz runs persistent Camoufox profiles through standard MCP, with one browser instance per profile.
There is no global browser or saved-profile count limit.
It needs Bun, Node.js, and Camoufox. It needs no agent harness or LLM credentials.

Give a local coding agent access to this package folder or archive, then ask:

> Follow the [installation guide](docs/bootstrap.md). Create or reuse profile `work`. Start its browser. Open the management UI. Connect your browser tools. Check browser control. Preserve existing profiles, credentials, and client settings. Report what is ready and any action I must complete.

Install Stelz globally:

```sh
npm install --global stelz
stelz init
stelz setup
stelz ui --open
```

Create a profile in the UI. Add a proxy if necessary, then start the browser.
Connect a client with `stelz mcp --profile YOUR-ID`.

Browser windows show their profile's name and color.
Use the UI's window icon to find a profile's window.
See [Find a profile's windows](docs/ui.md#find-a-profiles-windows).

Build a release archive with `bun install --ignore-scripts` and `bun run pack`.
Install a tested archive with `npm install --global ./release-artifacts/stelz-0.2.1.tgz`.

Each MCP connection selects one profile. One controller can act on that profile at a time.
Client disconnect releases control. The browser and its pages remain open.
Use `stelz stop ID` to stop a browser and save its state.
Closing its browser window also stops the profile. Closing the UI keeps browsers running.


- [Use the local UI](docs/ui.md)
- [Import and export profiles](docs/profile-transfer.md)
- [Use the service](docs/README.md)
- [Connect a client](docs/clients.md)
- [Instructions for agents](docs/agents.md)
- [Architecture and design decisions](docs/architecture.md)
- [Development and testing](docs/tests.md)

## Development

`src/` contains the service. `ui/` contains the bundled React UI.
The root manifest defines the published package and development commands.
Build uses `docs/`, `examples/`, and `skills/` directly. It does not copy documentation.
Run `bun run check` for build, TypeScript checks, and browser-free tests.
Run `bun run pack` to create `release-artifacts/stelz-0.2.1.tgz`.
Run `bun run verify:release` to check that saved archive without a browser or rebuild.
See [Distribution](docs/distribution.md) and [Camofox patches](docs/camofox-patches.md).
