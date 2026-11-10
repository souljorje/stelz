// Acceptance for setup and updates on one unchanged archive. See docs/development/smooth-setup.md, section 6.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { installPackage } from "./install.ts";
import { packageArguments, assertArchiveUnchanged } from "../../scripts/package-archive.ts";
import { createTestHome } from "../helpers/test-home.ts";
import { browserPackage, pairedBrowser } from "../../src/browser/camoufox.ts";
import { STELZ_VERSION } from "../../src/versions.ts";

type Run = { code: number; out: string; err: string };
type Report = { home: string; browser: { source: string; executable: string }; fingerprintModel: string; runtime: { id: string; status: string };
  locationData: Record<string, { source: string; release: string; builtAt: string; status: string }> };
type Child = Bun.Subprocess<"ignore", "pipe", "pipe">;

const root = resolve(import.meta.dir, "../..");
const archive = packageArguments(process.argv.slice(2)).archive ?? join(root, "release-artifacts", `stelz-${STELZ_VERSION}.tgz`);
const paired = pairedBrowser();
// The clone case needs the paired build in the upstream cache. Check it before the installation.
const cached = browserPackage().listInstalled().find(entry => entry.version.fullString === paired);
if (!cached) throw Error(`The clone case needs Camoufox ${paired} in the upstream cache.`);
const installed = await installPackage(archive, { native: true, keep: true });
const { candidate, cwd } = installed, temp = dirname(installed.prefix);
// A user home without the upstream Camoufox cache. The offline settings block every remote request from setup.
const userHome = join(temp, "user-home"), hidden = { HOME: userHome };
const offline = { ...Object.fromEntries(["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY"].map(name => [name, "http://127.0.0.1:9"])),
  NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", NODE_USE_ENV_PROXY: "1" };
mkdirSync(userHome);
const evidence: Record<string, unknown> = {};
let passed = false, running: { cli: string; env: Record<string, string> } | undefined;
const children = new Set<Child>();

const envFor = (home: string, extra: Record<string, string> = {}) => ({ ...installed.env, STELZ_HOME: home, ...extra });
function spawnCli(args: string[], env: Record<string, string>, cli = installed.executable): Child {
  const child = Bun.spawn([cli, ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  children.add(child); void child.exited.then(() => children.delete(child));
  return child;
}
async function finish(child: Child): Promise<Run> {
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, out, err };
}
const cli = (args: string[], env: Record<string, string>, file?: string) => finish(spawnCli(args, env, file));
async function command(args: string[], env?: Record<string, string>) {
  const child = Bun.spawn(args, { cwd, env: env ?? { PATH: process.env.PATH!, HOME: process.env.HOME!, TMPDIR: process.env.TMPDIR ?? "/tmp",
    npm_config_cache: join(temp, "npm-cache"), COPYFILE_DISABLE: "1" }, stdout: "pipe", stderr: "pipe" });
  const result = await finish(child);
  if (result.code) throw Error(`${args.join(" ")} failed: ${result.err || result.out}`);
}
function check(condition: unknown, message: string, detail?: unknown): asserts condition {
  if (!condition) throw Error(detail === undefined ? message : `${message}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}
/** A failed JSON command prints nothing on stdout and one JSON error as the last stderr line. */
function failure(result: Run, label: string) {
  check(result.code && !result.out.trim(), `${label} must fail without stdout`, result);
  return (JSON.parse(result.err.trim().split("\n").at(-1)!) as { error: { code: string; message: string; downloads?: { name: string; source: string }[] } }).error;
}
/** A successful setup prints exactly one JSON report on stdout. */
function report(result: Run, home: string, label: string) {
  check(!result.code, `${label} failed`, result.err || result.out);
  const value = JSON.parse(result.out) as Report;
  check(value.home === home && /^[a-f0-9]{16}$/.test(value.runtime?.id) && ["prepared", "reused"].includes(value.runtime.status) &&
    ["reused", "downloaded"].includes(value.fingerprintModel) && existsSync(value.browser?.executable) &&
    Object.keys(value.locationData ?? {}).sort().join() === "comparison,selection", `${label} printed an invalid report`, result.out);
  if (value.browser.source !== "configured") check(value.browser.executable.startsWith(join(home, "browsers", paired) + "/"), `${label} selected an unmanaged browser`, value.browser);
  check(readlinkSync(join(home, "runtime")) === join("runtime-generations", value.runtime.id), `${label} did not activate its generation`);
  return value;
}
const sources = (value: Report) => ({ browser: value.browser.source, selection: value.locationData.selection!.status,
  comparison: value.locationData.comparison!.status, model: value.fingerprintModel, runtime: value.runtime.status });
function same(actual: unknown, expected: unknown, label: string) { check(JSON.stringify(actual) === JSON.stringify(expected), `${label}: expected ${JSON.stringify(expected)}`, actual); }
const generations = (home: string) => existsSync(join(home, "runtime-generations"))
  ? readdirSync(join(home, "runtime-generations")).filter(name => !name.startsWith(".")).sort() : [];
const stages = (home: string, folder = "browsers") => existsSync(join(home, folder)) ? readdirSync(join(home, folder)).filter(name => name.startsWith(".stage-")) : [];
const prepared = (home: string) => existsSync(join(home, "browsers", paired)) || existsSync(join(home, "runtime"));
async function until(condition: () => boolean, timeout: number, message: string, child?: Child) {
  for (const end = Date.now() + timeout; !condition();) {
    if (child && child.exitCode !== null) throw Error(`${message} Setup exited: ${(await finish(child)).err}`);
    if (Date.now() > end) throw Error(message);
    await Bun.sleep(250);
  }
}
const size = (file: string) => { try { return statSync(file).size; } catch { return 0; } };
// Path, size, and modification time of every entry. Equal snapshots show that setup only read the directory.
function snapshot(folder: string) {
  return (readdirSync(folder, { recursive: true }) as string[]).sort().map(name => {
    const info = statSync(join(folder, name), { throwIfNoEntry: false });
    return `${name}:${info?.size}:${info?.mtimeMs}`;
  }).join("\n");
}
async function status(id: string, cliFile: string, env: Record<string, string>) {
  const result = await cli(["status", id, "--json"], env, cliFile);
  check(!result.code, "Status failed", result.err);
  return JSON.parse(result.out) as { phase: string; restartToUpdate: boolean };
}
const runtimeOf = (home: string, id: string) => (JSON.parse(readFileSync(join(home, "profiles", id, "running.json"), "utf8")) as { pid: number; runtime: string });

try {
  // 1. Without consent, setup lists every download and prepares nothing.
  const fresh = createTestHome("fresh", temp);
  const refused = failure(await cli(["setup", "--json"], envFor(fresh, hidden)), "Setup without consent");
  check(refused.code === "confirmation_required" && refused.downloads?.length === 4 && refused.downloads[0]!.name === `Camoufox ${paired}`,
    "Setup without consent must list the browser, both location datasets, and the model", refused);
  check(!prepared(fresh), "Setup without consent prepared a browser or runtime");
  evidence.consent = refused.downloads.map(item => item.name);

  // 2. A configured executable must be the paired build. Setup selects no other browser.
  const configured = createTestHome("configured", temp), wrong = join(temp, "wrong-browser");
  mkdirSync(wrong);
  writeFileSync(join(wrong, "application.ini"), "[App]\nVersion=152.0.1-beta.25\n");
  writeFileSync(join(wrong, "camoufox"), "#!/bin/sh\nexit 99\n");
  chmodSync(join(wrong, "camoufox"), 0o755);
  for (const [file, text] of [[join(wrong, "camoufox"), "is not supported"], [join(wrong, "missing"), "Camoufox is missing"]] as const) {
    const error = failure(await cli(["setup", "--yes", "--json"], envFor(configured, { ...hidden, CAMOUFOX_EXECUTABLE: file })), "Setup with a wrong browser");
    check(error.code === "setup_failed" && error.message.includes(text), `A wrong configured browser must report "${text}"`, error);
  }
  check(!prepared(configured), "A refused configured browser prepared state");
  evidence.wrongBrowser = "refused";

  // 3. Control: the offline settings make a setup that needs downloads fail with a connection message.
  const control = failure(await cli(["setup", "--yes", "--json"], envFor(createTestHome("offline", temp), { ...hidden, ...offline })), "Offline setup without data");
  check(control.message.includes("Check the connection"), "Offline setup must name the connection", control);
  evidence.offlineControl = control.message;

  // 4. Setup clones the paired build from the upstream cache and only reads the cache.
  const cacheBefore = snapshot(cached.path), cacheHome = createTestHome("cached", temp);
  const cloned = report(await cli(["setup", "--yes", "--json"], envFor(cacheHome)), cacheHome, "Setup from the upstream cache");
  check(cloned.browser.source === "upstream-cache", "Setup must clone the upstream cache install", cloned.browser);
  check(snapshot(cached.path) === cacheBefore, "Setup changed the upstream cache");
  evidence.upstreamCache = { ...sources(cloned), cache: cached.path };

  // 5. An interrupted download activates nothing.
  const interrupted = spawnCli(["setup", "--yes", "--json"], envFor(fresh, hidden));
  const zip = () => stages(fresh).map(name => join(fresh, "browsers", name, "browser.zip")).find(existsSync);
  await until(() => size(zip() ?? "") > 64 * 1024 ** 2, 900_000, "The browser download did not start.", interrupted);
  let signal: NodeJS.Signals = "SIGINT";
  interrupted.kill(signal);
  if (await Promise.race([interrupted.exited.then(() => true), Bun.sleep(10_000).then(() => false)]) === false) { signal = "SIGKILL"; interrupted.kill(signal); }
  const interruption = await finish(interrupted);
  check(interruption.code !== 0 && !prepared(fresh), "An interrupted setup activated a browser or runtime", interruption);
  evidence.interrupted = { signal, exitCode: interruption.code };

  // 6. The retry downloads and verifies everything. A concurrent setup waits for it, then reuses its result.
  const stale = stages(fresh), started = Date.now();
  const first = spawnCli(["setup", "--yes", "--json"], envFor(fresh, hidden));
  await until(() => stages(fresh).some(name => !stale.includes(name)), 300_000, "The retry did not start its download.", first);
  const second = spawnCli(["setup", "--yes", "--json"], envFor(fresh, hidden));
  const [retried, concurrent] = await Promise.all([finish(first), finish(second)]);
  const download = report(retried, fresh, "Retried setup"), waited = report(concurrent, fresh, "Concurrent setup");
  same(sources(download), { browser: "downloaded", selection: "downloaded", comparison: "downloaded", model: "downloaded", runtime: "prepared" }, "Retried setup");
  same(sources(waited), { browser: "managed", selection: "reused", comparison: "reused", model: "reused", runtime: "reused" }, "Concurrent setup");
  const left = [...stages(fresh), ...stages(fresh, "runtime-generations")];
  check(waited.runtime.id === download.runtime.id && !left.length, "Setup left a stage or a second generation", { left, generations: generations(fresh) });
  same(generations(fresh), [download.runtime.id], "Generations after the retry");
  const version = JSON.parse(readFileSync(join(fresh, "browsers", paired, "version.json"), "utf8")) as { sha256: string; asset: string };
  evidence.download = { ...sources(download), asset: version.asset, sha256: version.sha256, minutes: Math.round((Date.now() - started) / 6000) / 10 };

  // 7. A repeat with all parts ready needs no network.
  const repeat = report(await cli(["setup", "--yes", "--json"], envFor(fresh, { ...hidden, ...offline })), fresh, "Offline repeat");
  const { selection, comparison, ...parts } = sources(repeat);
  same(parts, { browser: "managed", model: "reused", runtime: "reused" }, "Offline repeat");
  // Data older than the refresh limit is kept offline.
  check([selection, comparison].every(item => ["reused", "kept"].includes(item)), "Offline repeat must keep location data", repeat.locationData);
  evidence.offlineRepeat = sources(repeat);

  // 8. Update an installation while a profile runs. The earlier release differs only in its plugin file.
  const unpacked = join(temp, "previous"), previous = join(temp, "previous.tgz"), updatePrefix = join(temp, "update");
  mkdirSync(unpacked);
  await command(["tar", "-xzf", archive, "-C", unpacked]);
  appendFileSync(join(unpacked, "package/dist/plugin.js"), "\n// An earlier release for update acceptance.\n");
  await command(["tar", "-czf", previous, "-C", unpacked, "package"]);
  const npm = Bun.which("npm")!, install = (file: string) => command([npm, "install", "--global", "--no-audit", "--no-fund", "--prefix", updatePrefix, file]);
  await install(previous);
  const updateCli = join(updatePrefix, "bin/stelz");
  const updateEnv = envFor(fresh, { PATH: installed.env.PATH!.replace(join(installed.prefix, "bin"), join(updatePrefix, "bin")) });
  const before = report(await cli(["setup", "--yes", "--json"], updateEnv, updateCli), fresh, "Setup of the earlier release");
  same([before.browser.source, before.runtime.status], ["managed", "prepared"], "Setup of the earlier release");
  same(generations(fresh), [before.runtime.id], "Generations before the update");
  const created = await cli(["profile", "create", "work", "--direct", "--json"], updateEnv, updateCli);
  check(!created.code, "Profile creation failed", created.err);
  running = { cli: updateCli, env: updateEnv };
  const start = await cli(["start", "work", "--json"], updateEnv, updateCli);
  check(!start.code, "Start failed", start.err);
  check((await status("work", updateCli, updateEnv)).phase === "ready", "The started profile is not ready");
  const lifetime = runtimeOf(fresh, "work");
  check(lifetime.runtime === before.runtime.id, "The profile does not record its generation", lifetime);

  await install(archive);
  const updated = report(await cli(["setup", "--yes", "--json"], { ...updateEnv, ...offline }, updateCli), fresh, "Setup after the update");
  same([updated.browser.source, updated.fingerprintModel, updated.runtime.status], ["managed", "reused", "prepared"], "Setup after the update");
  same(generations(fresh), [before.runtime.id, updated.runtime.id].sort(), "Generations while the profile runs");
  const pending = await status("work", updateCli, updateEnv);
  check(pending.phase === "ready" && pending.restartToUpdate && runtimeOf(fresh, "work").pid === lifetime.pid, "Setup disturbed the running profile", pending);

  const restarted = await cli(["restart", "work", "--json"], updateEnv, updateCli);
  check(!restarted.code, "Restart failed", restarted.err);
  const current = await status("work", updateCli, updateEnv);
  check(current.phase === "ready" && !current.restartToUpdate && runtimeOf(fresh, "work").runtime === updated.runtime.id, "Restart did not apply the update", current);
  const cleaned = report(await cli(["setup", "--yes", "--json"], updateEnv, updateCli), fresh, "Setup after the restart");
  same([cleaned.runtime.status, generations(fresh)], ["reused", [updated.runtime.id]], "Setup after the restart");
  const stopped = await cli(["stop", "work", "--json"], updateEnv, updateCli);
  check(!stopped.code, "Stop failed", stopped.err);
  running = undefined;
  evidence.update = { before: before.runtime.id, after: updated.runtime.id, setupOffline: sources(updated), restarted: true, removedEarlierGeneration: true };

  assertArchiveUnchanged(candidate);
  passed = true;
  const result = { result: "passed", archive, sha256: candidate.sha256, version: installed.version, cases: evidence };
  mkdirSync(join(root, ".state/package-test"), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, ".state/package-test/setup-report.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result, null, 2));
} finally {
  // End only the setup commands that this script started. Stop the test profile through the CLI.
  for (const child of children) child.kill("SIGKILL");
  if (running) {
    const stop = await cli(["stop", "work", "--json"], running.env, running.cli);
    if (stop.code) console.error(`Could not stop the test profile. Run stelz stop work with STELZ_HOME=${running.env.STELZ_HOME}: ${stop.err}`);
  }
  if (passed) rmSync(temp, { recursive: true, force: true });
  else console.error(`Kept the failed acceptance files in ${relative(process.cwd(), temp) || temp}.`);
}
