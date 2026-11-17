// The browser, the location data, and the fingerprint model survive between browser runs in a cache in the system temp directory.
// Setup still decides what to use: it checks that the browser is the paired build, and its own refresh rule decides what to download.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cache = join(tmpdir(), "stelz-seed-cache");
// Where each cached directory lives in a service home.
const parts = { geoip: "runtime/geoip", fpgen: "runtime/fpgen", browsers: "browsers" };

// APFS clones share storage and copy instantly. Other filesystems fall back to a plain copy.
function clone(from: string, to: string) {
  if (spawnSync("/bin/cp", ["-cR", from, to]).status !== 0) cpSync(from, to, { recursive: true, verbatimSymlinks: true });
}

/**
 * Give a new test home the cached browser, and return the environment for `stelz setup`.
 * A missing cache gives setup nothing to reuse, so it downloads, as in a new home.
 */
export function useRuntimeCache(home: string): Record<string, string> {
  if (!existsSync(cache)) return {};
  if (existsSync(join(cache, "browsers")) && !existsSync(join(home, "browsers"))) clone(join(cache, "browsers"), join(home, "browsers"));
  // Setup reads the cache as the current runtime.
  return { STELZ_RUNTIME: cache };
}

/** Replace the cache with the data of `home` after setup. A rename makes the cache appear complete or not at all. */
export function saveRuntimeCache(home: string) {
  const stage = `${cache}.tmp`, retired = `${cache}.old`;
  for (const path of [stage, retired]) rmSync(path, { recursive: true, force: true });
  mkdirSync(stage, { mode: 0o700 });
  for (const [name, path] of Object.entries(parts)) {
    // A run with CAMOUFOX_EXECUTABLE has no browser of its own. The cached one stays.
    const from = [join(home, path), join(cache, name)].find(existsSync);
    if (from) clone(from, join(stage, name));
  }
  if (existsSync(cache)) renameSync(cache, retired);
  renameSync(stage, cache);
  rmSync(retired, { recursive: true, force: true });
}
