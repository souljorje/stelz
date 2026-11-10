import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { browserAssetPattern, browserExecutable, browserPackage, browserPin, pairedBrowser } from "./camoufox.ts";
import { browserDirectory } from "../profiles/config.ts";
import { engineVersion } from "./location-launch.ts";
import { downloadReleaseAsset, type ReleaseAssetRequest } from "./release-asset.ts";

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

/** The pinned Camoufox release and its single asset for this platform. */
export function browserRelease(): ReleaseAssetRequest {
  const pin = browserPin(), pattern = browserAssetPattern();
  return { label: "Camoufox", repository: pin.repo, tag: pin.tag, maxBytes: 2 * 1024 ** 3, timeoutMs: 3_600_000,
    match: name => { const groups = pattern.exec(name)?.groups; return groups?.version === pin.version && groups?.build === pin.build; } };
}

type BrowserDependencies = { request?: typeof fetch; installed?: () => Installed[]; progress?: (message: string) => void };
/** Decide which browser setup uses, without changes. A configured executable must be the paired build. */
export function browserPlan(home: string, configured?: string, { installed = upstreamInstalls }: BrowserDependencies = {}) {
  if (configured) {
    if (!existsSync(configured) || !statSync(configured).isFile())
      throw Error(`Camoufox is missing at ${configured}. Correct or remove CAMOUFOX_EXECUTABLE, then run stelz setup.`);
    engineVersion(configured);
    return { source: "configured" as const, executable: configured };
  }
  const executable = browserExecutable(browserDirectory(home));
  if (paired(executable)) return { source: "managed" as const, executable };
  // Read the shared upstream cache only. Its own commands can prune or delete it, so Stelz keeps a clone.
  const cached = installed().find(entry => entry.version === pairedBrowser() && paired(browserExecutable(entry.path)));
  return cached ? { source: "upstream-cache" as const, executable, cached: cached.path } : { source: "downloaded" as const, executable };
}

/**
 * Prepare the planned browser: the configured executable, Stelz's managed copy, a clone of the upstream cache install,
 * or a verified download. Only setup calls this, under the browser lock.
 */
export async function prepareBrowser(home: string, configured?: string, dependencies: BrowserDependencies = {}): Promise<{ executable: string; source: BrowserSource }> {
  const plan = browserPlan(home, configured, dependencies);
  if (plan.source === "configured" || plan.source === "managed") return plan;
  const { unzip, makeExecutable } = browserPackage(), target = browserDirectory(home);
  mkdirSync(join(home, "browsers"), { recursive: true, mode: 0o700 });
  // The caller holds the browser lock, so an existing stage belongs to an interrupted setup.
  for (const name of readdirSync(join(home, "browsers"))) if (name.startsWith(".stage-")) rmSync(join(home, "browsers", name), { recursive: true, force: true });
  const stage = mkdtempSync(join(home, "browsers", ".stage-")), install = join(stage, "browser");
  try {
    const progress = dependencies.progress ?? console.error;
    if (plan.source === "upstream-cache") {
      progress(`Copying Camoufox ${pairedBrowser()} from the upstream cache…`);
      clone(plan.cached, install);
    } else {
      const pin = browserPin(), zip = join(stage, "browser.zip");
      progress(`Downloading Camoufox ${pairedBrowser()} (over 1 GB). This can take several minutes…`);
      const asset = await downloadReleaseAsset(browserRelease(), zip, dependencies.request ?? fetch);
      unzip(zip, install, "", false);
      makeExecutable(install);
      rmSync(zip);
      writeFileSync(join(install, "version.json"), JSON.stringify({ version: pin.version, build: pin.build, release: asset.release, asset: asset.name, sha256: asset.sha256 }, null, 2));
    }
    if (!paired(browserExecutable(install))) throw Error("The prepared Camoufox is incomplete. Run stelz setup again.");
    // An unusable earlier copy cannot run, so no browser depends on it.
    rmSync(target, { recursive: true, force: true });
    renameSync(install, target);
    return { executable: plan.executable, source: plan.source };
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
