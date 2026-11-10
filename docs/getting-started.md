# Start your first browser

Create a persistent `work` profile and open its browser through the manager.
Then connect your existing agent through one shared MCP registration.

## What you need

The tested desktop platform is local macOS on Apple Silicon, running a native ARM64 terminal.
Browser Start requires macOS because startup must verify the native window geometry.
Linux CI checks builds and package installation. It does not establish desktop browser acceptance.

- [Node.js](https://nodejs.org/en/download) 24 or later, including npm.
- [Bun](https://bun.sh/docs/installation) 1.4.4 or later.

Check your environment:

```sh
uname -s
uname -m
node --version
npm --version
bun --version
```

For this guide, the first two results must be `Darwin` and `arm64`.
Use your existing runtime manager for Node.js and the official Bun installation instructions.
Keep compatible existing installations.

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
For a different directory, set an absolute `STELZ_HOME` before setup.
Use that same value for the UI, lifecycle commands, and agent connection.

Setup prepares the browser, the fingerprint model, the location data, and the service runtime.
It reuses valid parts. Missing, damaged, or older location data requires a download.
Before a download, setup shows the list of downloads and asks once. Type `y` to continue.
To allow the downloads without a question, run `stelz setup --yes`.
The browser download is over 1 GB and unpacks to over 2 GB.

### How setup finds the browser

Stelz supports only the Camoufox build that its launcher pairs with, currently `156.0.1-beta.36`.
Setup uses the first available source:

1. The executable in `CAMOUFOX_EXECUTABLE`, if you set it.
2. Stelz's own copy in `STELZ_HOME/browsers/<version>-<build>/`.
3. The paired build in the upstream Camoufox cache. Setup copies it into `STELZ_HOME/browsers/`. It does not change the cache.
4. A download of the paired release. Setup verifies the published SHA-256 digest.

You do not need to set `CAMOUFOX_EXECUTABLE`. To use another installation of the paired build, set it to the absolute executable path.
Use the process environment or `STELZ_HOME/secrets.env`. The process environment takes precedence.
Use the executable inside `Camoufox.app/Contents/MacOS/`, not the `camoufox` command on PATH.
Then run `stelz setup`. If that file is not the paired build, setup fails. It does not try another source.
Start also rejects other builds. A profile pinned to another build cannot start. Stelz does not upgrade a profile's browser.

## 3. Open the manager

```sh
stelz ui --open
```

For a proxy, **Location alignment** shows known problems before Start. **Check connection** checks the route without launching a browser.
Start always checks the current route again. **Ready to start** does not mean that a browser is running.

The UI opens a private session at `127.0.0.1:9380`.
Keep the terminal command running while you use it.
If that port is occupied, use `stelz ui --port 9381 --open`.

## 4. Create and start work

1. Open **Profiles** and select **New profile**.
2. Enter `work` as the profile name.
3. Leave **Proxy** blank for a direct connection.
4. Select **Create profile**.
5. Select **Start** for `work`.

Creation saves a profile without opening a browser. Start opens its visible browser.
The profile should report **Ready**, and its browser window should have a `[work]` title prefix.
Use the window icon beside **Stop** to bring it forward.
If `work` already exists, inspect and reuse it instead of replacing it.

## 5. Connect your agent

Follow [Connect your agent](clients.md) for registration and a local first task.
The shared `stelz mcp` registration serves every profile through explicit tool arguments.
Agents can also create direct profiles and start browsers through MCP. New profiles require no new registration.
That check confirms your agent can act through its real browser tools and release control without closing the browser.

Your first-use result is a ready browser, a connected agent, and a successful local interaction.
[Troubleshooting](troubleshooting.md) explains failures at each stage.

Closing the UI leaves browsers open. **Stop** or closing a profile's browser window stops that profile.
See [Manage profiles](ui.md) for everyday controls and [Configure a proxy](proxies.md) for optional networking.

## Update Stelz

```sh
npm install --global stelz@latest
stelz setup --yes
stelz restart all   # When you are ready.
```

Setup does not stop running profiles. A running profile keeps the runtime that it started with.
Its dependencies still load from the installed package. If a running profile or `stelz mcp` fails after an update, restart it.
If setup prepared a new runtime, the profile shows **Restart to update**.
Restart stops the browser and closes its pages, then starts the browser again.
To restart one profile, run `stelz restart ID`. See the [CLI reference](cli.md#browser-lifecycle-and-diagnostics).
