import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { downloadReleaseAsset, readRelease, withReleaseFallback, type Release, type ReleaseAssetRequest } from "./release-asset.ts";
import { managedGeoip, validateGeoip, geoipFile, GEOIP_SOURCES, GEOIP_REFRESH_DAYS,
  type GeoipDataset, type GeoipManifest, type GeoipRole } from "./location.ts";

const MAX_BYTES = 256 * 1024 * 1024, DAY_MS = 86_400_000;
export type GeoipStatus = "reused" | "downloaded" | "kept";
async function existingDatasets(current: string) {
  try { return (await managedGeoip(current)).manifest.datasets; } catch { /* Missing, old, or invalid data requires a validated replacement. */ }
}
const recent = (dataset: GeoipDataset | undefined, now: number) =>
  !!dataset && now - Date.parse(dataset.buildEpoch) <= GEOIP_REFRESH_DAYS * DAY_MS;
function geoipReleases(role: GeoipRole): ReleaseAssetRequest[] {
  const { sources, asset } = GEOIP_SOURCES[role];
  return sources.map(url => ({ url, label: "location-data",
    match: name => name === asset, maxBytes: MAX_BYTES, timeoutMs: 300_000 }));
}
function sameRelease(previous: GeoipDataset, release: Release) {
  return (release.origin === previous.origin && release.tag === previous.release) || release.asset.sha256 === previous.sha256;
}
/**
 * The datasets that setup would download: missing ones, and older builds that have a newer release.
 * Only an older build needs a release request. A failed request lists the download.
 */
export async function geoipPlan(current: string, now = Date.now(), request: typeof fetch = fetch): Promise<GeoipRole[]> {
  const existing = await existingDatasets(current), roles: GeoipRole[] = [];
  for (const role of ["selection", "comparison"] as const) {
    const previous = existing?.[role];
    if (recent(previous, now)) continue;
    const unchanged = previous && await withReleaseFallback(geoipReleases(role), async source =>
      sameRelease(previous, await readRelease(source, request))).catch(() => false);
    if (!unchanged) roles.push(role);
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
      const file = geoipFile(stage, role);
      const downloaded = await withReleaseFallback(geoipReleases(role), async source => {
        const release = await readRelease(source, request);
        if (previous && sameRelease(previous, release)) return;
        progress(`Downloading ${GEOIP_SOURCES[role].name} location data from ${release.origin}…`);
        const asset = await downloadReleaseAsset(source, release, file, request);
        const { reader } = validateGeoip(file, role, asset.sha256);
        return { source: GEOIP_SOURCES[role].name, origin: asset.origin, sha256: asset.sha256,
          release: asset.release, acquiredAt: new Date().toISOString(), databaseType: reader.metadata.databaseType,
          buildEpoch: reader.metadata.buildEpoch.toISOString() };
      });
      if (!downloaded) keep("reused");
      else if (previous && Date.parse(downloaded.buildEpoch) < Date.parse(previous.buildEpoch)) {
        progress(`Kept the existing ${GEOIP_SOURCES[role].name} data because it is newer.`);
        keep("reused");
      } else { datasets[role] = downloaded; status[role] = "downloaded"; }
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
