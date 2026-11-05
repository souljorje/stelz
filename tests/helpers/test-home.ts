import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const markerName = ".stelz-test-home.json";

/** Create a new disposable service home. Never adopt an existing service directory. */
export function createTestHome(prefix: string, parent = tmpdir()): string {
  if (!/^[a-z][a-z0-9-]*$/.test(prefix)) throw Error("Use a simple test directory prefix.");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const home = realpathSync(mkdtempSync(join(parent, prefix + "-")));
  writeFileSync(join(home, markerName), JSON.stringify({ kind: "stelz-test-home", version: 1 }) + "\n", { mode: 0o600, flag: "wx" });
  return home;
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
