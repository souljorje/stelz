import { checkBundledArchive, inspectBundledDependencies } from "./bundled-dependencies.ts";
import { packRelease } from "./release-archive.ts";
import { releaseArguments, inspectReleaseCandidate, assertCandidateUnchanged } from "./release-candidate.ts";
import { checkMarkdownLinks } from "./markdown-links.ts";
import { mkdtempSync, mkdirSync, symlinkSync, readFileSync, writeFileSync, readdirSync, lstatSync, realpathSync, rmSync, existsSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { STELZ_VERSION } from "../packages/stelz/src/versions.ts";
const root = resolve(import.meta.dir, ".."), temp = mkdtempSync(join(tmpdir(), "stelz-package-"));
const input = releaseArguments(process.argv.slice(2));
const prefix = join(temp, "global"), cwd = join(temp, "empty"), home = join(temp, "data"), bin = join(temp, "bin");
for (const path of [cwd, bin]) mkdirSync(path, { recursive: true });
const npm = Bun.which("npm")!, node = Bun.which("node")!, bun = Bun.which("bun")!;
symlinkSync(node, join(bin, "node")); symlinkSync(bun, join(bin, "bun"));
const env: Record<string, string> = { PATH: process.env.PATH!, HOME: process.env.HOME!, CAMOFOX_SKIP_DOWNLOAD: "1", npm_config_cache: join(temp, "npm-cache") };
if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
async function run(args: string[], options: { cwd?: string; env?: Record<string, string>; inherit?: boolean } = {}) {
  const p = Bun.spawn(args, { cwd: options.cwd || root, env: options.env || env, stdout: options.inherit ? "inherit" : "pipe", stderr: options.inherit ? "inherit" : "pipe" });
  if (options.inherit) { if (await p.exited) throw Error(`${args[0]} failed.`); return ""; }
  const [out, err, code] = await Promise.all([new Response(p.stdout as ReadableStream).text(), new Response(p.stderr as ReadableStream).text(), p.exited]);
  if (code) throw Error(err || out); return out;
}
console.log("Verify npm pack lifecycle and isolated browser-free installation.");
try {
const product = join(root, "packages/stelz");
const preparedDependencies = inspectBundledDependencies(product);
let archive = input.archive;
if (!archive) {
  // Prove the prepack hook builds missing artifacts before creating one candidate.
  rmSync(join(product, "dist"), { recursive: true, force: true });
  const packed = await packRelease(product, temp, { env });
  if (!existsSync(join(product, "dist/cli.js"))) throw Error("Prepack did not build the CLI.");
  archive = join(temp, packed.filename);
}
const candidate = inspectReleaseCandidate(archive);
const packed = [candidate];
for (const file of packed[0]!.files) if (/^(src|test|\.git|\.codex|\.state|sessions)\//.test(file.path)) throw Error(`Unexpected archive file: ${file.path}`);
checkBundledArchive(packed[0]!.files);
const uiFiles = packed[0]!.files.filter(file => file.path.startsWith("dist/ui/"));
if (!uiFiles.some(file => file.path === "dist/ui/index.html") || !uiFiles.some(file => file.path.endsWith(".js")) || !uiFiles.some(file => file.path.endsWith(".woff2"))) throw Error("The archive is missing built UI assets.");
const paths = packed[0]!.files.map(file => file.path).sort();
for (const path of ["dist/cli.js", "dist/supervisor.js", "dist/plugin.js", "dist/ui/index.html", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "docs/agents.md", "examples/profiles.json", "skills/stelz-browser/SKILL.md", "skills/stelz-browser/references/recovery.md", ...["react", "react-dom", "scheduler", "ibm-plex-mono", "ibm-plex-sans"].map(name => "dist/ui/licenses/" + name + ".txt")]) {
  if (!paths.includes(path)) throw Error("Archive is missing " + path);
}
for (const path of paths) if (!/^(?:node_modules\/|dist\/|docs\/|examples\/|skills\/|package.json$|README.md$|LICENSE$|THIRD_PARTY_NOTICES.md$)/.test(path)) throw Error("Unexpected archive path: " + path);
await run([npm, "install", "--global", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", prefix, archive]);
const installed = join(prefix, "lib/node_modules/stelz");
const installedDependencies = inspectBundledDependencies(installed);
if (JSON.stringify(installedDependencies) !== JSON.stringify(preparedDependencies))
  throw Error("The installed archive changed the patched dependency files.");
const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
if (manifest.name !== "stelz" || manifest.version !== STELZ_VERSION || manifest.private || manifest.license !== "MIT") throw Error("Invalid release manifest.");
checkMarkdownLinks([join(root, "README.md"), join(root, "docs"), join(root, "examples"), join(root, "packages/stelz/skills")]);
checkMarkdownLinks([join(installed, "README.md"), join(installed, "docs"), join(installed, "examples"), join(installed, "skills")]);
for (const file of ["cli.js", "supervisor.js", "plugin.js"]) if (readFileSync(join(installed, "dist", file), "utf8").includes(root)) throw Error("Bundle contains a checkout path: " + file);
const cleanEnv: Record<string, string> = { PATH: `${join(prefix, "bin")}:${bin}:/usr/bin:/bin`, HOME: env.HOME!, STELZ_HOME: home };
if (env.TMPDIR) cleanEnv.TMPDIR = env.TMPDIR;
for (const harness of ["codex", "claude", "hermes"]) if (Bun.which(harness, { PATH: cleanEnv.PATH })) throw Error(`Unexpected harness command in isolated PATH: ${harness}`);
const executable = join(prefix, "bin/stelz");
const poisonHome = join(temp, "wrong-project-home");
writeFileSync(join(cwd, ".env"), `STELZ_HOME=${poisonHome}\n`);
const defaultEnv = { ...cleanEnv }; delete defaultEnv.STELZ_HOME;
if ((await run([executable, "--help"], { cwd, env: defaultEnv })).includes(poisonHome)) throw Error("The global command loaded project environment state.");
const version = (await run([executable, "--version"], { cwd, env: cleanEnv })).trim();
if (version !== STELZ_VERSION) throw Error("Global command version does not match.");
await run([executable, "init"], { cwd, env: cleanEnv });
// The installed UI must serve without source files, dev dependencies, or a build server.
const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const uiPort = reservation.port;
reservation.stop(true);
const ui = Bun.spawn([executable, "ui", "--port", String(uiPort)], { cwd, env: cleanEnv, stdout: "pipe", stderr: "pipe" });
const uiTimeout = setTimeout(() => ui.kill("SIGTERM"), 15000);
try {
  const reader = ui.stdout.getReader(), decoder = new TextDecoder();
  let output = "";
  while (!output.includes("\n")) {
    const part = await reader.read();
    if (part.done) throw Error("The installed UI exited before it printed a launch URL.");
    output += decoder.decode(part.value, { stream: true });
  }
  reader.releaseLock();
  const launchUrl = output.match(/http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]+/)?.[0];
  if (!launchUrl) throw Error("The installed UI did not print its launch URL.");
  const origin = new URL(launchUrl).origin;
  const html = await (await fetch(origin)).text();
  const token = new URLSearchParams(new URL(launchUrl).hash.slice(1)).get("token");
  const session = await fetch(`${origin}/api/session`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
  if (!session.ok) throw Error("The installed UI session failed.");
  const Cookie = session.headers.get("set-cookie")!.split(";")[0]!;
  const response = await fetch(`${origin}/api/state`, { headers: { Cookie } });
  const state = await response.json() as { home: string; profiles: unknown[] };
  if (!response.ok || state.home !== home || state.profiles.length !== 0) throw Error("The installed UI must use the selected service directory and an empty initial catalog.");
  const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(match => match[1]!);
  if (!assets.some(path => path.endsWith(".js")) || !assets.some(path => path.endsWith(".css"))) throw Error("The installed UI HTML is missing its bundled assets.");
  for (const path of assets) {
    const url = new URL(path, origin), asset = await fetch(url);
    if (!asset.ok) throw Error("An installed UI asset is unavailable.");
    if (path.endsWith(".css")) {
      for (const match of (await asset.text()).matchAll(/url\(["']?([^\s)"']+)["']?\)/g)) {
        const font = new URL(match[1]!, url);
        if (font.origin !== origin || !(await fetch(font)).ok) throw Error("An installed UI font is unavailable or remote.");
      }
    }
  }
  const shutdown = await fetch(`${origin}/api/shutdown`, { method: "POST", headers: { Cookie, Origin: origin, "Content-Type": "application/json" }, body: "{}" });
  if (!shutdown.ok || !(await shutdown.json() as { stopped?: boolean }).stopped || !shutdown.headers.get("set-cookie")?.includes("Max-Age=0"))
    throw Error("The installed UI did not end its session.");
  if (await ui.exited !== 0) throw Error("The installed UI did not exit cleanly after shutdown.");
} finally {
  clearTimeout(uiTimeout);
  ui.kill("SIGTERM");
  await ui.exited;
}
// Setup validates the complete installed runtime without launching a browser.
const fakeBrowser = join(temp, "fake-browser"), launched = join(temp, "browser-was-launched");
writeFileSync(fakeBrowser, `#!/usr/bin/env bun\nawait Bun.write(${JSON.stringify(launched)}, "unexpected launch");\nprocess.exit(99);\n`);
chmodSync(fakeBrowser, 0o755);
await run([executable, "setup"], { cwd, env: { ...cleanEnv, CAMOUFOX_EXECUTABLE: fakeBrowser } });
if (existsSync(launched)) throw Error("Setup executed the fake browser.");
const runtime = join(home, "runtime");
const versions = JSON.parse(readFileSync(join(runtime, "versions.json"), "utf8"));
if (versions.stelz !== STELZ_VERSION || versions.camoufoxExecutable !== fakeBrowser || versions.upstreamVersion !== manifest.dependencies["@askjo/camofox-browser"])
  throw Error("Installed setup wrote an invalid runtime manifest.");
const upstream = join(runtime, "camofox-" + versions.upstreamVersion);
for (const path of ["server.js", "plugins/local-profile/index.js", "mcp/lib/tool-contracts.mjs", "node_modules/camoufox-js/dist/utils.js"])
  if (!existsSync(join(upstream, path))) throw Error("Installed setup omitted " + path);
let links = 0;
function checkRuntimeLinks(folder: string) {
  for (const name of readdirSync(folder)) {
    const path = join(folder, name), info = lstatSync(path);
    if (info.isSymbolicLink()) {
      const target = realpathSync(path);
      if (target === root || target.startsWith(root + "/") || !target.startsWith(realpathSync(prefix) + "/"))
        throw Error("Installed runtime dependency escaped the isolated prefix: " + target);
      links++;
    } else if (info.isDirectory()) checkRuntimeLinks(path);
  }
}
checkRuntimeLinks(runtime);
if (!links) throw Error("Setup did not stage dependency links.");
assertCandidateUnchanged(candidate);
console.log(JSON.stringify({ result: "passed", archive, sha256: candidate.sha256, checks: "Archive contents, Markdown links, isolated CLI, HTTP UI, and installed setup/dependency validation" }));
} finally { rmSync(temp, { recursive: true, force: true }); }
