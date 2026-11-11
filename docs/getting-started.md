---
title: "Start your first browser"
description: "Prerequisites, installation, setup, first profile, and update steps for a person who uses Stelz for the first time."
tags: [install, setup, profile]
sources: []
created: 2026-11-06T13:49:16Z
modified: 2026-11-11T14:27:18Z
---

# Start your first browser

Install Stelz, run setup, and open a `work` browser.

## What you need

- Local macOS. Browser Start needs it to verify native window geometry. Tested on Apple Silicon with a native ARM64 terminal.
- [Node.js](https://nodejs.org/en/download) 24 or later, including npm.
- [Bun](https://bun.sh/docs/installation) 1.4.4 or later.

Use your runtime manager for Node.js and the official Bun instructions.

## 1. Install Stelz

```sh
npm install --global stelz
stelz --version
```

- Keep npm lifecycle scripts enabled. Native dependencies need them.
- Release archive: replace `stelz` with the absolute `.tgz` path.
- Unwritable global npm directory: use a user-owned npm prefix and add its `bin` directory to PATH.
- `stelz` needs Bun and Node.js on PATH.

## 2. Run setup

```sh
stelz setup
```

- Creates missing service files under `~/.local/share/stelz`. Preserves existing profiles and credentials.
- Other directory: set an absolute `STELZ_HOME` before setup. Use the same value for the UI, lifecycle commands, and agent connection. See [Service directory and precedence](configuration/environment.md#service-directory-and-precedence).
- Prepares the browser, fingerprint model, location data, and service runtime. Reuses valid parts.
- Missing, damaged, or older location data needs a download. Setup lists the downloads and asks once. Type `y` to continue. `stelz setup --yes` skips the question.
- The browser download is over 1 GB and unpacks to over 2 GB.
- Existing Camoufox build: see [Browser executable](configuration/environment.md#browser-executable).

## 3. Open the manager

```sh
stelz ui --open
```

Keep the command running. See [Open or close the manager](ui.md#open-or-close-the-manager).

## 4. Create and start work

Follow [Create and start a profile](ui.md#create-and-start-a-profile). Name it `work`. Leave **Proxy** blank.
If `work` exists, reuse it.

## 5. Connect your agent

See [Connect your agent](clients.md). For failures, see [Troubleshooting](troubleshooting/index.md).

## Update Stelz

```sh
npm install --global stelz@latest
stelz setup --yes
stelz restart all   # When you are ready.
```

- Setup does not stop running profiles. A running profile keeps its runtime.
- A profile that needs a restart shows **Restart to update**.
- A running profile or `stelz mcp` that fails after an update: restart it.
- Restart stops the browser, closes its pages, ends agent control, and starts the browser again. Clients acquire the profile again.
- One profile: `stelz restart ID`. See [Browser lifecycle and diagnostics](cli.md#browser-lifecycle-and-diagnostics).
