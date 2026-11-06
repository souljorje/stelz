# Start your first browser

Create a persistent `work` profile and open its browser through the manager.
Then connect your existing agent through one shared MCP registration.

## What you need

The tested desktop platform is local macOS on Apple Silicon, running a native ARM64 terminal.
Linux CI checks builds and package installation. It does not establish desktop browser acceptance.

- [Node.js](https://nodejs.org/en/download) 24 or later, including npm.
- [Bun](https://bun.sh/docs/installation) 1.4.4 or later.
- A compatible Camoufox browser. Reuse your existing installation or download one in the browser step below.

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
CAMOFOX_SKIP_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --global stelz
stelz --version
stelz init
```

Keep npm lifecycle scripts enabled. Native dependencies need them.
The download flags keep browser installation explicit.
For a supplied release archive, replace `stelz` in the install command with its absolute `.tgz` path.

If the global npm directory is unwritable, use a user-owned npm prefix and add its `bin` directory to PATH.
The `stelz` command also needs Bun and Node.js on PATH.

Init creates an empty catalog under `~/.local/share/stelz`. It preserves existing profiles and credentials.
For a different directory, set an absolute `STELZ_HOME` before initialization.
Use that same value for the UI, lifecycle commands, and agent connection.

## 2. Locate or download Camoufox

Setup does not download Camoufox. It requires an existing executable.
By default, Stelz checks this location:

```text
~/Library/Caches/camoufox/Camoufox.app/Contents/MacOS/camoufox
```

For another location, set `CAMOUFOX_EXECUTABLE` to its absolute path in the service directory's `secrets.env`.
Preserve other assignments and keep the file private.
An environment variable with the same name takes precedence over the file.
Use `file /absolute/path/to/camoufox` to check the executable's architecture.
Keep an existing profile's compatible browser. Changing the browser can require a migration that Stelz does not provide.

If you have no compatible browser, use Stelz's bundled downloader.
Find the installed package and choose a new, unoccupied directory outside existing browser installations:

```sh
STELZ_PACKAGE="$(npm root --global)/stelz"
CAMOUFOX_INSTALL_DIR="/absolute/new/camoufox-directory" \
  node "$STELZ_PACKAGE/node_modules/camoufox-js/dist/__main__.js" fetch
```

Replace the example directory with your selected absolute path before running the command.
Then add its executable to `secrets.env`:

```dotenv
CAMOUFOX_EXECUTABLE=/absolute/new/camoufox-directory/Camoufox.app/Contents/MacOS/camoufox
```

The default secret file is `~/.local/share/stelz/secrets.env`.
With a custom `STELZ_HOME`, use that directory's secret file instead.

## 3. Prepare the runtime and open the manager

```sh
stelz setup
stelz ui --open
```

Setup checks the browser and prepares the service runtime. It leaves the installed Camoufox app unchanged.
An existing installation must have all profiles safely stopped before setup can replace its runtime.
Do not stop unrelated work to repeat this guide. Reuse a working runtime instead.

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
For an existing profile-bound registration, follow the [one-time migration](clients.md#migrate-an-existing-registration).

Your first-use result is a ready browser, a connected agent, and a successful local interaction.
[Troubleshooting](troubleshooting.md) explains failures at each stage.

Closing the UI leaves browsers open. **Stop** or closing a profile's browser window stops that profile.
See [Manage profiles](ui.md) for everyday controls and [Configure a proxy](proxies.md) for optional networking.
