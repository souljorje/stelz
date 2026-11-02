# stelz

stelz runs two persistent Camoufox identities through standard MCP.
It needs Bun, Node.js, and Camoufox. It needs no agent harness or LLM credentials.

Install the release archive globally:

```sh
npm install --global ./stelz-0.2.0.tgz
stelz init
stelz setup
stelz start identity-02
stelz mcp --identity identity-02
```

The archive is not published to npm yet. Build it with `bun install`, `bun run build`, and `npm pack`.

Each MCP connection selects one identity. One controller can act on that identity at a time.
Client disconnect releases control. The browser and its pages remain open.
Use `stelz stop ID` to stop a browser and save its state.

- [Use the service](docs/README.md)
- [Connect a client](docs/clients.md)
- [Instructions for agents](docs/agents.md)
- [Development and testing](docs/tests.md)
