# stelz

stelz runs persistent Camoufox profiles through standard MCP, with one browser instance per profile.
There is no global browser or saved-profile count limit.
It needs Bun, Node.js, and Camoufox. It needs no agent harness or LLM credentials.

Install the release archive globally:

```sh
npm install --global ./stelz-0.2.0.tgz
stelz init
stelz setup
stelz ui --open
```

Create a profile in the UI. Add a proxy if necessary, then start the browser.
Connect a client with `stelz mcp --profile YOUR-ID`.

Browser windows show their profile's name and color.
Use the UI's window icon to find a profile's window.
See [Find a profile's windows](docs/ui.md#find-a-profiles-windows).

The archive is not published to npm yet. Build it with `bun install --ignore-scripts` and `bun run pack`.

Each MCP connection selects one profile. One controller can act on that profile at a time.
Client disconnect releases control. The browser and its pages remain open.
Use `stelz stop ID` to stop a browser and save its state.
Closing its browser window also stops the profile. Closing the UI keeps browsers running.

Legacy configuration, data paths, CLI options, and MCP names remain supported.
See [Compatibility](docs/README.md#compatibility) before changing existing configuration.

- [Use the local UI](docs/ui.md)
- [Use the service](docs/README.md)
- [Connect a client](docs/clients.md)
- [Instructions for agents](docs/agents.md)
- [Architecture and design decisions](docs/architecture.md)
- [Development and testing](docs/tests.md)

## Workspace

`apps/ui` contains the private React UI. `packages/stelz` contains the only publishable package.
The package groups source under `cli`, `profiles`, `browser`, `runtime`, `mcp`, and `api`.
Root `docs/` and `examples/` are canonical. Build stages their copies into the package.
Run `bun run verify:release` for browser-free archive verification.
See [Distribution](docs/distribution.md) and [Camofox patches](docs/camofox-patches.md).
