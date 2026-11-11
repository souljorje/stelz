---
title: "Start your first browser"
description: "Prerequisites, installation, setup, first profile, and update steps for a person who uses Stelz for the first time."
tags: [install, setup, profile]
sources: []
created: 2026-11-06T13:49:16Z
modified: 2026-11-11T14:13:54Z
---

# Start your first browser

Install Stelz, run setup, create a persistent `work` profile, and open its browser.

## What you need

Browser Start requires local macOS, because startup must verify the native window geometry. Stelz is tested on Apple Silicon with a native ARM64 terminal.

- [Node.js](https://nodejs.org/en/download) 24 or later, including npm.
- [Bun](https://bun.sh/docs/installation) 1.4.4 or later.

Use your existing runtime manager for Node.js and the official Bun installation instructions.

## 1. Install Stelz

```sh
npm install --global stelz
stelz --version
```

Keep npm lifecycle scripts enabled. Native dependencies need them.
For a supplied release archive, replace `stelz` in the install command with its absolute `.tgz` path.
If the global npm directory is unwritable, use a user-owned npm prefix and add its `bin` directory to PATH.
The `stelz` command also needs Bun and Node.js on PATH.

## 2. Run setup

```sh
stelz setup
```

Setup creates missing service files under `~/.local/share/stelz`. It preserves existing profiles and credentials.
To use another directory, set an absolute `STELZ_HOME` before setup. Use the same value for the UI, lifecycle commands, and agent connection.
See [Service directory and precedence](configuration.md#service-directory-and-precedence).

Setup prepares the browser, the fingerprint model, the location data, and the service runtime.
It reuses valid parts. Missing, damaged, or older location data requires a download.
Before a download, setup shows the list of downloads and asks once. Type `y` to continue.
To allow the downloads without a question, run `stelz setup --yes`.
The browser download is over 1 GB and unpacks to over 2 GB.
To use a Camoufox build that you already have, see [Browser executable](configuration.md#browser-executable).

## 3. Open the manager

```sh
stelz ui --open
```

Keep the command running while you use the UI. See [Open or close the manager](ui.md#open-or-close-the-manager).

## 4. Create and start work

Follow [Create and start a profile](ui.md#create-and-start-a-profile). Name the profile `work` and leave **Proxy** blank.
If `work` already exists, inspect and reuse it instead of replacing it.

## 5. Connect your agent

Follow [Connect your agent](clients.md) to register `stelz mcp` and run a local first task.
For failures, see [Troubleshooting](troubleshooting.md).

## Update Stelz

```sh
npm install --global stelz@latest
stelz setup --yes
stelz restart all   # When you are ready.
```

Setup does not stop running profiles. A running profile keeps the runtime that it started with.
If a running profile or `stelz mcp` fails after an update, restart it.
A profile that needs a restart shows **Restart to update**.
Restart stops the browser and closes its pages, then starts the browser again.
To restart one profile, run `stelz restart ID`. See the [CLI reference](cli.md#browser-lifecycle-and-diagnostics).
