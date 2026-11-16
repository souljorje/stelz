// Prepare the one runtime that a browser run shares. scripts/browser-tests.ts sets STELZ_TEST_SEED_HOME for each suite.
// Each run replaces the earlier one first, because the patch, the plugin, or the dependencies can change.
// A failed step leaves no seed, so the suites fail at once and never clone an old runtime.
// The location data and the fingerprint model survive in a cache outside the seed. Setup reads it as the current runtime,
// so setup's own refresh rule decides what to download. No suite uses the cache.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { SEED_CACHE, SEED_HOME, replaceTestHome } from "./test-home.ts";

const root = resolve(import.meta.dir, "../..");
const cache = SEED_CACHE;
const home = replaceTestHome(SEED_HOME);
const env: Record<string, string> = { STELZ_HOME: home };
for (const key of ["PATH", "HOME", "LANG", "TMPDIR", "CAMOUFOX_EXECUTABLE"]) if (process.env[key]) env[key] = process.env[key]!;
// A missing or broken cache gives setup nothing to reuse, so it downloads, as in a new home.
if (statSync(cache, { throwIfNoEntry: false })?.isDirectory()) env.STELZ_RUNTIME = cache;
function run(args: string[], options: { env?: Record<string, string> } = {}) {
  const { exitCode } = Bun.spawnSync([process.execPath, ...args], { cwd: root, ...options, stdout: "inherit", stderr: "inherit" });
  if (exitCode) throw Error(`bun ${args.join(" ")} failed with exit code ${exitCode}.`);
}
/** Replace the cache with the data of the new runtime. A rename makes the cache appear complete or not at all. */
function saveCache() {
  const stage = `${cache}.tmp`, retired = `${cache}.old`;
  for (const path of [stage, retired]) rmSync(path, { recursive: true, force: true });
  mkdirSync(stage, { mode: 0o700 });
  for (const name of ["geoip", "fpgen"]) {
    const from = join(home, "runtime", name), to = join(stage, name);
    // APFS clones share storage. Other filesystems fall back to a plain copy.
    if (spawnSync("/bin/cp", ["-cR", from, to]).status !== 0) cpSync(from, to, { recursive: true, verbatimSymlinks: true });
  }
  if (existsSync(cache)) renameSync(cache, retired);
  renameSync(stage, cache);
  rmSync(retired, { recursive: true, force: true });
}
try {
  // Setup stages the built plugin, so the build comes first.
  run(["run", "build"]);
  run(["--no-env-file", join(root, "src/cli/cli.ts"), "setup", "--yes"], { env });
  saveCache();
} catch (error) {
  rmSync(home, { recursive: true, force: true });
  console.error((error as Error).message);
  process.exit(1);
}
console.log(`Prepared the browser run runtime: ${home}`);
