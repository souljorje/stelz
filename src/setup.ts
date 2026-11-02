import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { ROOT, UPSTREAM, COMMIT, executable } from "./config.ts";

async function run(args: string[], cwd = ROOT, env = process.env) {
  const proc = Bun.spawn(args, { cwd, env: { ...env, npm_config_cache: join(ROOT, ".runtime/npm-cache"), npm_config_devdir: join(ROOT, ".runtime/node-gyp") }, stdout: "inherit", stderr: "inherit" });
  if (await proc.exited) throw Error(`${args[0]} failed`);
}
if (!existsSync(executable())) throw Error(`Installed Camoufox not found at ${executable()}; set CAMOUFOX_EXECUTABLE`);
if (!existsSync(join(UPSTREAM, ".git"))) {
  mkdirSync(join(ROOT, ".runtime"), { recursive: true });
  await run(["git", "clone", "--filter=blob:none", "--no-checkout", "https://github.com/jo-inc/camofox-browser.git", UPSTREAM]);
}
await run(["git", "checkout", "--detach", COMMIT], UPSTREAM);
await run(["npm", "ci", "--omit=dev", "--ignore-scripts"], UPSTREAM, { ...process.env, CAMOUFOX_EXECUTABLE: executable(), CAMOFOX_SKIP_DOWNLOAD: "1" });
// Only build the native dependency required by upstream, never fetch a browser.
await run(["npm", "rebuild", "better-sqlite3"], UPSTREAM);
// The pinned upstream tries to add a symlink inside an external macOS .app.
// Read its existing Resources/properties.json instead; leave the installed app untouched.
function patchExact(file: string, before: string, after: string) {
  const text = readFileSync(file, "utf8");
  if (text.includes(after)) return;
  if (!text.includes(before)) throw Error(`Pinned-source compatibility patch no longer applies: ${file}`);
  writeFileSync(file, text.replace(before, after));
}
patchExact(join(UPSTREAM, "lib/camoufox-executable.js"),
  "if (!existsSync(executableProperties)) ensureSymlink(realpathSync(resourceProperties), executableProperties);",
  "// stelz: macOS resource-aware loader avoids modifying the installed app bundle.");
patchExact(join(UPSTREAM, "node_modules/camoufox-js/dist/utils.js"),
  'propFile = path.join(path.dirname(filePath), "properties.json");',
  'propFile = process.platform === "darwin" && filePath.includes(".app/Contents/MacOS/") ? path.join(path.dirname(filePath), "../Resources/properties.json") : path.join(path.dirname(filePath), "properties.json");');
const serverFile = join(UPSTREAM, "server.js");
let serverSource = readFileSync(serverFile, "utf8");
if (!serverSource.includes("stelz-headed-constraints")) {
  serverSource = serverSource.replace("        window: [1200, 800], // supported generation constraint; no hand-crafted device values\n", "");
  const before = "os: hostOS,\n        humanize: true,";
  if (!serverSource.includes(before)) throw Error("Pinned headed-window patch no longer applies");
  writeFileSync(serverFile, serverSource.replace(before, "os: hostOS,\n        // stelz-headed-constraints: supported generator constraints, not hand-crafted device values\n        window: [1200, 800],\n        screen: { minWidth: 1280, minHeight: 900, maxWidth: 1920, maxHeight: 1200 },\n        humanize: true,"));
}
patchExact(serverFile,
  "proxy: launchProxy,\n        geoip: !!launchProxy,",
  "proxy: launchProxy,\n        block_webrtc: !!launchProxy, // supported option: prevent unproxied WebRTC traffic\n        geoip: !!launchProxy,");
const output = join(UPSTREAM, "plugins/local-profile/index.js");
mkdirSync(join(UPSTREAM, "plugins/local-profile"), { recursive: true });
const result = await Bun.build({ entrypoints: [join(ROOT, "src/plugin.ts")], target: "node", format: "esm", outdir: join(ROOT, "dist"), naming: "plugin.js" });
if (!result.success) throw Error(result.logs.join("\n"));
copyFileSync(join(ROOT, "dist/plugin.js"), output);
writeFileSync(join(UPSTREAM, "camofox.config.json"), JSON.stringify({ interactive: { mode: "desktop" }, plugins: { persistence: { enabled: true, indexedDB: true }, "local-profile": { enabled: true } } }, null, 2));
const fingerprint = createHash("sha256").update(readFileSync(executable())).digest("hex");
const versionPath = join(executable().includes(".app/Contents/MacOS/") ? dirname(dirname(dirname(dirname(executable())))) : dirname(executable()), "version.json");
const upstreamLock = JSON.parse(readFileSync(join(UPSTREAM, "package-lock.json"), "utf8"));
const dependencies = Object.fromEntries(["camoufox-js", "playwright-core", "@modelcontextprotocol/sdk", "fingerprint-generator"].map(name => [name, upstreamLock.packages[`node_modules/${name}`].version]));
writeFileSync(join(ROOT, ".runtime/versions.json"), JSON.stringify({ camofoxCommit: COMMIT, camoufoxExecutable: executable(), camoufoxVersion: existsSync(versionPath) ? JSON.parse(readFileSync(versionPath, "utf8")) : null, executableSha256: fingerprint, upstreamDependencies: dependencies, bun: Bun.version, node: Bun.spawnSync(["node", "--version"]).stdout.toString().trim() }, null, 2));
console.log("Setup complete. Existing Camoufox reused; browser download disabled.");
