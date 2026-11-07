import { join } from "node:path";
import { hash, readLocationFile, managedGeoip, validateLocationConfig, locationsMatch, resolveLocation,
  locationFailure, LocationError, checkBrowserLocation, writeLocationRecord, type LocationRecord, type LocationResult } from "./location.ts";
import type { LaunchOptions, Fingerprint } from "./fingerprint.ts";

export function launchLocation(): LocationRecord | undefined {
  if (!process.env.PROXY_HOST) return;
  try {
    const value = JSON.parse(process.env.STELZ_LOCATION_LAUNCH || "") as LocationRecord;
    if (!value.prepared || value.version !== 1 || value.result.status !== "ready" || value.attemptId !== process.env.STELZ_START_ID) throw Error();
    validateLocationConfig(value.prepared.config);
    return value;
  } catch { throw locationFailure("LOCATION_INPUT_CHANGED"); }
}
export function saveLaunchLocation(record: LocationRecord, result: LocationResult) {
  writeLocationRecord(process.env.STELZ_PROFILE_DIR!, { ...record, result });
}
export async function prepareProfileLaunch(options: Record<string, unknown>, prepare: (options: Record<string, unknown>) => Promise<unknown>) {
  if (!process.env.PROXY_HOST) return prepare(options);
  let record: LocationRecord | undefined;
  try {
    record = launchLocation()!;
    const prepared = record.prepared!;
    const data = await managedGeoip(join(process.env.STELZ_HOME!, "runtime"), join(process.env.STELZ_UPSTREAM!, "node_modules/camoufox-js"));
    if (data.sha256 !== prepared.dataId || hash(readLocationFile(process.env.CAMOUFOX_EXECUTABLE!)) !== prepared.engineId || !options.proxy)
      throw locationFailure("LOCATION_INPUT_CHANGED");
    // The pinned browser can retain the host zone from CAMOU_CONFIG alone.
    // Playwright applies this native context option before the first page.
    return await prepare({ ...options, geoip: prepared.ip, stelzGeoip: prepared.config, timezoneId: prepared.config.timezone });
  } catch (error) {
    const failure = error instanceof LocationError ? error : locationFailure("LOCATION_PREPARATION_FAILED", record?.result);
    if (record) saveLaunchLocation(record, failure.location);
    // Prewarm must not leave a failed server available for a replacement launch.
    setTimeout(() => process.kill(process.pid, "SIGTERM"), 20).unref();
    throw failure;
  }
}
export function checkLaunchLocation(options: LaunchOptions, record: LocationRecord) {
  const config = JSON.parse(Object.entries(options.env || {}).filter(([key]) => /^CAMOU_CONFIG_[1-9]\d*$/.test(key))
    .sort(([a], [b]) => Number(a.split("_").at(-1)) - Number(b.split("_").at(-1))).map(([, value]) => value).join("")) as Fingerprint;
  if (!locationsMatch(record.prepared!.config, config)) throw locationFailure("BROWSER_LOCATION_MISMATCH", record.result);
}
export type LocationPage = { evaluate<T>(callback: () => T): Promise<T>; url(): string };
export async function verifyLaunchLocation(record: LocationRecord, ip: string, page: LocationPage) {
  const prepared = record.prepared!;
  if (ip !== prepared.ip) {
    const launcher = join(process.env.STELZ_UPSTREAM!, "node_modules/camoufox-js");
    const data = await managedGeoip(join(process.env.STELZ_HOME!, "runtime"), launcher);
    if (data.sha256 !== prepared.dataId || !locationsMatch(prepared.config, await resolveLocation(launcher, data.reader, ip)))
      throw locationFailure("BROWSER_LOCATION_MISMATCH");
  }
  const observed = await page.evaluate(() => ({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: Intl.DateTimeFormat().resolvedOptions().locale, language: navigator.language, languages: [...navigator.languages] }));
  checkBrowserLocation(prepared.config, observed);
  return observed;
}
