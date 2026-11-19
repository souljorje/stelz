// Browser checks reuse one installed browser at its real path. They install one only when none is there.
// The browser, the location data, and the fingerprint model stay between runs in the cache folder of the project.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { browserPlan, prepareBrowser } from "../../src/browser/browser-setup.ts";
import { browserExecutable } from "../../src/browser/camoufox.ts";
import { assertTestHome } from "./test-home.ts";

/** `.cache/` in the main checkout. Git ignores it, and all worktrees of the project share it, so each download happens once. */
function projectCache() {
  const root = resolve(import.meta.dir, "../..");
  const git = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8" });
  return join(git.status === 0 ? dirname(git.stdout.trim()) : root, ".cache");
}
const cache = projectCache();

/**
 * Return the environment for `stelz setup` in a test home: the browser to use, and the cached location data.
 * The browser is the first paired build of: CAMOUFOX_EXECUTABLE, the default Stelz installation, the upstream cache, the project cache.
 * With none, the paired build goes into the project cache once. A check never changes the default installation.
 * A package seed supplies its own prepared runtime and browser.
 */
export async function useRuntimeCache(home: string): Promise<Record<string, string>> {
  assertTestHome(home);
  if (process.env.STELZ_TEST_SEED_HOME) {
    const source = assertTestHome(process.env.STELZ_TEST_SEED_HOME);
    const manifest = JSON.parse(readFileSync(join(source, "runtime/versions.json"), "utf8"));
    return { CAMOUFOX_EXECUTABLE: realpathSync(process.env.CAMOUFOX_EXECUTABLE || manifest.camoufoxExecutable) };
  }
  // A plan only reads. The download below writes to the project cache only.
  const plan = [join(homedir(), ".local/share/stelz"), cache]
    .map(directory => browserPlan(directory, process.env.CAMOUFOX_EXECUTABLE)).find(plan => plan.source !== "downloaded");
  const executable = !plan ? (await prepareBrowser(cache)).executable
    : plan.source === "upstream-cache" ? browserExecutable(plan.cached) : plan.executable;
  // Setup reads the cached location data as the current runtime. Without it, setup downloads, as in a new home.
  return { CAMOUFOX_EXECUTABLE: realpathSync(executable), ...(existsSync(join(cache, "geoip")) ? { STELZ_RUNTIME: cache } : {}) };
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
