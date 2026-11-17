// The browser, the location data, and the fingerprint model stay between browser runs in a cache in the system temp directory.
// Setup still decides what to use: it checks that the browser is the paired build, and its own refresh rule decides what to download.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { browserPlan } from "../../src/browser/browser-setup.ts";
import { browserExecutable } from "../../src/browser/camoufox.ts";
import { assertTestHome } from "./test-home.ts";

const cache = join(tmpdir(), "stelz-seed-cache");

/**
 * Reuse an installed browser at its real path. Routine checks never install another browser.
 * A package seed supplies its own prepared runtime and browser.
 */
export function useRuntimeCache(home: string): Record<string, string> {
  assertTestHome(home);
  if (process.env.STELZ_TEST_SEED_HOME) {
    const source = assertTestHome(process.env.STELZ_TEST_SEED_HOME);
    const manifest = JSON.parse(readFileSync(join(source, "runtime/versions.json"), "utf8"));
    return { CAMOUFOX_EXECUTABLE: realpathSync(process.env.CAMOUFOX_EXECUTABLE || manifest.camoufoxExecutable) };
  }
  const plan = [cache, join(homedir(), ".local/share/stelz")]
    .map(directory => browserPlan(directory, process.env.CAMOUFOX_EXECUTABLE))
    .find(plan => plan.source !== "downloaded");
  if (!plan) throw Error("No paired Camoufox is installed. Run bun run setup once, or set CAMOUFOX_EXECUTABLE to the paired build.");
  const executable = realpathSync(plan.source === "upstream-cache" ? browserExecutable(plan.cached) : plan.executable);
  // Setup reads the cached location data as the current runtime. Without it, setup downloads, as in a new home.
  return { CAMOUFOX_EXECUTABLE: executable, ...(existsSync(join(cache, "geoip")) ? { STELZ_RUNTIME: cache } : {}) };
}

/** Replace the cached location data and model with those of `home` after setup. A rename makes each one appear complete or not at all. */
export function saveRuntimeCache(home: string) {
  assertTestHome(home);
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  for (const name of ["geoip", "fpgen"]) {
    const from = join(home, "runtime", name), to = join(cache, name), stage = `${to}.tmp`, retired = `${to}.old`;
    for (const path of [stage, retired]) rmSync(path, { recursive: true, force: true });
    // APFS clones share storage and copy instantly. Other filesystems fall back to a plain copy.
    if (spawnSync("/bin/cp", ["-cR", from, stage]).status !== 0) cpSync(from, stage, { recursive: true, verbatimSymlinks: true });
    if (existsSync(to)) renameSync(to, retired);
    renameSync(stage, to);
    rmSync(retired, { recursive: true, force: true });
  }
}
