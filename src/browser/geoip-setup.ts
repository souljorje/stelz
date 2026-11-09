import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { managedGeoip, validateGeoip, hash, type GeoipManifest } from "./location.ts";

const RELEASES = "https://api.github.com/repos/P3TERX/GeoLite.mmdb/releases/latest";
/** Stage data with the runtime. Only setup activates this directory. */
export async function prepareGeoip(stage: string, current: string, request: typeof fetch = fetch) {
  const target = join(stage, "geoip");
  mkdirSync(target, { mode: 0o700 });
  try {
    const data = await managedGeoip(current);
    copyFileSync(join(current, "geoip/GeoLite2-City.mmdb"), join(target, "GeoLite2-City.mmdb"));
    validateGeoip(join(target, "GeoLite2-City.mmdb"), data.sha256);
    writeFileSync(join(target, "manifest.json"), JSON.stringify(data.manifest, null, 2), { mode: 0o600, flag: "wx" });
    return;
  } catch { /* Missing or invalid managed data requires a validated replacement. */ }
  console.error("Preparing location data…");
  const signal = AbortSignal.timeout(120_000);
  const response = await request(RELEASES, { signal, headers: { Accept: "application/vnd.github+json" } });
  if (!response.ok) throw Error("Cannot read the location-data release. Check the connection and run stelz setup again.");
  const release = await response.json() as { tag_name?: string; assets?: { name: string; digest?: string; size: number; browser_download_url: string }[] };
  const asset = release.assets?.find(asset => asset.name === "GeoLite2-City.mmdb");
  if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || "") || !/^[\w.-]+$/.test(release.tag_name || "") ||
    asset.browser_download_url !== `https://github.com/P3TERX/GeoLite.mmdb/releases/download/${release.tag_name}/GeoLite2-City.mmdb` ||
    !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 256 * 1024 * 1024)
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
  const file = join(target, "GeoLite2-City.mmdb");
  writeFileSync(file, bytes, { mode: 0o600 });
  const data = validateGeoip(file, asset.digest!.slice(7));
  const manifest: GeoipManifest = { version: 1, sha256: data.sha256, release: release.tag_name!, acquiredAt: new Date().toISOString(),
    databaseType: data.reader.metadata.databaseType, buildEpoch: data.reader.metadata.buildEpoch.toISOString() };
  writeFileSync(join(target, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
}
