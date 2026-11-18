import { packageArguments, inspectPackageArchive, assertArchiveUnchanged } from "../../scripts/package-archive.ts";
import { nativeSmoke } from "../helpers/native-dependencies.ts";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { STELZ_VERSION } from "../../src/versions.ts";
import { createTestHome } from "../helpers/test-home.ts";

// Each run installs into a new prefix.
export async function installPackage(archive: string, options: { native?: boolean; keep?: boolean } = {}) {
const root = resolve(import.meta.dir, "../.."), temp = mkdtempSync(join(tmpdir(), "stelz-package-"));
const prefix = join(temp, "global"), cwd = join(temp, "empty"), home = createTestHome("data", temp), bin = join(temp, "bin");
for (const path of [cwd, bin]) mkdirSync(path, { recursive: true });
const npm = Bun.which("npm")!, node = Bun.which("node")!, bun = Bun.which("bun")!;
symlinkSync(node, join(bin, "node")); symlinkSync(bun, join(bin, "bun"));
const env: Record<string, string> = { PATH: process.env.PATH!, HOME: process.env.HOME! };
if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
async function run(args: string[], options: { cwd?: string; env?: Record<string, string> } = {}) {
  const p = Bun.spawn(args, { cwd: options.cwd || root, env: options.env || env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code) throw Error(err || out); return out;
}
console.log(`Verify isolated browser-free installation (${options.native ? "ordinary native installation" : "lifecycle scripts disabled"}).`);
try {
const candidate = inspectPackageArchive(archive);
await run([npm, "install", "--global", ...(options.native ? [] : ["--ignore-scripts"]), "--no-audit", "--no-fund", "--prefer-offline", "--prefix", prefix, archive]);
const installed = join(prefix, "lib/node_modules/stelz");
const cleanEnv: Record<string, string> = { PATH: `${join(prefix, "bin")}:${bin}:/usr/bin:/bin`, HOME: env.HOME!, STELZ_HOME: home };
if (env.TMPDIR) cleanEnv.TMPDIR = env.TMPDIR;
const executable = join(prefix, "bin/stelz");
const version = (await run([executable, "--version"], { cwd, env: cleanEnv })).trim();
if (version !== STELZ_VERSION) throw Error("Global command version does not match.");
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
  const response = await fetch(origin);
  if (!response.ok) throw Error("The installed UI is unavailable.");
  const html = await response.text();
  const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css|svg))"/g)].map(match => match[1]!);
  if (!assets.some(path => path.endsWith(".js")) || !assets.some(path => path.endsWith(".css"))) throw Error("The installed UI HTML is missing its bundled assets.");
  for (const path of assets) {
    const url = new URL(path, origin), asset = await fetch(url);
    if (!asset.ok) throw Error("An installed UI asset is unavailable.");
    if (path.endsWith(".css")) {
      for (const match of (await asset.text()).matchAll(/url\(["']?([^\s)"']+)["']?\)/g)) {
        const resource = new URL(match[1]!, url);
        if (resource.origin !== origin || !(await fetch(resource)).ok) throw Error("An installed UI resource is unavailable or remote.");
      }
    }
  }
} finally {
  clearTimeout(uiTimeout);
  ui.kill("SIGTERM");
  await ui.exited;
}
// Resolve the public SDK entrypoint from a consumer outside the checkout.
const project = join(temp, "sdk-project");
mkdirSync(join(project, "node_modules"), { recursive: true });
symlinkSync(installed, join(project, "node_modules/stelz"));
writeFileSync(join(project, "job.ts"), `import { acquire, start, LocationError } from "stelz/sdk";
if ([acquire, start, LocationError].some(value => typeof value !== "function")) throw Error("stelz/sdk lacks an export.");
`);
await run([bun, "--no-env-file", join(project, "job.ts")], { cwd: project, env: cleanEnv });
const nativeCheck = options.native ? await nativeSmoke(node, installed, { cwd, env: cleanEnv }) : undefined;
assertArchiveUnchanged(candidate);
console.log(JSON.stringify({ result: "passed", archive, sha256: candidate.sha256, nativeCheck,
  checks: "Isolated CLI, HTTP UI assets, stelz/sdk import, and native dependencies" }));
return { candidate, env: cleanEnv, cwd, home, prefix, node, bun, npm, executable, installedCli: join(installed, "src/cli/cli.ts"), version, nativeCheck, uiChecked: true };
} finally { if (!options.keep) rmSync(temp, { recursive: true, force: true }); }
}

if (import.meta.main) {
  const input = packageArguments(process.argv.slice(2), ["--native", "--both"]);
  const archive = input.archive ?? resolve(import.meta.dir, "../../release-artifacts", `stelz-${STELZ_VERSION}.tgz`);
  if (input.flags.has("--both")) {
    if (input.flags.has("--native")) throw Error("Use --both or --native, not both flags.");
    // Each mode creates its own prefix and service home. Wait for both before failing.
    const results = await Promise.allSettled([false, true].map(native => installPackage(archive, { native })));
    const failures = results.filter(result => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Package installation checks failed.");
  } else await installPackage(archive, { native: input.flags.has("--native") });
}
