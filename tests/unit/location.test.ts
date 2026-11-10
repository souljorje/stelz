import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { geoipFixture, managedFixture, fixtureLocation } from "../helpers/geoip-fixture.ts";
import { validateGeoip, managedGeoip, resolveLocation, countryLocale, checkBrowserLocation, locationsMatch, hash,
  GEOIP_SOURCES, locationEvidence, parseLocationPolicy, type GeoipRole } from "../../src/browser/location.ts";
import { prepareGeoip } from "../../src/browser/geoip-setup.ts";
import { verifyLaunchLocation } from "../../src/browser/location-launch.ts";
import { locationResult, type LocationRecord } from "../../src/browser/location.ts";

const homes: string[] = [];
const temp = () => { const home = mkdtempSync(join(tmpdir(), "stelz-location-")); homes.push(home); return home; };
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function thrown(work: () => unknown) { try { work(); } catch (error) { return (error as { location?: unknown }).location; } }

test("the actual reader and resolver accept IPv4, IPv6, and zero coordinates", async () => {
  const home = temp(); managedFixture(home);
  const data = await managedGeoip(home);
  for (const ip of ["8.8.8.8", "2001:4860:4860::8888"]) expect(resolveLocation(data.reader, ip)).toEqual({
    timezone: "Europe/London", "geolocation:longitude": 0, "geolocation:latitude": 0, "locale:language": "en", "locale:region": "GB" });
});
test("missing, corrupt, incompatible and incomplete databases are distinct blockers", async () => {
  const home = temp(), file = join(home, "db");
  expect(thrown(() => validateGeoip(file, "comparison"))).toMatchObject({ code: "GEOIP_DATA_MISSING", nextAction: { kind: "run_setup" }, browserStarted: false });
  writeFileSync(file, "broken");
  expect(thrown(() => validateGeoip(file, "comparison"))).toMatchObject({ code: "GEOIP_DATA_INVALID" });
  writeFileSync(file, geoipFixture(undefined, "GeoLite2-Country"));
  expect(thrown(() => validateGeoip(file, "comparison"))).toMatchObject({ code: "GEOIP_DATA_INCOMPATIBLE" });
  // Each role requires its own database type.
  writeFileSync(file, geoipFixture());
  expect(thrown(() => validateGeoip(file, "selection"))).toMatchObject({ code: "GEOIP_DATA_INCOMPATIBLE" });
  writeFileSync(file, geoipFixture({ longitude: 0, latitude: 0 }));
  expect(thrown(() => validateGeoip(file, "comparison"))).toMatchObject({ code: "GEOIP_DATA_INVALID" });
});
test("cached readers invalidate after corruption and policy follows the configured country default", async () => {
  const home = temp(); managedFixture(home); await managedGeoip(home);
  writeFileSync(join(home, "geoip/GeoLite2-City.mmdb"), "broken");
  await expect(managedGeoip(home)).rejects.toMatchObject({ location: { code: "GEOIP_DATA_INVALID" } });
  expect(countryLocale("GE")["locale:language"]).toBe("ka");
});
test("browser observations require compatible timezone, locale and navigator language", () => {
  const config = { timezone: "US/Eastern", "locale:language": "en", "locale:region": "US", "geolocation:latitude": 0, "geolocation:longitude": 0 };
  checkBrowserLocation(config, { timezone: "America/New_York", locale: "en-US", language: "en-Latn-US", languages: ["en-US"] });
  expect(() => checkBrowserLocation(config, { timezone: "Europe/London", locale: "en-US", language: "en-US", languages: ["en-US"] })).toThrow();
  expect(() => checkBrowserLocation(config, { timezone: "US/Eastern", locale: "fr-FR", language: "en-US", languages: ["en-US"] })).toThrow();
  expect(() => checkBrowserLocation(config, { timezone: "US/Eastern", locale: "en-US", language: "en-US", languages: ["en-US", "fr"] })).toThrow();
  expect(locationsMatch(config, { ...config, timezone: "America/New_York" })).toBe(true);
  expect(locationsMatch(config, { ...config, "geolocation:latitude": 1 })).toBe(false);
});
test("setup reuses a recent build without a request and keeps older data when offline", async () => {
  for (const [build, requests] of [[new Date().toISOString(), 0], ["2023-11-14T22:13:20.000Z", 2]] as const) {
    const current = temp(), stage = temp(); managedFixture(current, undefined, undefined, build); let calls = 0;
    const original = readFileSync(join(current, "geoip/manifest.json"), "utf8");
    await prepareGeoip(stage, current, (() => { calls++; throw Error("offline"); }) as unknown as typeof fetch);
    expect(JSON.parse(readFileSync(join(stage, "geoip/manifest.json"), "utf8"))).toEqual(JSON.parse(original));
    expect(calls).toBe(requests);
  }
});
test("setup validates release integrity for both datasets before retaining them", async () => {
  const current = temp(), bytes = { selection: geoipFixture(undefined, "GeoIP2-City"), comparison: geoipFixture() };
  const request = (digests: Partial<Record<GeoipRole, string>> = {}) => (async (url: string) => {
    for (const role of ["selection", "comparison"] as const) {
      const { repository, asset } = GEOIP_SOURCES[role];
      if (url === `https://api.github.com/repos/${repository}/releases/latest`) return Response.json({ tag_name: "test", assets: [{ name: asset,
        digest: `sha256:${digests[role] ?? hash(bytes[role])}`, size: bytes[role].length, browser_download_url: `https://github.com/${repository}/releases/download/test/${asset}` }] });
      if (url === `https://github.com/${repository}/releases/download/test/${asset}`) return new Response(bytes[role]);
    }
    throw Error("Unexpected request");
  }) as unknown as typeof fetch;
  const stage = temp(); await prepareGeoip(stage, current, request());
  expect((await managedGeoip(stage)).sha256).toBe(hash(`${hash(bytes.selection)}:${hash(bytes.comparison)}`));
  await expect(prepareGeoip(temp(), current, request({ comparison: "0".repeat(64) }))).rejects.toThrow("integrity");
});
test("location evidence separates corroborated, uncorroborated, conflicting, and stale data", async () => {
  const now = Date.parse("2026-11-10T00:00:00Z"), london = { latitude: 0, longitude: 0, time_zone: "Europe/London" };
  const evidence = async (comparison: Buffer, build = "2026-11-04T00:00:00.000Z") => {
    const home = temp(); managedFixture(home, undefined, comparison, build);
    return locationEvidence(await managedGeoip(home), "8.8.8.8", { timezone: "Europe/London" }, now);
  };
  expect(await evidence(geoipFixture({ ...london, accuracy_radius: 20 }))).toMatchObject({ source: "GeoIP AIO", ageDays: 6, stale: false,
    comparison: { source: "GeoLite2 City", result: "corroborated", accuracyRadiusKm: 20, city: false } });
  // Zones with the same January and July offsets agree.
  expect((await evidence(geoipFixture({ ...london, time_zone: "Europe/Lisbon", accuracy_radius: 50 }))).comparison.result).toBe("corroborated");
  expect((await evidence(geoipFixture({ ...london, time_zone: "Asia/Tokyo" }, "GeoLite2-City", { city: { geoname_id: 1 } }))).comparison)
    .toMatchObject({ result: "conflicting", timezone: "Asia/Tokyo", city: true });
  // A broad or metadata-free comparison neither confirms nor contradicts the selection.
  expect((await evidence(geoipFixture({ ...london, time_zone: "America/Chicago", accuracy_radius: 1000 }))).comparison.result).toBe("uncorroborated");
  expect((await evidence(geoipFixture({ ...london, time_zone: "Asia/Tokyo" }))).comparison.result).toBe("uncorroborated");
  expect(await evidence(geoipFixture(), "2026-09-01T00:00:00.000Z")).toMatchObject({ ageDays: 70, stale: true });
  expect(parseLocationPolicy()).toBe("warn"); expect(parseLocationPolicy("strict")).toBe("strict");
  expect(thrown(() => parseLocationPolicy(""))).toMatchObject({ code: "LOCATION_POLICY_INVALID" });
});
test("the resolver reports null or incomplete locations as resolution failures", () => {
  for (const value of [null, {}, { country: { iso_code: "GB" }, location: { latitude: 0, longitude: 0 } }])
    expect(thrown(() => resolveLocation({ get: () => value } as unknown as Parameters<typeof resolveLocation>[0], "8.8.8.8"))).toMatchObject({ code: "GEOIP_RESOLUTION_FAILED" });
});

test("a rotated browser exit must resolve to compatible settings and gets its own evidence", async () => {
  const home = temp(), upstream = fixtureLocation(home);
  // The comparison database contradicts the selection at city precision.
  managedFixture(join(home, "runtime"), undefined, geoipFixture({ latitude: 0, longitude: 0, time_zone: "Asia/Tokyo" }, "GeoLite2-City", { city: { geoname_id: 1 } }));
  const data = await managedGeoip(join(home, "runtime"));
  const config = resolveLocation(data.reader, "198.51.100.10");
  const record: LocationRecord = { version: 1, inputId: "fixture", result: locationResult("ready"),
    prepared: { ip: "198.51.100.10", config, dataId: data.sha256, engineId: "fixture" } };
  const previous = { STELZ_HOME: process.env.STELZ_HOME, STELZ_RUNTIME: process.env.STELZ_RUNTIME, STELZ_UPSTREAM: process.env.STELZ_UPSTREAM };
  Object.assign(process.env, { STELZ_HOME: home, STELZ_RUNTIME: join(home, "runtime"), STELZ_UPSTREAM: upstream });
  const page = { url: () => "about:blank", evaluate: async <T>() => ({ timezone: "Europe/London", locale: "en-GB", language: "en-GB", languages: ["en-GB", "en"] }) as T };
  try {
    expect((await verifyLaunchLocation(record, "198.51.100.11", page)).evidence?.comparison.result).toBe("conflicting");
    record.prepared!.policy = "strict";
    await expect(verifyLaunchLocation(record, "198.51.100.11", page)).rejects.toMatchObject({ location: { code: "LOCATION_CONFLICT",
      evidence: { stale: false, comparison: { result: "conflicting", timezone: "Asia/Tokyo" } } } });
    record.prepared!.policy = "warn";
    record.prepared!.config = { ...config, timezone: "America/New_York" };
    await expect(verifyLaunchLocation(record, "198.51.100.11", page)).rejects.toMatchObject({ location: { code: "BROWSER_LOCATION_MISMATCH" } });
  } finally { for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; }
});
