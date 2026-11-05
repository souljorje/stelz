import { packRelease } from "../../scripts/pack-release.ts";
import { verifyBundledDependencies, verifyBundledArchive } from "../../scripts/verify-bundled-dependencies.ts";
import { mkdtempSync, mkdirSync, symlinkSync, readFileSync, writeFileSync, readdirSync, lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { STELZ_VERSION } from "../../packages/stelz/src/versions.ts";
const root = resolve(import.meta.dir, "../.."), temp = mkdtempSync(join(tmpdir(), "stelz-package-"));
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
console.log("Pack and install the release archive into an isolated global prefix.");
await run([bun, "run", "build"]);
const packed = [await packRelease(join(root, "packages/stelz"), temp, { env, ignoreScripts: true })];
const archive = join(temp, packed[0]!.filename);
for (const file of packed[0]!.files) if (/^(src|test|\.git|\.codex|\.state|sessions)\//.test(file.path)) throw Error(`Unexpected archive file: ${file.path}`);
const uiFiles = packed[0]!.files.filter(file => file.path.startsWith("dist/ui/"));
if (!uiFiles.some(file => file.path === "dist/ui/index.html") || !uiFiles.some(file => file.path.endsWith(".js")) || !uiFiles.some(file => file.path.endsWith(".woff2"))) throw Error("The archive is missing built UI assets.");
verifyBundledArchive(packed[0]!.files.map(file => file.path));
await run([npm, "install", "--ignore-scripts", "--global", "--prefix", prefix, archive]);
verifyBundledDependencies(join(prefix, "lib/node_modules/stelz"), join(root, "packages/stelz"));
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
let uiChecked = false;
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
  for (const path of assets) if (!(await fetch(new URL(path, origin))).ok) throw Error("An installed UI asset is unavailable.");
  const shutdown = await fetch(`${origin}/api/shutdown`, { method: "POST", headers: { Cookie, Origin: origin, "Content-Type": "application/json" }, body: "{}" });
  if (!shutdown.ok || !(await shutdown.json() as { stopped?: boolean }).stopped || !shutdown.headers.get("set-cookie")?.includes("Max-Age=0"))
    throw Error("The installed UI did not end its session.");
  if (await ui.exited !== 0) throw Error("The installed UI did not exit cleanly after shutdown.");
  uiChecked = true;
} finally {
  clearTimeout(uiTimeout);
  ui.kill("SIGTERM");
  await ui.exited;
}
await run([executable, "setup"], { cwd, env: cleanEnv });
const installedCli = join(prefix, "lib/node_modules/stelz/dist/cli.js");
await run([bun, join(root, "tests/browser/integration.ts")], { cwd, env: { ...cleanEnv, STELZ_TEST_HOME: home, STELZ_TEST_CLI: installedCli }, inherit: true });
// Setup must resolve every dependency from the installed archive, not the source checkout.
function checkLinks(folder: string) {
  for (const name of readdirSync(folder)) {
    const file = join(folder, name), stat = lstatSync(file);
    if (stat.isSymbolicLink()) { if (realpathSync(file).startsWith(root)) throw Error(`Package depends on source checkout: ${file}`); }
    else if (stat.isDirectory()) checkLinks(file);
  }
}
checkLinks(join(home, "runtime"));
const evidence = { result: "passed", archive, version, globalPrefix: prefix, cwd, serviceHome: home, bundledUiChecked: uiChecked, harnessExecutablesRequired: false, llmCredentialsProvided: false, runtimeLinksReferToSourceCheckout: false, browserChecks: JSON.parse(readFileSync(join(home, "report.json"), "utf8")) };
mkdirSync(join(root, ".state/package-test"), { recursive: true, mode: 0o700 });
writeFileSync(join(root, ".state/package-test/report.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ result: evidence.result, archive, globalPrefix: prefix, serviceHome: home, cwd }, null, 2));
