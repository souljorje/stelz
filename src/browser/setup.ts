import { assertBundledPatches } from "./camofox-adapter.ts";
import { geoipPlan, prepareGeoip, type GeoipStatus } from "./geoip-setup.ts";
import { fingerprintModel, isPreparedModel, pairedBrowser } from "./camoufox.ts";
import { browserPlan, prepareBrowser, type BrowserSource } from "./browser-setup.ts";
import { GEOIP_SOURCES, type GeoipRole } from "./location.ts";
import {
  copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync,
  readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { dlopen, FFIType } from "bun:ffi";
import { ROOT, HOME_DIR, STATE, UPSTREAM, COMMIT, UPSTREAM_VERSION, initialize, secret, settings } from "../profiles/config.ts";
import { STELZ_VERSION } from "../versions.ts";
import { lock, running } from "../runtime/runtime.ts";

const CAMOFOX = "@askjo/camofox-browser";
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
  if (!info.isFile()) throw Error(`Invalid profile state: ${file}`);
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    throw Error(`Cannot read profile state: ${file}`);
  }
}

function assertStopped() {
  settings();
  for (const item of readdirSync(STATE, { withFileTypes: true })) {
    if (item.name === "admission.lock") continue;
    if (item.isSymbolicLink()) throw Error(`Invalid profile directory: ${item.name}`);
    if (!item.isDirectory()) continue;

    const base = join(STATE, item.name);
    const record = stateFile<{ pid?: unknown; serverPid?: unknown; instanceId?: unknown }>(join(base, "running.json"));
    if (record === undefined) continue;
    if (record === null || typeof record !== "object" || !Number.isSafeInteger(record.pid) || (record.pid as number) < 0 ||
        (record.serverPid !== undefined && (!Number.isSafeInteger(record.serverPid) || (record.serverPid as number) < 1)) ||
        typeof record.instanceId !== "string" || !record.instanceId) {
      throw Error(`Invalid profile state: ${item.name}`);
    }

    const stopped = stateFile<{ instanceId?: unknown }>(join(base, "stopped.json"));
    if (stopped?.instanceId !== record.instanceId || running(item.name)) {
      throw Error(`${item.name}: stop all profiles and resolve unclean or orphaned processes before setup.`);
    }
  }
}

function copy(source: string, target: string) {
  cpSync(source, target, {
    recursive: true,
    filter: path => {
      if (lstatSync(path).isSymbolicLink()) throw Error(`Setup source contains a symbolic link: ${path}`);
      return true;
    },
  });
}

function node(args: string[]) {
  const result = Bun.spawnSync(["node", ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw Error(`Node validation failed: ${result.stderr.toString().trim() || args.join(" ")}`);
  }
  return result.stdout.toString().trim();
}

// Stelz dependencies, including the launcher and the plugin's imports, come from the product.
// Other Camofox dependencies resolve from Camofox.
function copyDependencies(source: string, upstream: string) {
  const modules = join(upstream, "node_modules");
  mkdirSync(modules, { recursive: true });
  const product = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).dependencies as Record<string, string>;
  const names = new Set([...Object.keys(JSON.parse(readFileSync(join(source, "package.json"), "utf8")).dependencies), ...Object.keys(product)]);
  names.delete(CAMOFOX);
  const paths = new Map<string, string>();
  for (const name of names) {
    if (!/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(name)) {
      throw Error(`Invalid dependency name: ${name}`);
    }
    const target = join(modules, name);
    mkdirSync(dirname(target), { recursive: true });
    const dependency = packagePath(name, name in product ? ROOT : source);
    paths.set(name, dependency);
    symlinkSync(dependency, target, "dir");
    if (realpathSync(target) !== realpathSync(dependency)) throw Error(`Cannot validate dependency: ${name}`);
  }
  return paths;
}

function writeManifest(stage: string, browser: string, dependencies: Map<string, string>) {
  const versionDirectory = browser.includes(".app/Contents/MacOS/")
    ? dirname(dirname(dirname(dirname(browser))))
    : dirname(browser);
  const versionPath = join(versionDirectory, "version.json");
  const versions = Object.fromEntries(["camoufox", "playwright-core", "@modelcontextprotocol/sdk"].map(name => {
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
    for (const name of ["register", "launchProfileBrowser", "claimProfileContext", "createProfilePage", "protectProfileStartup", "prepareProfileLaunch", "typeIntoLocator"]) {
      if (typeof plugin[name] !== "function") throw Error("Missing local-profile export: " + name);
    }
  `;
  node(["--input-type=module", "-e", script, pathToFileURL(contract).href, pathToFileURL(plugin).href]);
  for (const file of [
    "server.js",
    "node_modules/camoufox/dist/index.js",
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
  assertBundledPatches(upstream);

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

/** Stage the pinned fingerprint model. Reuse the current copy, or download and verify it. */
export async function prepareModel(stage: string, current: string): Promise<"reused" | "downloaded"> {
  const target = join(stage, "fpgen"), previous = join(current, "fpgen");
  if (stat(previous)?.isDirectory()) copy(previous, target);
  const reused = isPreparedModel(target);
  await fingerprintModel().ensureModel({ dir: target });
  return reused ? "reused" : "downloaded";
}

// Exchange complete sibling directories so an installed runtime and its manifest move together.
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

export type SetupReport = {
  home: string; browser: { source: BrowserSource; executable: string };
  locationData: Partial<Record<GeoipRole, { source: string; release: string; builtAt: string; status: GeoipStatus }>>;
  fingerprintModel: "reused" | "downloaded";
};
/** Setup needs downloads that nobody authorized. */
export class SetupConfirmationError extends Error {
  readonly code = "confirmation_required";
  constructor(readonly downloads: string[]) {
    super(`Setup needs to download ${downloads.join(", ")}. Run stelz setup --yes to allow it.`);
  }
}
/** What setup would download now. A setup that needs none never asks. */
async function plannedDownloads(configured?: string) {
  const current = join(HOME_DIR, "runtime");
  return [
    ...(browserPlan(HOME_DIR, configured).source === "downloaded" ? [`Camoufox ${pairedBrowser()} (over 1 GB)`] : []),
    ...(await geoipPlan(current)).map(role => `${GEOIP_SOURCES[role].name} location data`),
    ...(isPreparedModel(join(current, "fpgen")) ? [] : ["the fingerprint model"]),
  ];
}

/** Prepare everything that Start needs, and create missing service files. Downloads require `yes` or a positive `confirm`. */
export async function setup(options: {
  yes?: boolean; confirm?: (downloads: string[]) => Promise<boolean>;
  prepareGeoip?: typeof prepareGeoip; prepareModel?: typeof prepareModel; prepareBrowser?: typeof prepareBrowser;
} = {}): Promise<SetupReport> {
  directory(HOME_DIR);
  directory(STATE);
  directory(join(HOME_DIR, "runtime"));
  mkdirSync(STATE, { recursive: true, mode: 0o700 });
  const admission = join(STATE, "admission.lock");
  const existingLock = stat(admission);
  if (existingLock && (!existingLock.isFile() || existingLock.nlink !== 1)) {
    throw Error(`Invalid admission lock: ${admission}`);
  }
  // Fail fast before any download. Both checks repeat when setup activates the runtime.
  await lock(admission, async () => { initialize(); assertStopped(); });
  const configured = secret("CAMOUFOX_EXECUTABLE") || undefined;
  // `yes` authorizes every planned download, so only an unconfirmed setup needs the plan.
  if (!options.yes) {
    const downloads = await plannedDownloads(configured);
    if (downloads.length && !(await options.confirm?.(downloads))) throw new SetupConfirmationError(downloads);
  }

  // The browser has its own directory and lock, so a slow download never blocks lifecycle commands.
  const browser = await lock(join(STATE, "browser.lock"), () => (options.prepareBrowser ?? prepareBrowser)(HOME_DIR, configured), 3_600_000,
    "Another stelz setup is preparing Camoufox. Wait for it to finish, then run stelz setup again.");
  let locationData: SetupReport["locationData"] = {}, model: SetupReport["fingerprintModel"] = "reused";
  await lock(admission, async () => {
    initialize();
    assertStopped();

    const source = packagePath(CAMOFOX, ROOT);
    if (JSON.parse(readFileSync(join(source, "package.json"), "utf8")).version !== UPSTREAM_VERSION) {
      throw Error("The installed Camofox version does not match the pinned version.");
    }
    const plugin = join(ROOT, "dist/plugin.js");
    if (!stat(plugin)?.isFile()) throw Error("Build the package before setup.");

    const stage = mkdtempSync(join(HOME_DIR, ".runtime-setup-"));
    let activated = false;
    try {
      stageRuntime(stage, source, browser.executable, plugin);
      const current = join(HOME_DIR, "runtime");
      const geoip = await (options.prepareGeoip ?? prepareGeoip)(stage, current);
      locationData = Object.fromEntries((Object.keys(geoip.status) as GeoipRole[]).map(role => [role, {
        source: geoip.datasets[role].source, release: geoip.datasets[role].release, builtAt: geoip.datasets[role].buildEpoch, status: geoip.status[role] }]));
      model = await (options.prepareModel ?? prepareModel)(stage, current);
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
  return { home: HOME_DIR, browser, locationData, fingerprintModel: model };
}

const browserText: Record<BrowserSource, string> = { configured: "uses the configured executable", managed: "reused",
  "upstream-cache": "copied from the upstream cache", downloaded: "downloaded and verified" };
/** The report for a person. `--json` prints the report object instead. */
export function setupSummary(report: SetupReport) {
  const location = (Object.values(report.locationData)).map(entry => `${entry.source} ${entry.release} ${entry.status}`).join(", ");
  return [`Camoufox: ${browserText[report.browser.source]} (${report.browser.executable})`,
    ...(location ? [`Location data: ${location}`] : []), `Fingerprint model: ${report.fingerprintModel}`,
    `Ready: ${report.home}`, "Next: run stelz ui --open, or register stelz mcp with your agent."].join("\n");
}
