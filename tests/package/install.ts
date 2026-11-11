import { inspectBundledDependencies } from "../../scripts/bundled-dependencies.ts";
import { packageArguments, inspectPackageArchive, assertArchiveUnchanged } from "../../scripts/package-archive.ts";
import { checkMarkdownLinks } from "../../scripts/markdown-links.ts";
import { nativeSmoke } from "../helpers/native-dependencies.ts";
import { mkdtempSync, mkdirSync, symlinkSync, readFileSync, writeFileSync, readdirSync, lstatSync, realpathSync, rmSync, existsSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { STELZ_VERSION } from "../../src/versions.ts";
import { createTestHome } from "../helpers/test-home.ts";
import { pairedBrowser } from "../../src/browser/camoufox.ts";

// Each run installs into a new prefix. The download cache persists, as in CI: npm verifies every package's integrity hash.
export const NPM_CACHE = resolve(import.meta.dir, "../../.state/npm-cache");

export async function installPackage(archive: string, options: { native?: boolean; keep?: boolean } = {}) {
const root = resolve(import.meta.dir, "../.."), temp = mkdtempSync(join(tmpdir(), "stelz-package-"));
const input = { flags: new Set(options.native ? ["--native"] : []) };
const prefix = join(temp, "global"), cwd = join(temp, "empty"), home = createTestHome("data", temp), bin = join(temp, "bin");
for (const path of [cwd, bin]) mkdirSync(path, { recursive: true });
const npm = Bun.which("npm")!, node = Bun.which("node")!, bun = Bun.which("bun")!;
symlinkSync(node, join(bin, "node")); symlinkSync(bun, join(bin, "bun"));
const env: Record<string, string> = { PATH: process.env.PATH!, HOME: process.env.HOME!, npm_config_cache: NPM_CACHE };
if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
async function run(args: string[], options: { cwd?: string; env?: Record<string, string>; inherit?: boolean } = {}) {
  const p = Bun.spawn(args, { cwd: options.cwd || root, env: options.env || env, stdout: options.inherit ? "inherit" : "pipe", stderr: options.inherit ? "inherit" : "pipe" });
  if (options.inherit) { if (await p.exited) throw Error(`${args[0]} failed.`); return ""; }
  const [out, err, code] = await Promise.all([new Response(p.stdout as ReadableStream).text(), new Response(p.stderr as ReadableStream).text(), p.exited]);
  if (code) throw Error(err || out); return out;
}
console.log(`Verify isolated browser-free installation (${input.flags.has("--native") ? "ordinary native installation" : "lifecycle scripts disabled"}).`);
try {
const product = root;
const preparedDependencies = inspectBundledDependencies(product);
if (!existsSync(archive)) throw Error("Release archive not found. Run bun run pack first, or supply --archive FILE.");
const candidate = inspectPackageArchive(archive);
for (const file of candidate.files) if (/^(src|test|\.git|\.codex|\.state|sessions)\//.test(file.path)) throw Error(`Unexpected archive file: ${file.path}`);
const uiFiles = candidate.files.filter(file => file.path.startsWith("dist/ui/"));
if (!uiFiles.some(file => file.path === "dist/ui/index.html") || !uiFiles.some(file => file.path.endsWith(".js")) || !uiFiles.some(file => file.path.endsWith(".woff2"))) throw Error("The archive is missing built UI assets.");
const paths = candidate.files.map(file => file.path).sort();
for (const path of ["CONTRIBUTING.md", "assets/screenshots/stelz-overview.png", "examples/onboarding-fixture.html",
  ...["index", "product", "bootstrap", "getting-started", "clients", "ui", "proxies", "profile-transfer", "troubleshooting/index", "cli", "configuration/index", "mcp",
    "development/index", "development/architecture", "development/ui-session", "development/transactions",
    "development/source-layout", "development/testing", "development/acceptance", "development/public-site-checks",
    "development/agent-onboarding", "development/releasing", "development/camofox-integration"].map(name => `docs/${name}.md`)])
  if (!paths.includes(path)) throw Error("Archive is missing " + path);
for (const name of ["README", "configuration", "troubleshooting", "agents", "tests", "distribution", "releasing", "architecture", "camofox-patches", "onboarding-acceptance"])
  if (paths.includes(`docs/${name}.md`)) throw Error(`Archive contains obsolete documentation: docs/${name}.md`);
for (const path of ["dist/cli.js", "dist/supervisor.js", "dist/plugin.js", "dist/ui/index.html", "README.md", "LICENSE", "examples/profiles.json", "skills/stelz-browser/SKILL.md", ...["README.md", "stelz-logo.svg", "stelz-logo-full.svg", "stelz-logo-full-dark.svg", "favicon.svg"].map(name => "assets/brand/" + name), ...["react", "react-dom", "scheduler", "ibm-plex-mono", "ibm-plex-sans"].map(name => "dist/ui/licenses/" + name + ".txt")]) {
  if (!paths.includes(path)) throw Error("Archive is missing " + path);
}
for (const path of paths) if (!/^(?:node_modules\/|dist\/|assets\/(?:brand|screenshots)\/|docs\/|examples\/|skills\/|package.json$|README.md$|CONTRIBUTING.md$|CHANGELOG.md$|LICENSE$)/.test(path)) throw Error("Unexpected archive path: " + path);
await run([npm, "install", "--global", ...(input.flags.has("--native") ? [] : ["--ignore-scripts"]), "--no-audit", "--no-fund", "--prefer-offline", "--prefix", prefix, archive]);
const installed = join(prefix, "lib/node_modules/stelz");
const installedDependencies = inspectBundledDependencies(installed);
if (JSON.stringify(installedDependencies) !== JSON.stringify(preparedDependencies))
  throw Error("The installed archive changed the patched dependency files.");
const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
if (manifest.name !== "stelz" || manifest.version !== STELZ_VERSION || manifest.private || manifest.license !== "MIT") throw Error("Invalid release manifest.");
checkMarkdownLinks(["README.md", "CONTRIBUTING.md", "docs", "examples", "skills"].map(path => join(installed, path)));
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
// Setup creates the service files and validates the complete installed runtime without launching a browser.
const fakeBrowser = join(temp, "fake-browser/camoufox"), launched = join(temp, "browser-was-launched");
// Setup accepts only the paired build, so the fake reports its version.
mkdirSync(join(temp, "fake-browser")); writeFileSync(join(temp, "fake-browser/application.ini"), `[App]\nVersion=${pairedBrowser()}\n`);
writeFileSync(fakeBrowser, `#!/usr/bin/env bun\nawait Bun.write(${JSON.stringify(launched)}, "unexpected launch");\nprocess.exit(99);\n`);
chmodSync(fakeBrowser, 0o755);
await run([executable, "setup", "--yes"], { cwd, env: { ...cleanEnv, CAMOUFOX_EXECUTABLE: fakeBrowser } });
if (existsSync(launched)) throw Error("Setup executed the fake browser.");
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
  const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css|svg))"/g)].map(match => match[1]!);
  if (!assets.some(path => path.endsWith(".js")) || !assets.some(path => path.endsWith(".css"))) throw Error("The installed UI HTML is missing its bundled assets.");
  for (const path of assets) {
    const url = new URL(path, origin), asset = await fetch(url);
    if (!asset.ok) throw Error("An installed UI asset is unavailable.");
    if (path.endsWith(".svg") && asset.headers.get("content-type") !== "image/svg+xml") throw Error("An installed UI SVG has the wrong content type.");
    if (path.endsWith(".css")) {
      for (const match of (await asset.text()).matchAll(/url\(["']?([^\s)"']+)["']?\)/g)) {
        const resource = new URL(match[1]!, url);
        if (resource.origin !== origin || !(await fetch(resource)).ok) throw Error("An installed UI resource is unavailable or remote.");
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
const created = JSON.parse(await run([executable, "profile", "create", "work", "--direct", "--json"], { cwd, env: cleanEnv }));
if (!created.ok || !created.created || created.profile.id !== "work" || created.profile.storage !== "native")
  throw Error("The installed CLI did not create a native profile.");
const configBeforeReuse = readFileSync(join(home, "profiles.json"), "utf8"), secretsBeforeReuse = readFileSync(join(home, "secrets.env"), "utf8");
const reused = JSON.parse(await run([executable, "profile", "create", "work", "--json"], { cwd, env: cleanEnv }));
if (!reused.ok || reused.created || reused.profile.port !== created.profile.port ||
    readFileSync(join(home, "profiles.json"), "utf8") !== configBeforeReuse || readFileSync(join(home, "secrets.env"), "utf8") !== secretsBeforeReuse)
  throw Error("The installed CLI changed an existing profile.");
const runtime = join(home, "runtime");
const versions = JSON.parse(readFileSync(join(runtime, "versions.json"), "utf8"));
if (versions.stelz !== STELZ_VERSION || versions.camoufoxExecutable !== fakeBrowser || versions.upstreamVersion !== manifest.dependencies["@askjo/camofox-browser"])
  throw Error("Installed setup wrote an invalid runtime manifest.");
const upstream = join(runtime, "camofox-" + versions.upstreamVersion);
for (const path of ["server.js", "plugins/local-profile/index.js", "mcp/lib/tool-contracts.mjs", "node_modules/camoufox/dist/index.js"])
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
const nativeCheck = input.flags.has("--native") ? await nativeSmoke(node, installed, upstream, { cwd, env: cleanEnv }) : undefined;
assertArchiveUnchanged(candidate);
console.log(JSON.stringify({ result: "passed", archive, sha256: candidate.sha256, nativeCheck,
  checks: "Archive contents, Markdown links, isolated CLI, HTTP UI, and installed setup/dependency validation" }));
return { candidate, env: cleanEnv, cwd, home, prefix, node, bun, npm, executable, installedCli: join(installed, "dist/cli.js"), version, nativeCheck, uiChecked: true };
} finally { if (!options.keep) rmSync(temp, { recursive: true, force: true }); }
}

if (import.meta.main) {
  const input = packageArguments(process.argv.slice(2), ["--native"]);
  await installPackage(input.archive ?? resolve(import.meta.dir, "../../release-artifacts", `stelz-${STELZ_VERSION}.tgz`), { native: input.flags.has("--native") });
}
