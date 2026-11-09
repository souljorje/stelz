import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readFileSync, lstatSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import { join, dirname } from "node:path";
import { applyProxyLocale, type Fingerprint } from "./fingerprint.ts";

export type LocationStatus = "not_applicable" | "not_checked" | "checking" | "ready" | "blocked";
export type LocationResult = {
  phase: "preflight" | "browser_verification"; status: LocationStatus; code: string | null;
  message: string; nextAction: { kind: "run_setup" | "edit_proxy" | "check_again"; command?: string } | null;
  checkedAt: string | null; valid: boolean; browserStarted: boolean;
  timezone?: string; language?: string;
  network: "not_checked" | "passed" | "failed";
  geoip: "not_checked" | "passed" | "failed";
  browser: "not_checked" | "passed" | "failed";
  geolocation?: "configured";
  observed?: { timezone: string; locale: string; language: string; languages: string[] };
};
export type PreparedLocation = { ip: string; config: Fingerprint; dataId: string; engineId: string };
export type LocationRecord = { version: 1; inputId: string; result: LocationResult; prepared?: PreparedLocation; attemptId?: string };
export class LocationError extends Error {
  readonly status = 409;
  constructor(public readonly location: LocationResult) { super(location.message); }
}
export function locationResult(status: LocationStatus): LocationResult {
  return { phase: "preflight", status, code: null, message: status === "not_applicable"
    ? "Automatic location alignment does not apply to direct profiles."
    : "Check the connection before starting, or use Start to check it automatically.",
  nextAction: null, checkedAt: null, valid: status === "not_applicable", browserStarted: false,
  network: "not_checked", geoip: "not_checked", browser: "not_checked" };
}
const failures = {
  GEOIP_DATA_MISSING: ["Location data is missing. Run stelz setup, then check again.", "run_setup"],
  GEOIP_DATA_INVALID: ["Location data is damaged. Run stelz setup, then check again.", "run_setup"],
  GEOIP_DATA_INCOMPATIBLE: ["Location data is incompatible with Stelz. Run stelz setup, then check again.", "run_setup"],
  GEOIP_RUNTIME_MISSING: ["The location runtime is unavailable. Run stelz setup, then check again.", "run_setup"],
  LOCATION_PREPARATION_FAILED: ["Browser location settings could not be prepared. Run stelz setup, then check again.", "run_setup"],
  PROXY_CONFIGURATION: ["The proxy configuration is missing or invalid. Edit the proxy, then check again.", "edit_proxy"],
  PROXY_AUTHENTICATION: ["The proxy rejected its credentials. Edit the proxy credentials, then check again.", "edit_proxy"],
  PROXY_UNREACHABLE: ["Stelz cannot connect through this proxy. Check the proxy connection, then check again.", "edit_proxy"],
  IP_DETECTION_FAILED: ["The IP services did not return a valid exit address. Check the connection again.", "check_again"],
  EXPECTED_IP_MISMATCH: ["The exit IP does not match the configured expected IP. Check the proxy and expected IP.", "edit_proxy"],
  GEOIP_RESOLUTION_FAILED: ["The exit IP has no complete location data. Check the proxy exit, then check again.", "edit_proxy"],
  PREFLIGHT_TIMEOUT: ["The connection check exceeded its time limit. Check the proxy, then check again.", "check_again"],
  PREFLIGHT_CANCELLED: ["The connection check was cancelled. Check again before starting.", "check_again"],
  LOCATION_INPUT_CHANGED: ["The profile or location data changed during the check. Check again before starting.", "check_again"],
  BROWSER_LOCATION_MISMATCH: ["The browser location does not match its prepared settings. Check the connection, then start again.", "check_again"],
  BROWSER_IP_FAILED: ["The browser exit IP check failed. Check the proxy connection, then start again.", "check_again"],
} as const;
export type LocationCode = keyof typeof failures;
export function locationFailure(code: LocationCode, previous = locationResult("not_checked")): LocationError {
  const [message, kind] = failures[code];
  return new LocationError({ ...previous, status: "blocked", valid: true, code, message,
    checkedAt: new Date().toISOString(), nextAction: { kind, ...(kind === "run_setup" ? { command: "stelz setup" } : {}) } });
}
export const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** State and managed data must be ordinary private files, never links. */
export function readLocationFile(file: string): Buffer {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1) throw Error("Invalid location file.");
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
export function writeLocationRecord(directory: string, value: LocationRecord) {
  if (!lstatSync(directory).isDirectory()) throw Error("Invalid profile directory.");
  const file = join(directory, "location.json"), temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  renameSync(temp, file);
}
export function readLocationRecord(directory: string): LocationRecord | undefined {
  try {
    const raw = readLocationFile(join(directory, "location.json"));
    if (raw.length > 32768) return;
    const value = JSON.parse(raw.toString()) as LocationRecord;
    if (value.version !== 1 || typeof value.inputId !== "string" || !value.result || !["preflight", "browser_verification"].includes(value.result.phase)) return;
    return value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return; throw error; }
}

type Reader = { metadata: { databaseType: string; binaryFormatMajorVersion: number; ipVersion: number; buildEpoch: Date }; get(ip: string): unknown };
type GeoipRecord = { country?: { iso_code?: string }; location?: { latitude?: number; longitude?: number; time_zone?: string } } | null;
export function countryLocale(country: string) {
  const result = applyProxyLocale({ "locale:region": country }, true);
  if (typeof result["locale:language"] !== "string") throw locationFailure("GEOIP_RESOLUTION_FAILED");
  return result;
}
/** Map an exit IP to location fields. The country selects its default language. */
export function resolveLocation(reader: Reader, ip: string) {
  try {
    if (!isIP(ip)) throw Error();
    const record = reader.get(ip) as GeoipRecord, country = record?.country?.iso_code?.toUpperCase(), location = record?.location;
    if (!country || !location?.time_zone) throw Error();
    const config: Fingerprint = { "geolocation:longitude": location.longitude, "geolocation:latitude": location.latitude,
      timezone: location.time_zone, ...countryLocale(country) };
    validateLocationConfig(config);
    return config;
  } catch { throw locationFailure("GEOIP_RESOLUTION_FAILED"); }
}
export function validateLocationConfig(config: Fingerprint) {
  const lat = config["geolocation:latitude"], lon = config["geolocation:longitude"];
  if (typeof lat !== "number" || !Number.isFinite(lat) || Math.abs(lat) > 90 || typeof lon !== "number" || !Number.isFinite(lon) || Math.abs(lon) > 180 ||
    typeof config.timezone !== "string" || typeof config["locale:language"] !== "string" || typeof config["locale:region"] !== "string") throw locationFailure("GEOIP_RESOLUTION_FAILED");
  new Intl.DateTimeFormat("en", { timeZone: config.timezone });
  new Intl.Locale(`${config["locale:language"]}-${config["locale:region"]}`);
}
export type GeoipManifest = { version: 1; sha256: string; release: string; acquiredAt: string; databaseType: string; buildEpoch: string };
export type GeoipData = { reader: Reader; sha256: string; manifest: GeoipManifest };
const datasets = new Map<string, { stamp: string; pending: Promise<GeoipData> }>();
export function fileIdentity(file: string) {
  const s = lstatSync(file);
  if (!s.isFile() || s.nlink !== 1) throw Error("Invalid location file.");
  return [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(":");
}
export function validateGeoip(file: string, expectedHash?: string): { reader: Reader; sha256: string } {
  let bytes: Buffer;
  try { bytes = readLocationFile(file); }
  catch (error) { throw locationFailure((error as NodeJS.ErrnoException).code === "ENOENT" ? "GEOIP_DATA_MISSING" : "GEOIP_DATA_INVALID"); }
  const sha256 = hash(bytes);
  if (expectedHash && expectedHash !== sha256) throw locationFailure("GEOIP_DATA_INVALID");
  let reader: Reader;
  try {
    // Load the reader only when location data is used.
    const { Reader } = createRequire(import.meta.url)("maxmind") as { Reader: new(bytes: Buffer) => Reader };
    reader = new Reader(bytes);
  } catch { throw locationFailure("GEOIP_DATA_INVALID"); }
  const meta = reader.metadata;
  if (meta.databaseType !== "GeoLite2-City" || meta.binaryFormatMajorVersion !== 2 || meta.ipVersion !== 6) throw locationFailure("GEOIP_DATA_INCOMPATIBLE");
  try {
    for (const ip of ["8.8.8.8", "2001:4860:4860::8888"]) resolveLocation(reader, ip);
  } catch { throw locationFailure("GEOIP_DATA_INVALID"); }
  return { reader, sha256 };
}
export async function managedGeoip(runtime: string): Promise<GeoipData> {
  const file = join(runtime, "geoip/GeoLite2-City.mmdb"), manifestPath = join(dirname(file), "manifest.json");
  let stamp: string;
  try {
    if (!lstatSync(runtime).isDirectory()) throw Error();
    if (!lstatSync(dirname(file)).isDirectory()) throw Error();
    stamp = `${fileIdentity(file)}:${fileIdentity(manifestPath)}`;
  } catch (error) { throw locationFailure((error as NodeJS.ErrnoException).code === "ENOENT" ? "GEOIP_DATA_MISSING" : "GEOIP_DATA_INVALID"); }
  const cached = datasets.get(file);
  if (cached?.stamp === stamp) return cached.pending;
  const pending = (async () => {
    let manifest: GeoipManifest;
    try {
      manifest = JSON.parse(readLocationFile(manifestPath).toString());
      if (manifest.version !== 1 || !/^[a-f0-9]{64}$/.test(manifest.sha256) || !Number.isFinite(Date.parse(manifest.acquiredAt))) throw Error();
    } catch { throw locationFailure("GEOIP_DATA_INVALID"); }
    return { ...validateGeoip(file, manifest.sha256), manifest };
  })();
  datasets.set(file, { stamp, pending });
  return pending;
}

export function normalizedLocale(value: string) { return new Intl.Locale(value).maximize().baseName; }
function normalizedZone(value: string) {
  // Newer Intl implementations retain these IANA aliases in resolvedOptions.
  const aliases: Record<string, string> = { "US/Eastern": "America/New_York", "US/Central": "America/Chicago",
    "US/Mountain": "America/Denver", "US/Pacific": "America/Los_Angeles", "US/Arizona": "America/Phoenix",
    "US/Alaska": "America/Anchorage", "US/Hawaii": "Pacific/Honolulu", "Asia/Calcutta": "Asia/Kolkata",
    "Europe/Kiev": "Europe/Kyiv", "GMT": "UTC", "Etc/GMT": "UTC", "Etc/UTC": "UTC" };
  const zone = new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone;
  return aliases[zone] || zone;
}
export function preparedLanguage(config: Fingerprint) {
  return [config["locale:language"], config["locale:script"], config["locale:region"]].filter(Boolean).join("-");
}
export function locationsMatch(a: Fingerprint, b: Fingerprint) {
  return normalizedZone(String(a.timezone)) === normalizedZone(String(b.timezone)) &&
    normalizedLocale(preparedLanguage(a)) === normalizedLocale(preparedLanguage(b)) &&
    ["geolocation:latitude", "geolocation:longitude", "geolocation:accuracy", "locale:all"].every(key => a[key] === b[key]);
}
export function checkBrowserLocation(config: Fingerprint, observed: { timezone: string; locale: string; language: string; languages: string[] }) {
  const mismatch = () => new LocationError({ ...locationFailure("BROWSER_LOCATION_MISMATCH").location, observed });
  try {
  const expected = normalizedLocale(preparedLanguage(config));
  if (normalizedZone(observed.timezone) !== normalizedZone(String(config.timezone)) || ![observed.locale, observed.language, observed.languages[0]].every(value => value && normalizedLocale(value) === expected))
    throw mismatch();
  const explicit = config["locale:all"];
  if (typeof explicit === "string" && JSON.stringify(explicit.split(",").map(v => normalizedLocale(v.trim()))) !== JSON.stringify(observed.languages.map(normalizedLocale)))
    throw mismatch();
  if (!explicit && observed.languages.some(value => normalizedLocale(value) !== expected &&
    new Intl.Locale(value).baseName !== new Intl.Locale(preparedLanguage(config)).language)) throw mismatch();
  } catch { throw mismatch(); }
}
