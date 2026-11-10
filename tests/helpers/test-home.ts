import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const markerName = ".stelz-test-home.json";

/** Create a new disposable service home. Never adopt an existing service directory. */
export function createTestHome(prefix: string, parent = tmpdir()): string {
  if (!/^[a-z][a-z0-9-]*$/.test(prefix)) throw Error("Use a simple test directory prefix.");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const home = realpathSync(mkdtempSync(join(parent, prefix + "-")));
  writeFileSync(join(home, markerName), JSON.stringify({ kind: "stelz-test-home", version: 1 }) + "\n", { mode: 0o600, flag: "wx" });
  if (process.env.STELZ_TEST_SEED_HOME) seedRuntime(home, process.env.STELZ_TEST_SEED_HOME);
  return home;
}

// The package suite prepares one runtime. A seeded home reuses its location data and model, so setup downloads nothing.
function seedRuntime(home: string, source: string) {
  const link = readlinkSync(join(source, "runtime")), from = join(source, link), to = join(home, link);
  mkdirSync(join(home, "runtime-generations"), { mode: 0o700 });
  // APFS clones share storage. Links stay links, so dependencies resolve to the same installation.
  if (spawnSync("/bin/cp", ["-cR", from, to]).status !== 0) cpSync(from, to, { recursive: true, verbatimSymlinks: true });
  symlinkSync(link, join(home, "runtime"));
}

/** Refuse operator data before a test can initialize, connect to, or stop profiles. */
export function assertTestHome(directory: string): string {
  const error = () => Error("Refusing an unowned service directory. Create a disposable test home with createTestHome().");
  try {
    const home = realpathSync(resolve(directory));
    const normal = join(homedir(), ".local/share/stelz");
    if (home === (existsSync(normal) ? realpathSync(normal) : normal)) throw error();
    const file = join(home, markerName), stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 1024) throw error();
    const marker = JSON.parse(readFileSync(file, "utf8"));
    if (marker?.kind !== "stelz-test-home" || marker.version !== 1) throw error();
    return home;
  } catch { throw error(); }
}

/** Create the service files with the production initializer, without a full setup. */
export function initializeHome(home: string) {
  const config = resolve(import.meta.dir, "../../src/profiles/config.ts");
  const result = Bun.spawnSync([process.execPath, "--no-env-file", "-e", `(await import(${JSON.stringify(config)})).initialize()`],
    { env: { ...process.env, STELZ_HOME: home }, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw Error(result.stderr.toString() || "Cannot initialize the test home.");
}
