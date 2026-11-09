import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { geoipFixture, managedFixture, fixtureLocation } from "../helpers/geoip-fixture.ts";
import { validateGeoip, managedGeoip, resolveLocation, countryLocale, checkBrowserLocation, locationsMatch, hash } from "../../src/browser/location.ts";
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
  expect(thrown(() => validateGeoip(file))).toMatchObject({ code: "GEOIP_DATA_MISSING", nextAction: { kind: "run_setup" }, browserStarted: false });
  writeFileSync(file, "broken");
  expect(thrown(() => validateGeoip(file))).toMatchObject({ code: "GEOIP_DATA_INVALID" });
  writeFileSync(file, geoipFixture(undefined, "GeoLite2-Country"));
  expect(thrown(() => validateGeoip(file))).toMatchObject({ code: "GEOIP_DATA_INCOMPATIBLE" });
  writeFileSync(file, geoipFixture({ longitude: 0, latitude: 0 }));
  expect(thrown(() => validateGeoip(file))).toMatchObject({ code: "GEOIP_DATA_INVALID" });
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
test("setup reuses validated data offline and preserves its acquisition date", async () => {
  const current = temp(), stage = temp(); managedFixture(current);
  const original = readFileSync(join(current, "geoip/manifest.json"), "utf8");
  await prepareGeoip(stage, current, (() => { throw Error("Unexpected network request"); }) as unknown as typeof fetch);
  expect(JSON.parse(readFileSync(join(stage, "geoip/manifest.json"), "utf8"))).toEqual(JSON.parse(original));
});
test("setup validates release integrity before retaining a staged dataset", async () => {
  const current = temp(), stage = temp(), bytes = geoipFixture(); let calls = 0;
  const request = (async () => ++calls === 1 ? Response.json({ tag_name: "test", assets: [{ name: "GeoLite2-City.mmdb", digest: `sha256:${hash(bytes)}`, size: bytes.length,
    browser_download_url: "https://github.com/P3TERX/GeoLite.mmdb/releases/download/test/GeoLite2-City.mmdb" }] }) : new Response(bytes)) as unknown as typeof fetch;
  await prepareGeoip(stage, current, request);
  expect((await managedGeoip(stage)).sha256).toBe(hash(bytes));
  const failed = temp(); calls = 0;
  await expect(prepareGeoip(failed, current, (async (...args: Parameters<typeof fetch>) => ++calls === 1 ? Response.json({ tag_name: "test", assets: [{ name: "GeoLite2-City.mmdb", digest: `sha256:${"0".repeat(64)}`, size: bytes.length, browser_download_url: "https://github.com/P3TERX/GeoLite.mmdb/releases/download/test/GeoLite2-City.mmdb" }] }) : new Response(bytes)) as typeof fetch)).rejects.toThrow("integrity");
});
test("the resolver reports null or incomplete locations as resolution failures", () => {
  for (const value of [null, {}, { country: { iso_code: "GB" }, location: { latitude: 0, longitude: 0 } }])
    expect(thrown(() => resolveLocation({ get: () => value } as unknown as Parameters<typeof resolveLocation>[0], "8.8.8.8"))).toMatchObject({ code: "GEOIP_RESOLUTION_FAILED" });
});

test("a rotated browser exit must resolve to compatible prepared settings", async () => {
  const home = temp(), upstream = fixtureLocation(home), data = await managedGeoip(join(home, "runtime"));
  const config = resolveLocation(data.reader, "198.51.100.10");
  const record: LocationRecord = { version: 1, inputId: "fixture", result: locationResult("ready"),
    prepared: { ip: "198.51.100.10", config, dataId: data.sha256, engineId: "fixture" } };
  const previous = { STELZ_HOME: process.env.STELZ_HOME, STELZ_UPSTREAM: process.env.STELZ_UPSTREAM };
  Object.assign(process.env, { STELZ_HOME: home, STELZ_UPSTREAM: upstream });
  const page = { url: () => "about:blank", evaluate: async <T>() => ({ timezone: "Europe/London", locale: "en-GB", language: "en-GB", languages: ["en-GB", "en"] }) as T };
  try {
    await verifyLaunchLocation(record, "198.51.100.11", page);
    record.prepared!.config = { ...config, timezone: "America/New_York" };
    await expect(verifyLaunchLocation(record, "198.51.100.11", page)).rejects.toMatchObject({ location: { code: "BROWSER_LOCATION_MISMATCH" } });
  } finally { for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; }
});
