import { before, after } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launcher } from "../../src/browser/camoufox.ts";

/** Node regression workers use local launcher resources, never an installed browser or the user's cache. */
export function mockLauncherResources() {
  let restore: (() => void) | undefined;
  before(() => {
    const directory = mkdtempSync(join(tmpdir(), "stelz-launcher-resources-"));
    const deps = launcher().utilsDeps;
    const original = { getPath: deps.getPath, installDir: deps.installDir, osName: deps.osName };
    restore = () => { Object.assign(deps, original); rmSync(directory, { recursive: true, force: true }); };
    for (const os of ["linux", "macos", "windows"]) {
      mkdirSync(join(directory, "fontconfig", os), { recursive: true });
      writeFileSync(join(directory, "fontconfig", os, "fonts.conf"), '<fontconfig><dir prefix="cwd">fonts</dir></fontconfig>');
    }
    deps.getPath = file => join(directory, file);
    deps.installDir = () => join(directory, "cache");
    // Cover the Linux-only fontconfig path on every test host.
    deps.osName = () => "lin";
  });
  after(() => restore?.());
}
