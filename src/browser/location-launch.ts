import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hash, readLocationFile, managedGeoip, validateLocationConfig, locationsMatch, resolveLocation, locationEvidence, assertCredibleLocation,
  locationFailure, LocationError, checkBrowserLocation, writeLocationRecord, type LocationRecord, type LocationResult } from "./location.ts";
import { readLaunchConfig, type LaunchOptions, type Fingerprint } from "./fingerprint.ts";
import { fingerprintModel, isPreparedModel, launcher, pairedBrowser } from "./camoufox.ts";

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
/**
 * Return the engine major version. Stelz supports only the paired build. macOS bundles keep application.ini under Resources.
 * `advice` replaces the general instruction when the caller knows where the executable comes from.
 */
export function engineVersion(executable: string, advice?: string) {
  const paired = pairedBrowser();
  for (const file of [join(dirname(executable), "application.ini"), join(dirname(executable), "../Resources/application.ini")]) {
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    const version = /^Version=(.+)$/m.exec(text)?.[1]?.trim();
    if (!version) continue;
    if (version !== paired) throw Error(`Camoufox ${version} at ${executable} is not supported. Stelz requires Camoufox ${paired}. ` + (advice ??
      "Run stelz setup to prepare it. If CAMOUFOX_EXECUTABLE is set in the process environment or STELZ_HOME/secrets.env, remove it or point it to that build."));
    return version.split(".")[0]!;
  }
  throw Error(`Cannot read the Camoufox version at ${executable}. ` + (advice ?? `Run stelz setup to prepare Camoufox ${paired}. ` +
    "If CAMOUFOX_EXECUTABLE is set, remove it or point it to a complete installation of that build."));
}
/** Launch uses prepared files only. A missing prerequisite fails instead of downloading. */
async function launcherOptions(options: Record<string, unknown>) {
  const executable = process.env.STELZ_CAMOUFOX_EXECUTABLE, model = process.env.CAMOUFOX_FPGEN_DATA;
  if (!executable || !model || !isPreparedModel(model)) throw Error("Browser prerequisites are missing. Run stelz setup.");
  const version = engineVersion(executable);
  // Import the launcher first: its paths module sets a model directory during initialization.
  launcher();
  fingerprintModel().setModelDir(model);
  // On macOS the launcher reads the version of its active cache install, not of this bundle, so Stelz passes it.
  // The flag silences the launcher's warnings about that version and the location config. Stelz validates both.
  return { ...options, executable_path: executable, ff_version: version, i_know_what_im_doing: true };
}
export async function prepareProfileLaunch(options: Record<string, unknown>, prepare: (options: Record<string, unknown>) => Promise<unknown>) {
  // Runtime geometry admission supports macOS only. Reject before upstream can create Linux home/cache files.
  if (process.platform !== "darwin") throw Error("Browser Start requires macOS. This platform has no supported startup geometry contract.");
  // Desktop window and screen bounds. A proxied browser never leaks its real address through WebRTC.
  // The canonical placeholder mode avoids an unowned browser launch to probe the host GPU.
  options = { ...options, canvas_noise: true, window: [1200, 800], screen: { minWidth: 1280, minHeight: 900, maxWidth: 1920, maxHeight: 1200 },
    block_webrtc: !!options.proxy, config: { showcursor: true, ...options.config as Fingerprint | undefined } };
  if (!process.env.PROXY_HOST) return prepare(await launcherOptions(options));
  let record: LocationRecord | undefined;
  try {
    record = launchLocation()!;
    const prepared = record.prepared!;
    const data = await managedGeoip(process.env.STELZ_RUNTIME!);
    if (data.sha256 !== prepared.dataId || hash(readLocationFile(process.env.STELZ_CAMOUFOX_EXECUTABLE!)) !== prepared.engineId || !options.proxy)
      throw locationFailure("LOCATION_INPUT_CHANGED");
    // Location comes from the preflight, so the launcher must not look up the IP again.
    // The pinned browser can retain the host zone from CAMOU_CONFIG alone.
    // Playwright applies this native context option before the first page.
    return await prepare({ ...await launcherOptions(options), geoip: false,
      config: { ...options.config as Fingerprint | undefined, ...prepared.config }, timezoneId: prepared.config.timezone });
  } catch (error) {
    const failure = error instanceof LocationError ? error : locationFailure("LOCATION_PREPARATION_FAILED", record?.result);
    if (record) saveLaunchLocation(record, failure.location);
    // Prewarm must not leave a failed server available for a replacement launch.
    setTimeout(() => process.kill(process.pid, "SIGTERM"), 20).unref();
    throw failure;
  }
}
export function checkLaunchLocation(options: LaunchOptions, record: LocationRecord) {
  const config = readLaunchConfig(options);
  if (!config || !locationsMatch(record.prepared!.config, config)) throw locationFailure("BROWSER_LOCATION_MISMATCH", record.result);
}
export type LocationPage = { evaluate<T>(callback: () => T): Promise<T>; url(): string };
export async function verifyLaunchLocation(record: LocationRecord, ip: string, page: LocationPage) {
  const prepared = record.prepared!;
  let evidence = record.result.evidence;
  if (ip !== prepared.ip) {
    const data = await managedGeoip(process.env.STELZ_RUNTIME!);
    if (data.sha256 !== prepared.dataId || !locationsMatch(prepared.config, resolveLocation(data.reader, ip)))
      throw locationFailure("BROWSER_LOCATION_MISMATCH");
    // A rotated exit needs its own evidence. Staleness is a setup matter, so only a conflict blocks here.
    evidence = locationEvidence(data, ip, prepared.config);
    assertCredibleLocation({ ...evidence, stale: false }, prepared.policy ?? "warn", record.result);
  }
  const observed = await page.evaluate(() => ({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: Intl.DateTimeFormat().resolvedOptions().locale, language: navigator.language, languages: [...navigator.languages] }));
  checkBrowserLocation(prepared.config, observed);
  return { observed, evidence };
}
