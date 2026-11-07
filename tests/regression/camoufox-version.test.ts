import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";

const launcher = new URL("../../node_modules/camoufox-js/dist/pkgman.js", import.meta.url).href;

function probe(directory: string, launch = false) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { installedVerStr, camoufoxPath, launchPath } from ${JSON.stringify(launcher)};
    console.log(JSON.stringify({ version: installedVerStr(), directory: camoufoxPath(false),
      ...(${launch} ? { executable: launchPath() } : {}) }));
  `], { env: { ...process.env, CAMOUFOX_INSTALL_DIR: directory }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

for (const metadata of [
  { version: "152.0.4", release: "beta.30" },
  { version: "152.0.4", build: "beta.30" },
]) test(`the installed launcher reads ${"release" in metadata ? "downloader" : "Python manager"} version metadata`, () => {
  const directory = mkdtempSync(join(tmpdir(), "stelz-browser-version-"));
  try {
    writeFileSync(join(directory, "version.json"), JSON.stringify(metadata));
    assert.deepEqual(probe(directory), {
      version: `${metadata.version}-${"release" in metadata ? metadata.release : metadata.build}`,
      directory,
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("the installed launcher resolves a versioned browser without selecting stale root metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "stelz-versioned-browser-"));
  try {
    const relative = "browsers/official/152.0.4-beta.30";
    const directory = join(root, relative);
    const executable = join(directory, process.platform === "darwin"
      ? "Camoufox.app/Contents/MacOS/camoufox" : process.platform === "win32" ? "camoufox.exe" : "camoufox-bin");
    mkdirSync(dirname(executable), { recursive: true });
    writeFileSync(executable, "browser fixture");
    writeFileSync(join(directory, "version.json"), JSON.stringify({ version: "152.0.4", build: "beta.30" }));
    writeFileSync(join(root, "version.json"), JSON.stringify({ version: "156.0.1", build: "beta.36" }));
    writeFileSync(join(root, "config.json"), JSON.stringify({ active_version: relative }));
    assert.deepEqual(probe(root, true), { version: "152.0.4-beta.30", directory, executable });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
