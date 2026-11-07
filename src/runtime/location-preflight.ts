import { lstatSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, HOME_DIR, UPSTREAM, profile, dir, secret, configurationHash, executable, type Profile, validateProxy } from "../profiles/config.ts";
import { assertRuntimePlugin } from "./runtime-plugin.ts";
import { assertLocationPatches } from "../browser/camofox-adapter.ts";
import { prepareProfileConfiguration } from "../profiles/profile-configuration.ts";
import { hash, fileIdentity, readLocationFile, managedGeoip, locationResult, locationFailure, LocationError,
  readLocationRecord, writeLocationRecord, resolveLocation, preparedLanguage, type LocationRecord, type LocationResult } from "../browser/location.ts";

const digests = new Map<string, { stamp: string; value: string }>();
let checkedIntegration: string | undefined;
function digest(file: string) {
  const stamp = fileIdentity(file), old = digests.get(file);
  if (old?.stamp === stamp) return old.value;
  const value = hash(readLocationFile(file)); digests.set(file, { stamp, value }); return value;
}
export async function locationInputs(p: Profile) {
  if (!p.proxyEnv) return;
  let proxy: string, configuration: string;
  try {
    proxy = secret(p.proxyEnv) || "";
    validateProxy(proxy);
    configuration = configurationHash(p);
  } catch { throw locationFailure("PROXY_CONFIGURATION"); }
  const launcher = join(UPSTREAM, "node_modules/camoufox-js");
  let engine: string, integration: string[];
  try {
    engine = digest(executable());
    integration = ["server.js", "lib/browser-identity.js", "plugins/local-profile/index.js", "node_modules/camoufox-js/dist/locale.js", "node_modules/camoufox-js/dist/ip.js", "node_modules/camoufox-js/dist/utils.js"]
      .map(file => digest(join(UPSTREAM, file)));
    integration.push(digest(join(ROOT, "dist/plugin.js")));
    const identity = hash(integration.join(":"));
    if (checkedIntegration !== identity) {
      assertRuntimePlugin();
      assertLocationPatches(UPSTREAM, launcher);
      checkedIntegration = identity;
    }
  } catch { throw locationFailure("GEOIP_RUNTIME_MISSING"); }
  const data = await managedGeoip(join(HOME_DIR, "runtime"), launcher);
  let directory: ReturnType<typeof lstatSync> | undefined;
  try { directory = lstatSync(dir(p.id)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (directory && !directory.isDirectory()) throw locationFailure("LOCATION_INPUT_CHANGED");
  const inputId = hash(JSON.stringify({ configuration, engine, integration, data: data.sha256,
    directory: directory ? [directory.dev, directory.ino] : null, policy: "country-default-v1", icu: process.versions.icu }));
  return { inputId, engine, proxy, expected: p.expectedIPEnv ? secret(p.expectedIPEnv) || "" : "", data, launcher };
}
export async function profileLocation(p: Profile): Promise<LocationResult> {
  if (!p.proxyEnv) return locationResult("not_applicable");
  try {
    const input = await locationInputs(p), saved = readLocationRecord(dir(p.id));
    if (saved && saved.inputId === input!.inputId) {
      if (saved.result.status === "checking" && Date.now() - Date.parse(saved.result.checkedAt || "") > 35_000) return locationResult("not_checked");
      return saved.result;
    }
    return { ...locationResult("not_checked"), checkedAt: saved?.result.checkedAt ?? null };
  } catch (error) {
    return error instanceof LocationError ? error.location : locationFailure("GEOIP_DATA_INVALID").location;
  }
}
export async function assertLocationCurrent(id: string, inputId: string) {
  try {
    if ((await locationInputs(profile(id)))?.inputId !== inputId) throw Error();
  } catch { throw locationFailure("LOCATION_INPUT_CHANGED"); }
}
/** Caller holds this profile's check lock. Network work never holds global admission. */
export async function checkProfileLocation(id: string, signal?: AbortSignal): Promise<LocationRecord | undefined> {
  const checking = { ...locationResult("checking"), checkedAt: new Date().toISOString(), message: "Checking the proxy connection and location…" };
  const input = await prepareProfileConfiguration(async () => {
    const current = await locationInputs(profile(id));
    if (current) writeLocationRecord(dir(id), { version: 1, inputId: current.inputId, result: checking });
    return current;
  });
  if (!input) return;
  const deadline = AbortSignal.timeout(30_000), abort = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let result = checking;
  let record: LocationRecord;
  try {
    const module = await import(pathToFileURL(join(input.launcher, "dist/ip.js")).href) as { publicIP(proxy: string, options: { signal: AbortSignal }): Promise<string> };
    const ip = await module.publicIP(input.proxy, { signal: abort });
    abort.throwIfAborted();
    result = { ...result, network: "passed" };
    if (input.expected && ip !== input.expected) throw locationFailure("EXPECTED_IP_MISMATCH", result);
    const config = await resolveLocation(input.launcher, input.data.reader, ip);
    abort.throwIfAborted();
    result = { ...result, status: "ready", valid: true, checkedAt: new Date().toISOString(), geoip: "passed", timezone: String(config.timezone), language: preparedLanguage(config),
      message: "Ready to start. Browser verification runs after launch." };
    record = { version: 1, inputId: input.inputId, result, prepared: { ip, config, dataId: input.data.sha256, engineId: input.engine } };
  } catch (error) {
    const code = (error as { code?: string }).code;
    const failure = signal?.aborted ? locationFailure("PREFLIGHT_CANCELLED", result) : deadline.aborted ? locationFailure("PREFLIGHT_TIMEOUT", result)
      : error instanceof LocationError ? locationFailure(error.location.code as Parameters<typeof locationFailure>[0], result)
      : locationFailure(code === "PROXY_AUTHENTICATION" || code === "IP_DETECTION_FAILED" ? code : "PROXY_UNREACHABLE", result);
    failure.location.network = result.network === "passed" ? "passed" : "failed";
    if (failure.location.code === "GEOIP_RESOLUTION_FAILED") failure.location.geoip = "failed";
    record = { version: 1, inputId: input.inputId, result: failure.location };
  }
  await prepareProfileConfiguration(async () => {
    await assertLocationCurrent(id, input.inputId);
    writeLocationRecord(dir(id), record);
  });
  if (record.result.status === "blocked") throw new LocationError(record.result);
  return record;
}
