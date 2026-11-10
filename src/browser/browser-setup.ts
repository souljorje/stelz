import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { browserAssetPattern, browserExecutable, browserPackage, browserPin, pairedBrowser } from "./camoufox.ts";
import { browserDirectory } from "../profiles/config.ts";
import { engineVersion } from "./location-launch.ts";
import { downloadReleaseAsset } from "./release-asset.ts";

export type BrowserSource = "configured" | "managed" | "upstream-cache" | "downloaded";
type Installed = { version: string; path: string };
// The cache is an optional source. A malformed entry there must not stop a download.
const upstreamInstalls = (): Installed[] => {
  try { return browserPackage().listInstalled().map(entry => ({ version: entry.version.fullString, path: entry.path })); } catch { return []; }
};

const paired = (executable: string) => {
  try { return statSync(executable).isFile() && !!engineVersion(executable); } catch { return false; }
};
// APFS clones share storage and copy instantly. Other filesystems fall back to a plain copy.
function clone(source: string, target: string) {
  if (process.platform === "darwin" && spawnSync("/bin/cp", ["-cR", source, target]).status === 0) return;
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true, verbatimSymlinks: true });
}

/**
 * Select the paired browser: the configured executable, Stelz's managed copy, a clone of the upstream cache install,
 * or a verified download. Only setup calls this, under the browser lock. A configured executable must be the paired build.
 */
export async function prepareBrowser(home: string, configured?: string,
  { request = fetch, installed = upstreamInstalls }: { request?: typeof fetch; installed?: () => Installed[] } = {}): Promise<{ executable: string; source: BrowserSource }> {
  if (configured) {
    if (!existsSync(configured) || !statSync(configured).isFile())
      throw Error(`Camoufox is missing at ${configured}. Correct or remove CAMOUFOX_EXECUTABLE, then run stelz setup.`);
    engineVersion(configured);
    return { executable: configured, source: "configured" };
  }
  const target = browserDirectory(home), managed = browserExecutable(target);
  if (paired(managed)) return { executable: managed, source: "managed" };
  const { unzip, makeExecutable } = browserPackage();
  mkdirSync(join(home, "browsers"), { recursive: true, mode: 0o700 });
  // The caller holds the browser lock, so an existing stage belongs to an interrupted setup.
  for (const name of readdirSync(join(home, "browsers"))) if (name.startsWith(".stage-")) rmSync(join(home, "browsers", name), { recursive: true, force: true });
  const stage = mkdtempSync(join(home, "browsers", ".stage-")), install = join(stage, "browser");
  try {
    let source: BrowserSource;
    // Read the shared upstream cache only. Its own commands can prune or delete it, so Stelz keeps a clone.
    const cached = installed().find(entry => entry.version === pairedBrowser() && paired(browserExecutable(entry.path)));
    if (cached) {
      clone(cached.path, install); source = "upstream-cache";
    } else {
      const pin = browserPin(), pattern = browserAssetPattern(), zip = join(stage, "browser.zip");
      console.error(`Downloading Camoufox ${pairedBrowser()}…`);
      const asset = await downloadReleaseAsset({ label: "Camoufox", repository: pin.repo, tag: pin.tag, maxBytes: 2 * 1024 ** 3, timeoutMs: 3_600_000,
        match: name => { const groups = pattern.exec(name)?.groups; return groups?.version === pin.version && groups?.build === pin.build; } }, zip, request);
      unzip(zip, install, "", false);
      makeExecutable(install);
      rmSync(zip);
      writeFileSync(join(install, "version.json"), JSON.stringify({ version: pin.version, build: pin.build, release: asset.release, asset: asset.name, sha256: asset.sha256 }, null, 2));
      source = "downloaded";
    }
    if (!paired(browserExecutable(install))) throw Error("The prepared Camoufox is incomplete. Run stelz setup again.");
    // An unusable earlier copy cannot run, so no browser depends on it.
    rmSync(target, { recursive: true, force: true });
    renameSync(install, target);
    return { executable: managed, source };
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
