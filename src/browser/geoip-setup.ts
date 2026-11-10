import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { managedGeoip, validateGeoip, hash, geoipFile, GEOIP_SOURCES, GEOIP_REFRESH_DAYS,
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
  const source = GEOIP_SOURCES[role];
  console.error(`Preparing ${source.name} location data…`);
  const signal = AbortSignal.timeout(300_000);
  const response = await request(`https://api.github.com/repos/${source.repository}/releases/latest`, { signal, headers: { Accept: "application/vnd.github+json" } });
  if (!response.ok) throw Error("Cannot read the location-data release. Check the connection and run stelz setup again.");
  const release = await response.json() as { tag_name?: string; assets?: { name: string; digest?: string; size: number; browser_download_url: string }[] };
  const asset = release.assets?.find(asset => asset.name === source.asset);
  if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || "") || !/^[\w.-]+$/.test(release.tag_name || "") ||
    asset.browser_download_url !== `https://github.com/${source.repository}/releases/download/${release.tag_name}/${source.asset}` ||
    !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_BYTES)
    throw Error("The location-data release has no valid integrity metadata. Run stelz setup again after the release is available.");
  const downloaded = await request(asset.browser_download_url, { signal });
  if (!downloaded.ok || !downloaded.body) throw Error("Cannot download location data. Check the connection and run stelz setup again.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of downloaded.body) {
    signal.throwIfAborted();
    length += chunk.length;
    if (length > asset.size) throw Error("The location-data download exceeds its release size.");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (length !== asset.size || hash(bytes) !== asset.digest!.slice(7)) throw Error("Location-data integrity check failed. Run stelz setup again.");
  const file = geoipFile(stage, role);
  writeFileSync(file, bytes, { mode: 0o600 });
  const data = validateGeoip(file, role, asset.digest!.slice(7));
  return { source: source.name, sha256: data.sha256, release: release.tag_name!, acquiredAt: new Date().toISOString(),
    databaseType: data.reader.metadata.databaseType, buildEpoch: data.reader.metadata.buildEpoch.toISOString() };
}
