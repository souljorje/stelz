import {
  copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync,
  readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { dlopen, FFIType } from "bun:ffi";
import { ROOT, HOME_DIR, STATE, UPSTREAM, COMMIT, UPSTREAM_VERSION, executable, initialize, settings } from "./config.ts";
import { MCP_SDK_VERSION, STELZ_VERSION } from "./versions.ts";
import { lock, running } from "./runtime.ts";

function packagePath(name: string, from: string): string {
  const require = createRequire(join(from, "package.json"));
  let path: string;
  try {
    path = dirname(require.resolve(`${name}/package.json`));
  } catch {
    const entry = name === "@modelcontextprotocol/sdk" ? `${name}/server/index.js` : name;
    path = dirname(require.resolve(entry));
  }
  for (;;) {
    const manifest = join(path, "package.json");
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === name) return path;
    const parent = dirname(path);
    if (parent === path) throw Error(`Cannot locate dependency: ${name}`);
    path = parent;
  }
}

function stat(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function directory(path: string) {
  const info = stat(path);
  if (info && !info.isDirectory()) throw Error(`Expected a directory, not a link or file: ${path}`);
}

function stateFile<T>(file: string): T | undefined {
  const info = stat(file);
  if (!info) return;
  if (!info.isFile()) throw Error(`Invalid identity state: ${file}`);
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    throw Error(`Cannot read identity state: ${file}`);
  }
}

function assertStopped() {
  settings();
  for (const item of readdirSync(STATE, { withFileTypes: true })) {
    if (item.name === "admission.lock") continue;
    if (item.isSymbolicLink()) throw Error(`Invalid identity directory: ${item.name}`);
    if (!item.isDirectory()) continue;

    const base = join(STATE, item.name);
    const record = stateFile<{ pid?: unknown; serverPid?: unknown; instanceId?: unknown }>(join(base, "running.json"));
    if (record === undefined) continue;
    if (record === null || typeof record !== "object" || !Number.isSafeInteger(record.pid) || (record.pid as number) < 0 ||
        (record.serverPid !== undefined && (!Number.isSafeInteger(record.serverPid) || (record.serverPid as number) < 1)) ||
        typeof record.instanceId !== "string" || !record.instanceId) {
      throw Error(`Invalid identity state: ${item.name}`);
    }

    const stopped = stateFile<{ instanceId?: unknown }>(join(base, "stopped.json"));
    if (stopped?.instanceId !== record.instanceId || running(item.name)) {
      throw Error(`${item.name}: stop all identities and resolve unclean or orphaned processes before setup.`);
    }
  }
}

function copy(source: string, target: string, skipModules = false) {
  cpSync(source, target, {
    recursive: true,
    filter: path => {
      if (skipModules && relative(source, path).split(sep).includes("node_modules")) return false;
      if (lstatSync(path).isSymbolicLink()) throw Error(`Setup source contains a symbolic link: ${path}`);
      return true;
    },
  });
}

function patch(file: string, before: string, after: string) {
  const text = readFileSync(file, "utf8");
  const oldCount = text.split(before).length - 1;
  const newCount = text.split(after).length - 1;
  if (newCount === 1 && !text.replace(after, "").includes(before)) return;
  if (oldCount !== 1 || newCount !== 0) throw Error(`The pinned compatibility patch does not match ${file}.`);
  writeFileSync(file, text.replace(before, after));
}

function node(args: string[]) {
  const result = Bun.spawnSync(["node", ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw Error(`Node validation failed: ${result.stderr.toString().trim() || args.join(" ")}`);
  }
  return result.stdout.toString().trim();
}

function copyDependencies(source: string, upstream: string) {
  const modules = join(upstream, "node_modules");
  mkdirSync(modules, { recursive: true });
  const camoufox = packagePath("camoufox-js", ROOT);
  const dependencies = {
    ...JSON.parse(readFileSync(join(source, "package.json"), "utf8")).dependencies,
    ...JSON.parse(readFileSync(join(camoufox, "package.json"), "utf8")).dependencies,
    "@modelcontextprotocol/sdk": MCP_SDK_VERSION,
  };
  const paths = new Map<string, string>();
  for (const name of Object.keys(dependencies)) {
    if (!/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(name)) {
      throw Error(`Invalid dependency name: ${name}`);
    }
    const target = join(modules, name);
    mkdirSync(dirname(target), { recursive: true });
    const dependency = name === "camoufox-js" ? camoufox : packagePath(name, source);
    paths.set(name, dependency);
    if (name === "camoufox-js") {
      copy(dependency, target, true);
    } else {
      symlinkSync(dependency, target, "dir");
      if (realpathSync(target) !== realpathSync(dependency)) throw Error(`Cannot validate dependency: ${name}`);
    }
  }
  return paths;
}

function applyPatches(upstream: string) {
  patch(join(upstream, "server.js"),
    "await locator.fill(text, { timeout: 10000 });",
    "await (await import('./plugins/local-profile/index.js')).typeIntoLocator(locator, text);");
  patch(join(upstream, "lib/camoufox-executable.js"),
    "if (!existsSync(executableProperties)) ensureSymlink(realpathSync(resourceProperties), executableProperties);",
    "// stelz: read macOS resources without changing the installed app bundle.");
  patch(join(upstream, "node_modules/camoufox-js/dist/utils.js"),
    'propFile = path.join(path.dirname(filePath), "properties.json");',
    'propFile = process.platform === "darwin" && filePath.includes(".app/Contents/MacOS/") ? path.join(path.dirname(filePath), "../Resources/properties.json") : path.join(path.dirname(filePath), "properties.json");');
  patch(join(upstream, "server.js"), "os: hostOS,\n        humanize: true,",
    "os: hostOS,\n        window: [1200, 800],\n        screen: { minWidth: 1280, minHeight: 900, maxWidth: 1920, maxHeight: 1200 },\n        humanize: true,");
  patch(join(upstream, "server.js"), "proxy: launchProxy,\n        geoip: !!launchProxy,",
    "proxy: launchProxy,\n        block_webrtc: !!launchProxy,\n        geoip: !!launchProxy,");
  patch(join(upstream, "server.js"), "candidateBrowser = await firefox.launch(options);",
    "candidateBrowser = await (await import('./plugins/local-profile/index.js')).launchIdentityBrowser(firefox, options, { viewport: null, ...contextIdentityOptions({ hasProxy: !!proxyPool, directIdentity: CONFIG.directIdentity }) });");
  patch(join(upstream, "server.js"), "const context = await b.newContext(contextOptions);",
    "const context = await (await import('./plugins/local-profile/index.js')).claimIdentityContext(b, contextOptions);");
  patch(join(upstream, "plugins/persistence/index.js"), "export async function register(app, ctx, pluginConfig = {}) {",
    "export async function register(app, ctx, pluginConfig = {}) {\n  if (process.env.STELZ_STORAGE_MODE === 'native') return; // Native Firefox profile owns storage.");
}

function writeManifest(stage: string, browser: string, dependencies: Map<string, string>) {
  const versionDirectory = browser.includes(".app/Contents/MacOS/")
    ? dirname(dirname(dirname(dirname(browser))))
    : dirname(browser);
  const versionPath = join(versionDirectory, "version.json");
  const versions = Object.fromEntries(["camoufox-js", "playwright-core", "@modelcontextprotocol/sdk"].map(name => {
    const path = dependencies.get(name);
    if (!path) throw Error(`Missing dependency: ${name}`);
    return [name, JSON.parse(readFileSync(join(path, "package.json"), "utf8")).version];
  }));
  const nodeVersion = node(["--version"]);
  if (!/^v\d+\.\d+\.\d+/.test(nodeVersion) || Number(nodeVersion.slice(1).split(".")[0]) < 24) {
    throw Error("Node.js 24 or later is required.");
  }
  const manifest = {
    stelz: STELZ_VERSION,
    upstreamVersion: UPSTREAM_VERSION,
    sourceCommit: COMMIT,
    camoufoxExecutable: browser,
    browserVersion: existsSync(versionPath) ? JSON.parse(readFileSync(versionPath, "utf8")) : null,
    executableSha256: createHash("sha256").update(readFileSync(browser)).digest("hex"),
    dependencies: versions,
    bun: Bun.version,
    node: nodeVersion,
  };
  writeFileSync(join(stage, "versions.json"), JSON.stringify(manifest, null, 2));
}

function validate(upstream: string) {
  const contract = join(upstream, "mcp/lib/tool-contracts.mjs");
  const plugin = join(upstream, "plugins/local-profile/index.js");
  const script = `
    const contract = await import(process.argv[1]);
    const plugin = await import(process.argv[2]);
    if (!Array.isArray(contract.TOOL_DEFS) || typeof contract.runTool !== "function" || typeof contract.adaptResponse !== "function") {
      throw Error("Invalid Camofox tool contracts.");
    }
    for (const name of ["register", "launchIdentityBrowser", "claimIdentityContext", "typeIntoLocator"]) {
      if (typeof plugin[name] !== "function") throw Error("Missing local-profile export: " + name);
    }
  `;
  node(["--input-type=module", "-e", script, pathToFileURL(contract).href, pathToFileURL(plugin).href]);
  for (const file of [
    "server.js",
    "lib/camoufox-executable.js",
    "node_modules/camoufox-js/dist/utils.js",
    "plugins/persistence/index.js",
    "plugins/local-profile/index.js",
  ]) {
    node(["--check", join(upstream, file)]);
  }
}

function stageRuntime(stage: string, source: string, browser: string, plugin: string) {
  const upstream = join(stage, basename(UPSTREAM));
  mkdirSync(upstream, { mode: 0o700 });
  for (const name of ["server.js", "package.json", "LICENSE", "lib", "mcp", "plugins/persistence"]) {
    copy(join(source, name), join(upstream, name));
  }
  const dependencies = copyDependencies(source, upstream);
  applyPatches(upstream);

  const output = join(upstream, "plugins/local-profile/index.js");
  mkdirSync(dirname(output), { recursive: true });
  copyFileSync(plugin, output);
  const config = {
    interactive: { mode: "desktop" },
    plugins: { persistence: { enabled: true, indexedDB: true }, "local-profile": { enabled: true } },
  };
  writeFileSync(join(upstream, "camofox.config.json"), JSON.stringify(config, null, 2));
  writeManifest(stage, browser, dependencies);
  validate(upstream);
}

// Exchange complete sibling directories so a legacy runtime and its manifest move together.
// A filesystem without an atomic exchange must fail rather than use a two-rename fallback.
function activate(stage: string) {
  const target = join(HOME_DIR, "runtime");
  directory(target);
  if (!stat(target)) {
    renameSync(stage, target);
    return;
  }
  const a = Buffer.from(`${stage}\0`);
  const b = Buffer.from(`${target}\0`);
  let result: number;
  if (process.platform === "darwin") {
    const lib = dlopen("/usr/lib/libSystem.B.dylib", {
      renamex_np: { args: [FFIType.cstring, FFIType.cstring, FFIType.u32], returns: FFIType.i32 },
    });
    try {
      result = lib.symbols.renamex_np(a, b, 2);
    } finally {
      lib.close();
    }
  } else if (process.platform === "linux") {
    const lib = dlopen("libc.so.6", {
      renameat2: { args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring, FFIType.u32], returns: FFIType.i32 },
    });
    try {
      result = lib.symbols.renameat2(-100, a, -100, b, 2);
    } finally {
      lib.close();
    }
  } else {
    throw Error("Atomic runtime replacement is not supported on this platform.");
  }
  if (result !== 0) throw Error("Cannot atomically replace the runtime on this filesystem.");
}

export async function setup() {
  directory(HOME_DIR);
  directory(STATE);
  directory(join(HOME_DIR, "runtime"));
  mkdirSync(STATE, { recursive: true, mode: 0o700 });

  const admission = join(STATE, "admission.lock");
  const existingLock = stat(admission);
  if (existingLock && (!existingLock.isFile() || existingLock.nlink !== 1)) {
    throw Error(`Invalid admission lock: ${admission}`);
  }
  await lock(admission, async () => {
    initialize();
    assertStopped();

    const browser = executable();
    if (!existsSync(browser) || !statSync(browser).isFile()) {
      throw Error(`Camoufox is missing at ${browser}. Set CAMOUFOX_EXECUTABLE in secrets.env.`);
    }
    const source = packagePath("@askjo/camofox-browser", ROOT);
    if (JSON.parse(readFileSync(join(source, "package.json"), "utf8")).version !== UPSTREAM_VERSION) {
      throw Error("The installed Camofox version does not match the pinned version.");
    }
    const plugin = join(ROOT, "dist/plugin.js");
    if (!stat(plugin)?.isFile()) throw Error("Build the package before setup.");

    const stage = mkdtempSync(join(HOME_DIR, ".runtime-setup-"));
    let activated = false;
    try {
      stageRuntime(stage, source, browser, plugin);
      activate(stage);
      activated = true;
    } finally {
      // After exchange this path contains the old runtime. Do not follow links during cleanup.
      try {
        rmSync(stage, { recursive: true, force: true });
      } catch (error) {
        if (!activated) throw error;
      }
    }
  });
  console.log(`Service files are ready in ${HOME_DIR}. The installed browser is unchanged.`);
}
