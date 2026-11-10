import { assertBundledPatches } from "./camofox-adapter.ts";
import { geoipPlan, prepareGeoip, type GeoipStatus } from "./geoip-setup.ts";
import { browserPin, fingerprintModel, isPreparedModel, pairedBrowser } from "./camoufox.ts";
import { browserPlan, prepareBrowser, type BrowserSource } from "./browser-setup.ts";
import { GEOIP_SOURCES, type GeoipRole } from "./location.ts";
import {
  copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync,
  readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  ROOT, HOME_DIR, STATE, RUNTIME, RUNTIME_GENERATIONS, COMMIT, UPSTREAM_VERSION, currentRuntimeId, initialize, isRuntimeId, runtimeDir, secret,
} from "../profiles/config.ts";
import { STELZ_VERSION } from "../versions.ts";
import { lock, running, type Running } from "../runtime/runtime.ts";

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

/** Accept a missing runtime, an earlier plain directory, or a link to a generation. Reject any other link. */
function runtimeLayout(): "missing" | "plain" | "generation" {
  directory(RUNTIME_GENERATIONS);
  const info = stat(RUNTIME);
  if (!info) return "missing";
  if (info.isDirectory()) return "plain";
  if (info.isSymbolicLink() && currentRuntimeId()) return "generation";
  // A dangling link has no running user, so activation replaces it. A link to anything else is refused.
  if (info.isSymbolicLink() && !existsSync(RUNTIME)) return "missing";
  throw Error(`Expected a runtime directory or a link to a runtime generation: ${RUNTIME}`);
}

/** Records of running services, including reservations. Malformed records stop setup. */
function runningServices(): Running[] {
  const services: Running[] = [];
  for (const item of readdirSync(STATE, { withFileTypes: true })) {
    if (item.isSymbolicLink()) throw Error(`Invalid profile directory: ${item.name}`);
    if (!item.isDirectory()) continue;
    const record = stat(join(STATE, item.name, "running.json"));
    if (record && !record.isFile()) throw Error(`Invalid profile state: ${item.name}`);
    const service = running(item.name);
    if (service) services.push(service);
  }
  return services;
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
  const upstream = join(stage, `camofox-${UPSTREAM_VERSION}`);
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
export async function prepareModel(stage: string, current: string, progress: Progress = console.error): Promise<"reused" | "downloaded"> {
  const target = join(stage, "fpgen"), previous = join(current, "fpgen");
  if (stat(previous)?.isDirectory()) copy(previous, target);
  const reused = isPreparedModel(target);
  if (!reused) progress("Downloading the fingerprint model…");
  await fingerprintModel().ensureModel({ dir: target });
  return reused ? "reused" : "downloaded";
}

// Sort object keys so that equal inputs give equal text.
const canonical = (value: unknown) => JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : 1)) : item);
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** Content identity of the staged Camofox tree: the plugin, patches, and dependency links. */
function treeDigest(root: string) {
  const entries: string[] = [];
  const walk = (path: string, prefix: string) => {
    for (const item of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const full = join(path, item.name), name = prefix + item.name;
      if (item.isSymbolicLink()) entries.push(`l ${name} ${readlinkSync(full)}`);
      else if (item.isDirectory()) { entries.push(`d ${name}`); walk(full, `${name}/`); }
      else entries.push(`f ${name} ${sha256(readFileSync(full))}`);
    }
  };
  walk(root, "");
  return sha256(entries.join("\0"));
}

/** Equal setup inputs give the same generation ID. */
function generationId(stage: string) {
  // Bun and Node describe the host that ran setup, not the runtime contents.
  const { bun: _bun, node: _node, ...manifest } = JSON.parse(readFileSync(join(stage, "versions.json"), "utf8"));
  const geoipManifest = join(stage, "geoip/manifest.json"), pin = join(stage, "fpgen/.pinned-model");
  const datasets = stat(geoipManifest)
    ? Object.fromEntries(Object.entries((JSON.parse(readFileSync(geoipManifest, "utf8")).datasets ?? {}) as Record<string, { sha256: string }>)
      .map(([role, entry]) => [role, entry.sha256]))
    : {};
  const model = stat(pin)?.isFile() ? readFileSync(pin, "utf8").trim() : fingerprintModel().MODEL_PIN?.sha256 ?? null;
  return sha256(canonical({ manifest, datasets, model, camofox: treeDigest(join(stage, `camofox-${UPSTREAM_VERSION}`)) })).slice(0, 16);
}

// Move a directory aside atomically. Setup removes it after it releases the admission lock.
function retire(path: string) {
  const target = join(RUNTIME_GENERATIONS, `.stage-retired-${crypto.randomUUID()}`);
  renameSync(path, target);
  return target;
}

/** Point the runtime link at a generation, then retire generations that no running service uses. */
function activate(id: string) {
  const layout = runtimeLayout(), services = runningServices(), retired: string[] = [];
  if (layout === "plain") {
    if (services.length) throw Error("Stop running profiles from an earlier Stelz version before you run stelz setup.");
    retired.push(retire(RUNTIME));
  }
  const temporary = `${RUNTIME}.${process.pid}.${crypto.randomUUID()}.tmp`;
  symlinkSync(join(basename(RUNTIME_GENERATIONS), id), temporary, "dir");
  renameSync(temporary, RUNTIME);
  const keep = new Set([id, ...services.map(service => service.runtime)]);
  for (const item of readdirSync(RUNTIME_GENERATIONS, { withFileTypes: true })) {
    if (item.isDirectory() && isRuntimeId(item.name) && !keep.has(item.name)) retired.push(retire(join(RUNTIME_GENERATIONS, item.name)));
  }
  return retired;
}

export type SetupReport = {
  home: string; browser: { source: BrowserSource; executable: string };
  locationData: Partial<Record<GeoipRole, { source: string; release: string; builtAt: string; status: GeoipStatus }>>;
  fingerprintModel: "reused" | "downloaded";
  runtime: { id: string; status: "reused" | "prepared" };
};
/** Setup needs downloads that nobody authorized. */
/** Setup progress for a person or, with `--json`, for stderr. */
export type Progress = (message: string) => void;
/** One download that needs consent. */
export type PlannedDownload = { name: string; size: string; purpose: string; source: string };
/** Each download with its size, purpose, and source. */
export const downloadList = (downloads: PlannedDownload[]) =>
  downloads.map(item => `- ${item.name} (${item.size}): ${item.purpose}\n  ${item.source}`).join("\n");
export class SetupConfirmationError extends Error {
  readonly code = "confirmation_required";
  constructor(readonly downloads: PlannedDownload[]) {
    super(`Setup needs these downloads:\n${downloadList(downloads)}\nRun stelz setup --yes to allow them.`);
  }
}
const locationPurpose: Record<GeoipRole, Pick<PlannedDownload, "size" | "purpose">> = {
  selection: { size: "about 120 MB", purpose: "Matches the timezone and language of a proxied browser to its exit IP." },
  comparison: { size: "about 50 MB", purpose: "A second database that cross-checks that location." },
};
/** What setup would download now. A setup that needs none never asks. */
async function plannedDownloads(configured?: string): Promise<PlannedDownload[]> {
  const current = runtimeDir(), downloads: PlannedDownload[] = [];
  if (browserPlan(HOME_DIR, configured).source === "downloaded") {
    const { repo, tag } = browserPin();
    downloads.push({ name: `Camoufox ${pairedBrowser()}`, size: "over 1 GB", purpose: "The browser build that every profile runs.",
      source: `https://github.com/${repo}/releases/tag/${tag}` });
  }
  for (const role of await geoipPlan(current)) downloads.push({ name: `${GEOIP_SOURCES[role].name} location data`, ...locationPurpose[role],
    source: `https://github.com/${GEOIP_SOURCES[role].repository}/releases/latest` });
  if (!isPreparedModel(join(current, "fpgen"))) {
    const { repo, tag, size } = fingerprintModel().MODEL_PIN;
    downloads.push({ name: "Fingerprint model", size: `about ${Math.ceil(size / 1e6)} MB`, purpose: "Generates the fingerprint of each new profile.",
      source: `https://github.com/${repo}/releases/tag/${tag}` });
  }
  return downloads;
}

type SetupOptions = {
  yes?: boolean; confirm?: (downloads: PlannedDownload[]) => Promise<boolean>; progress?: Progress;
  prepareGeoip?: typeof prepareGeoip; prepareModel?: typeof prepareModel; prepareBrowser?: typeof prepareBrowser;
};
/** Prepare everything that Start needs, and create missing service files. Downloads require `yes` or a positive `confirm`. */
export async function setup(options: SetupOptions = {}): Promise<SetupReport> {
  directory(HOME_DIR);
  directory(STATE);
  runtimeLayout();
  mkdirSync(STATE, { recursive: true, mode: 0o700 });
  const admission = join(STATE, "admission.lock");
  const existingLock = stat(admission);
  if (existingLock && (!existingLock.isFile() || existingLock.nlink !== 1)) {
    throw Error(`Invalid admission lock: ${admission}`);
  }
  return lock(join(STATE, "setup.lock"), () => prepare(admission, options), 3_600_000,
    "Another stelz setup is running. Wait for it to finish, then run stelz setup again.");
}

// The caller holds the setup lock. Running services keep their generations, so only activation needs the admission lock.
async function prepare(admission: string, options: SetupOptions): Promise<SetupReport> {
  await lock(admission, async () => { initialize(); });
  const configured = secret("CAMOUFOX_EXECUTABLE") || undefined;
  // `yes` authorizes every planned download, so only an unconfirmed setup needs the plan.
  if (!options.yes) {
    const downloads = await plannedDownloads(configured);
    if (downloads.length && !(await options.confirm?.(downloads))) throw new SetupConfirmationError(downloads);
  }
  const progress = options.progress ?? console.error;
  const browser = await (options.prepareBrowser ?? prepareBrowser)(HOME_DIR, configured, { progress });

  const source = packagePath(CAMOFOX, ROOT);
  if (JSON.parse(readFileSync(join(source, "package.json"), "utf8")).version !== UPSTREAM_VERSION) {
    throw Error("The installed Camofox version does not match the pinned version.");
  }
  const plugin = join(ROOT, "dist/plugin.js");
  if (!stat(plugin)?.isFile()) throw Error("Build the package before setup.");

  mkdirSync(RUNTIME_GENERATIONS, { recursive: true, mode: 0o700 });
  // The setup lock guarantees that every stage is stale.
  for (const name of readdirSync(RUNTIME_GENERATIONS)) {
    if (name.startsWith(".stage-")) rmSync(join(RUNTIME_GENERATIONS, name), { recursive: true, force: true });
  }
  const stage = mkdtempSync(join(RUNTIME_GENERATIONS, ".stage-"));
  try {
    stageRuntime(stage, source, browser.executable, plugin);
    const current = runtimeDir();
    const geoip = await (options.prepareGeoip ?? prepareGeoip)(stage, current, { progress });
    const locationData: SetupReport["locationData"] = Object.fromEntries((Object.keys(geoip.status) as GeoipRole[]).map(role => [role, {
      source: geoip.datasets[role].source, release: geoip.datasets[role].release, builtAt: geoip.datasets[role].buildEpoch, status: geoip.status[role] }]));
    const model = await (options.prepareModel ?? prepareModel)(stage, current, progress);
    const id = generationId(stage), target = join(RUNTIME_GENERATIONS, id);
    const runtime: SetupReport["runtime"] = { id, status: "reused" };
    if (id !== currentRuntimeId()) {
      // A generation appears only by rename of a complete stage, so an existing one is complete.
      const existing = stat(target);
      if (existing && !existing.isDirectory()) throw Error(`Expected a directory, not a link or file: ${target}`);
      if (!existing) { renameSync(stage, target); runtime.status = "prepared"; }
    }
    rmSync(stage, { recursive: true, force: true });
    const retired = await lock(admission, async () => activate(id));
    // The runtime is active now. The next setup removes any stage that remains.
    for (const path of retired) try { rmSync(path, { recursive: true, force: true }); } catch {}
    return { home: HOME_DIR, browser, locationData, fingerprintModel: model, runtime };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

const browserText: Record<BrowserSource, string> = { configured: "uses the configured executable", managed: "reused",
  "upstream-cache": "copied from the upstream cache", downloaded: "downloaded and verified" };
/** The report for a person. `--json` prints the report object instead. */
export function setupSummary(report: SetupReport) {
  const location = (Object.values(report.locationData)).map(entry => `${entry.source} ${entry.release} ${entry.status}`).join(", ");
  return [`Camoufox: ${browserText[report.browser.source]} (${report.browser.executable})`,
    ...(location ? [`Location data: ${location}`] : []), `Fingerprint model: ${report.fingerprintModel}`,
    `Runtime: ${report.runtime.status} ${report.runtime.id}`,
    `Ready: ${report.home}`, "Next: run stelz ui --open, or register stelz mcp with your agent."].join("\n");
}
