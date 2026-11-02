import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, cpSync, symlinkSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { ROOT, HOME_DIR, UPSTREAM, COMMIT, UPSTREAM_VERSION, executable, initialize, settings } from "./config.ts";
import { running } from "./runtime.ts";

function packagePath(name: string, from: string): string {
  const require = createRequire(join(from, "package.json"));
  let path: string;
  try { path = dirname(require.resolve(`${name}/package.json`)); }
  catch { path = dirname(require.resolve(name === "@modelcontextprotocol/sdk" ? `${name}/server/index.js` : name)); }
  for (;;) {
    const manifest = join(path, "package.json");
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === name) return path;
    const parent = dirname(path); if (parent === path) throw Error(`Cannot locate dependency: ${name}`); path = parent;
  }
}
function patch(file: string, before: string, after: string) {
  const text = readFileSync(file, "utf8");
  if (text.includes(after)) return;
  if (!text.includes(before)) throw Error(`The pinned compatibility patch does not match ${file}.`);
  writeFileSync(file, text.replace(before, after));
}
export async function setup() {
  initialize();
  if (settings().identities.some(p => running(p.id))) throw Error("Stop all identities before setup.");
  if (!existsSync(executable())) throw Error(`Camoufox is missing at ${executable()}. Set CAMOUFOX_EXECUTABLE in secrets.env.`);
  const source = packagePath("@askjo/camofox-browser", ROOT);
  if (JSON.parse(readFileSync(join(source, "package.json"), "utf8")).version !== UPSTREAM_VERSION) throw Error("The installed Camofox version does not match the pinned version.");
  mkdirSync(UPSTREAM, { recursive: true, mode: 0o700 });
  for (const name of ["server.js", "package.json", "LICENSE", "lib", "mcp", "plugins/persistence"]) {
    const from = join(source, name); if (existsSync(from)) cpSync(from, join(UPSTREAM, name), { recursive: true });
  }
  const modules = join(UPSTREAM, "node_modules"); mkdirSync(modules, { recursive: true });
  const camoufox = packagePath("camoufox-js", ROOT);
  const dependencies = { ...JSON.parse(readFileSync(join(source, "package.json"), "utf8")).dependencies, ...JSON.parse(readFileSync(join(camoufox, "package.json"), "utf8")).dependencies, "@modelcontextprotocol/sdk": "1.30.0" };
  for (const name of Object.keys(dependencies)) {
    const target = join(modules, name); mkdirSync(dirname(target), { recursive: true });
    rmSync(target, { recursive: true, force: true });
    if (name === "camoufox-js") cpSync(camoufox, target, { recursive: true, filter: source => !source.slice(camoufox.length).includes("node_modules") });
    else symlinkSync(packagePath(name, source), target, "dir");
  }
  patch(join(UPSTREAM, "lib/camoufox-executable.js"),
    "if (!existsSync(executableProperties)) ensureSymlink(realpathSync(resourceProperties), executableProperties);",
    "// stelz: read macOS resources without changing the installed app bundle.");
  patch(join(modules, "camoufox-js/dist/utils.js"),
    'propFile = path.join(path.dirname(filePath), "properties.json");',
    'propFile = process.platform === "darwin" && filePath.includes(".app/Contents/MacOS/") ? path.join(path.dirname(filePath), "../Resources/properties.json") : path.join(path.dirname(filePath), "properties.json");');
  patch(join(UPSTREAM, "server.js"), "os: hostOS,\n        humanize: true,",
    "os: hostOS,\n        window: [1200, 800],\n        screen: { minWidth: 1280, minHeight: 900, maxWidth: 1920, maxHeight: 1200 },\n        humanize: true,");
  patch(join(UPSTREAM, "server.js"), "proxy: launchProxy,\n        geoip: !!launchProxy,",
    "proxy: launchProxy,\n        block_webrtc: !!launchProxy,\n        geoip: !!launchProxy,");
  // Keep browser ownership in upstream, but bind its one session to the native context.
  // These exact replacements fail closed if the pinned upstream boundary changes.
  patch(join(UPSTREAM, "server.js"), "candidateBrowser = await firefox.launch(options);",
    "candidateBrowser = await (await import('./plugins/local-profile/index.js')).launchIdentityBrowser(firefox, options, { viewport: null, ...contextIdentityOptions({ hasProxy: !!proxyPool, directIdentity: CONFIG.directIdentity }) });");
  patch(join(UPSTREAM, "server.js"), "const context = await b.newContext(contextOptions);",
    "const context = await (await import('./plugins/local-profile/index.js')).claimIdentityContext(b, contextOptions);");
  patch(join(UPSTREAM, "plugins/persistence/index.js"), "export async function register(app, ctx, pluginConfig = {}) {",
    "export async function register(app, ctx, pluginConfig = {}) {\n  if (process.env.STELZ_STORAGE_MODE === 'native') return; // Native Firefox profile owns storage.");
  const output = join(UPSTREAM, "plugins/local-profile/index.js");
  mkdirSync(dirname(output), { recursive: true });
  if (!existsSync(join(ROOT, "dist/plugin.js"))) throw Error("Build the package before setup.");
  copyFileSync(join(ROOT, "dist/plugin.js"), output);
  writeFileSync(join(UPSTREAM, "camofox.config.json"), JSON.stringify({ interactive: { mode: "desktop" }, plugins: { persistence: { enabled: true, indexedDB: true }, "local-profile": { enabled: true } } }, null, 2));
  const versionPath = join(executable().includes(".app/Contents/MacOS/") ? dirname(dirname(dirname(dirname(executable())))) : dirname(executable()), "version.json");
  const versions = Object.fromEntries(["camoufox-js", "playwright-core", "@modelcontextprotocol/sdk"].map(name => [name, JSON.parse(readFileSync(join(packagePath(name, ROOT), "package.json"), "utf8")).version]));
  writeFileSync(join(HOME_DIR, "runtime/versions.json"), JSON.stringify({ stelz: "0.2.0", camofoxVersion: UPSTREAM_VERSION, sourceCommit: COMMIT, camoufoxExecutable: executable(), camoufoxVersion: existsSync(versionPath) ? JSON.parse(readFileSync(versionPath, "utf8")) : null, executableSha256: createHash("sha256").update(readFileSync(executable())).digest("hex"), dependencies: versions, bun: Bun.version, node: Bun.spawnSync(["node", "--version"]).stdout.toString().trim() }, null, 2));
  console.log(`Service files are ready in ${HOME_DIR}. The installed browser is unchanged.`);
}
