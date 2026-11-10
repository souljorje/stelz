import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { downloadReleaseAsset, readRelease, type Release } from "./release-asset.ts";
import { managedGeoip, validateGeoip, geoipFile, GEOIP_SOURCES, GEOIP_REFRESH_DAYS,
  type GeoipDataset, type GeoipManifest, type GeoipRole } from "./location.ts";

const MAX_BYTES = 256 * 1024 * 1024, DAY_MS = 86_400_000;
export type GeoipStatus = "reused" | "downloaded" | "kept";
async function existingDatasets(current: string) {
  try { return (await managedGeoip(current)).manifest.datasets; } catch { /* Missing, old, or invalid data requires a validated replacement. */ }
}
const recent = (dataset: GeoipDataset | undefined, now: number) =>
  !!dataset && now - Date.parse(dataset.buildEpoch) <= GEOIP_REFRESH_DAYS * DAY_MS;
const releaseRequest = (role: GeoipRole) => ({ label: "location-data", repository: GEOIP_SOURCES[role].repository,
  match: (name: string) => name === GEOIP_SOURCES[role].asset, maxBytes: MAX_BYTES, timeoutMs: 300_000 });
/**
 * The datasets that setup would download: missing ones, and older builds that have a newer release.
 * Only an older build needs a release request. A failed request lists the download.
 */
export async function geoipPlan(current: string, now = Date.now(), request: typeof fetch = fetch): Promise<GeoipRole[]> {
  const existing = await existingDatasets(current), roles: GeoipRole[] = [];
  for (const role of ["selection", "comparison"] as const) {
    const previous = existing?.[role];
    if (recent(previous, now)) continue;
    const latest = previous && await readRelease(releaseRequest(role), request).then(release => release.tag, () => undefined);
    if (!previous || latest !== previous.release) roles.push(role);
  }
  return roles;
}
/** Stage data with the runtime. Only setup activates this directory. Reuse a recent build or the latest release; refresh an older one. */
type GeoipOptions = { request?: typeof fetch; now?: number; progress?: (message: string) => void };
export async function prepareGeoip(stage: string, current: string, { request = fetch, now = Date.now(), progress = console.error }: GeoipOptions = {}) {
  const target = join(stage, "geoip");
  mkdirSync(target, { mode: 0o700 });
  const existing = await existingDatasets(current);
  const datasets = {} as Record<GeoipRole, GeoipDataset>, status = {} as Record<GeoipRole, GeoipStatus>;
  for (const role of ["selection", "comparison"] as const) {
    const previous = existing?.[role];
    const keep = (result: GeoipStatus) => {
      copyFileSync(geoipFile(current, role), geoipFile(stage, role));
      validateGeoip(geoipFile(stage, role), role, previous!.sha256);
      datasets[role] = previous!; status[role] = result;
    };
    if (recent(previous, now)) { keep("reused"); continue; }
    try {
      // An older build that is still the latest release stays. A source can publish less often than the refresh limit.
      const release = await readRelease(releaseRequest(role), request);
      if (release.tag === previous?.release) { keep("reused"); continue; }
      progress(`Downloading ${GEOIP_SOURCES[role].name} location data…`);
      datasets[role] = await download(stage, role, request, release); status[role] = "downloaded";
    }
    catch (error) {
      // An offline setup keeps validated older data. Preflight reports its age.
      if (!previous) throw error;
      progress(`Kept the existing ${GEOIP_SOURCES[role].name} data: ${(error as Error).message}`);
      keep("kept");
    }
  }
  writeFileSync(join(target, "manifest.json"), JSON.stringify({ version: 2, datasets } satisfies GeoipManifest, null, 2), { mode: 0o600, flag: "wx" });
  return { datasets, status };
}

async function download(stage: string, role: GeoipRole, request: typeof fetch, release: Release): Promise<GeoipDataset> {
  const source = GEOIP_SOURCES[role], file = geoipFile(stage, role);
  const asset = await downloadReleaseAsset(releaseRequest(role), file, request, release);
  const data = validateGeoip(file, role, asset.sha256);
  return { source: source.name, sha256: data.sha256, release: asset.release, acquiredAt: new Date().toISOString(),
    databaseType: data.reader.metadata.databaseType, buildEpoch: data.reader.metadata.buildEpoch.toISOString() };
}
