# stelz

stelz runs persistent Camoufox identities through standard MCP, with up to two active browsers.
It needs Bun, Node.js, and Camoufox. It needs no agent harness or LLM credentials.

Install the release archive globally:

```sh
npm install --global ./stelz-0.2.0.tgz
stelz init
stelz setup
stelz ui --open
```

Create an identity in the UI. Add a proxy if necessary, then start the browser.
Connect a client with `stelz mcp --identity YOUR-ID`.

The archive is not published to npm yet. Build it with `bun install`, `bun run build`, and `npm pack`.

Each MCP connection selects one identity. One controller can act on that identity at a time.
Client disconnect releases control. The browser and its pages remain open.
Use `stelz stop ID` to stop a browser and save its state.
Closing its browser window also stops the identity. Closing the UI keeps browsers running.

- [Use the local UI](docs/ui.md)
- [Use the service](docs/README.md)
- [Connect a client](docs/clients.md)
- [Instructions for agents](docs/agents.md)
- [Development and testing](docs/tests.md)
