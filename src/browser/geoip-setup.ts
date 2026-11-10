import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { downloadReleaseAsset } from "./release-asset.ts";
import { managedGeoip, validateGeoip, geoipFile, GEOIP_SOURCES, GEOIP_REFRESH_DAYS,
  type GeoipDataset, type GeoipManifest, type GeoipRole } from "./location.ts";

const MAX_BYTES = 256 * 1024 * 1024, DAY_MS = 86_400_000;
/** Stage data with the runtime. Only setup activates this directory. Reuse a recent build; refresh an older one. */
export async function prepareGeoip(stage: string, current: string, request: typeof fetch = fetch, now = Date.now()) {
  const target = join(stage, "geoip");
  mkdirSync(target, { mode: 0o700 });
  let existing: GeoipManifest | undefined;
  try { existing = (await managedGeoip(current)).manifest; } catch { /* Missing, old, or invalid data requires a validated replacement. */ }
  const datasets = {} as Record<GeoipRole, GeoipDataset>;
  for (const role of ["selection", "comparison"] as const) {
    const previous = existing?.datasets[role];
    const keep = () => {
      copyFileSync(geoipFile(current, role), geoipFile(stage, role));
      validateGeoip(geoipFile(stage, role), role, previous!.sha256);
      datasets[role] = previous!;
    };
    if (previous && now - Date.parse(previous.buildEpoch) <= GEOIP_REFRESH_DAYS * DAY_MS) { keep(); continue; }
    try { datasets[role] = await download(stage, role, request); }
    catch (error) {
      // An offline setup keeps validated older data. Preflight reports its age.
      if (!previous) throw error;
      console.error(`Kept the existing ${GEOIP_SOURCES[role].name} data: ${(error as Error).message}`);
      keep();
    }
  }
  writeFileSync(join(target, "manifest.json"), JSON.stringify({ version: 2, datasets } satisfies GeoipManifest, null, 2), { mode: 0o600, flag: "wx" });
}

async function download(stage: string, role: GeoipRole, request: typeof fetch): Promise<GeoipDataset> {
  const source = GEOIP_SOURCES[role], file = geoipFile(stage, role);
  console.error(`Preparing ${source.name} location data…`);
  const asset = await downloadReleaseAsset({ label: "location-data", repository: source.repository, match: name => name === source.asset,
    maxBytes: MAX_BYTES, timeoutMs: 300_000 }, file, request);
  const data = validateGeoip(file, role, asset.sha256);
  return { source: source.name, sha256: data.sha256, release: asset.release, acquiredAt: new Date().toISOString(),
    databaseType: data.reader.metadata.databaseType, buildEpoch: data.reader.metadata.buildEpoch.toISOString() };
}
