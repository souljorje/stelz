# Smooth setup and updates

## Status and scope

This plan follows Phase 3 of the [official launcher migration](official-launcher-migration.md). Its final archive feeds [Phase 6](official-launcher-migration.md#phase-6-acceptance-and-delivery), so one archive gets one acceptance run.
Stelz is in early alpha. It keeps no backward compatibility until 1.0. uBlock Origin is out of scope.

## Target experience

Bun `>=1.4.4` and Node.js `>=24` are prerequisites. Stelz does not install them.

```sh
npm install -g stelz
stelz setup                # A person confirms the downloads once.
stelz setup --yes --json   # An agent: no prompts, one JSON result.
```

To update Stelz:

```sh
npm install -g stelz@latest
stelz setup --yes
stelz restart all          # When you are ready. Running profiles continue until then.
```

Users do not edit `secrets.env` for the browser or look inside `node_modules`.

## 1. One setup command

- Remove `stelz init`. Setup creates missing service files.
- Setup checks the platform and the Node.js and Bun versions. Then it prepares the browser, fingerprint model, location data, and runtime, and reports the next step.
- `--yes` authorizes the downloads that the plan requires. `--json` never prompts. It writes one result to stdout and progress to stderr.
- When all parts are ready, setup makes no network request and succeeds offline.

## 2. Browser discovery and download

Setup selects the first available source:

| Order | Source | Upstream reuse |
| --- | --- | --- |
| 1 | `CAMOUFOX_EXECUTABLE`. It must be the paired build. Otherwise setup fails and selects no other browser. | Paired-build check |
| 2 | The managed copy in `STELZ_HOME/browsers/<version>-<build>/`. | `launchPath(dir)` |
| 3 | The paired build in the upstream cache. Setup reads it only and clones it into the managed directory. | `listInstalled` |
| 4 | The paired release download. `browser-pin.json` identifies the release and `repos.yml` names the asset. Setup verifies the GitHub SHA-256 digest and fails closed without one. It stages the files before activation. | Asset name rule, `unzip`, `makeExecutable` |

Do not call `CamoufoxFetcher.install`, the `camoufox fetch` CLI, `resolveInstalledPath`, or `ensureCamoufoxInstalled`. They write only to the shared cache, can delete it, or download during launch.
The runtime manifest records the selected browser. It becomes the default executable. `CAMOUFOX_EXECUTABLE` remains an override.
One helper downloads and verifies a GitHub release asset for the browser and for location data.

A release can change the paired browser. Profiles pinned to the old engine cannot start. Setup lists those profiles before activation and continues only with `--yes`. Plan an engine upgrade before 1.0.

## 3. Updates without downtime

- Each runtime is a generation directory `runtime-generations/<id>`. The ID comes from the setup inputs. `runtime` is a link to the current generation, and setup switches it atomically. Setup reuses an unchanged generation.
- A running service keeps the runtime that it started with. New starts use the current runtime. Setup removes old runtimes that no service uses.
- Deferred: the runtime copies its dependencies with APFS clones instead of linking into the installed package. Transitive and nested Camofox dependencies do not resolve from a plain clone, and most modules load at service start.
- Setup holds the admission lock only to create service files and to switch the generation, not during downloads.
- An earlier plain `runtime/` directory blocks setup while any profile runs. Stop those profiles first.
- Status and the UI mark profiles that run an older runtime with **Restart to update**.
- `stelz restart ID|all` stops and then starts running profiles explicitly. A failed start leaves that profile stopped.
- Known limits: a long-lived `stelz mcp` uses the current generation's tool contracts, and one call can fail while setup removes an old generation. A restart clears both.

## 4. Setup report

Setup does not launch a disposable browser. The first explicit Start verifies the browser before Ready.
The report states for each part whether setup selected, reused, or downloaded it.

## 5. Documentation and UI

- The install guide lists the prerequisites and the commands above, and adds an update section.
- Remove the manual Camoufox download, `launchPath`, and `CAMOUFOX_EXECUTABLE` editing steps.
- The agent bootstrap uses `stelz setup --yes --json`.
- The UI first-run screen shows setup status and the exact command, plus the **Restart to update** mark.

## 6. Delivery order and acceptance

1. The release-asset helper, browser provisioning, and the default executable.
2. One setup command, with `--yes`, `--json`, and the report.
3. Versioned runtimes, the shorter lock, the update mark, and `stelz restart`.
4. Documentation, the UI, and the agent skill.
5. Acceptance on one archive with `bun run test:setup --archive FILE`:
   - a fresh install without a browser;
   - an offline repeat;
   - a clone from the upstream cache;
   - a wrong explicit build;
   - an interrupted download and retry;
   - concurrent setup;
   - setup with running profiles, then a restart;
   - an update with the same browser;
   - the JSON result.

Linux remains deferred. Setup selects the asset by platform, but only macOS arm64 is tested.
