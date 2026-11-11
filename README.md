<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/stelz-logo-full-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/brand/stelz-logo-full.svg">
    <img src="assets/brand/stelz-logo-full.svg" alt="stelz" width="280">
  </picture>
</h1>

[![npm version](https://img.shields.io/npm/v/stelz)](https://www.npmjs.com/package/stelz)
[![CI](https://github.com/souljorje/stelz/actions/workflows/ci.yml/badge.svg)](https://github.com/souljorje/stelz/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Stealth browser for AI agents.**

Give your agents a real antidetect browser with a persistent profile.
Runs on MCP. Powered by Camoufox.

- **Real browser** with human-like behavior: typing, scrolling, etc
- **Persistent**: keep logins and saved device settings between browser runs
- **Concurrent**: multiple profiles with own **unique fingerprint** and proxy
- **Сontrolled**: pause your agent for manual work in the same window
- **Token efficient**: agent reads accessibility snapshots, not screenshots

![Stelz profile manager with disposable work and research profiles](assets/screenshots/stelz-overview.png)

## Quickstart

Bun ≥1.4.4 and Node.js ≥24 required.

```sh
npm install --global stelz
stelz setup
stelz ui --open
```

The tested desktop platform is macOS on Apple Silicon.

## Agent setup

Send this to an agent, such as Claude Code, Codex, or Hermes:

> Install this skill: https://github.com/souljorje/stelz/blob/main/skills/stelz-browser/SKILL.md

The agent installs Stelz, connects its browser tools, and opens the Stelz UI.

## Docs

- [Getting started](docs/getting-started.md)
- [MCP reference](docs/mcp.md)
- [Agent setup](docs/bootstrap.md)
- [CLI reference](docs/cli.md)
- [Use UI](docs/ui.md)
- [Configure a proxy](docs/proxies.md)
- [Import/export profiles](docs/profile-transfer.md)
- [Troubleshoot](docs/troubleshooting/index.md)
- [Configuration reference](docs/configuration/index.md)

## Contribute

See [Contributing](CONTRIBUTING.md) for development and checks. 

## License

Stelz uses the [MIT license](LICENSE).
