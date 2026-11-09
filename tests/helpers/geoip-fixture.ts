import { mkdirSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { fingerprintModel } from "../../src/browser/camoufox.ts";
import { hash } from "../../src/browser/location.ts";
import { UPSTREAM_VERSION } from "../../src/versions.ts";

// Minimal real MMDB: one node maps every IP to the same synthetic location.
// It exercises the pinned reader without downloading production data in unit tests.
export function geoipFixture(location: Record<string, unknown> = { longitude: 0, latitude: 0, time_zone: "Europe/London" }, databaseType = "GeoLite2-City") {
  function encode(value: unknown): Buffer {
    if (typeof value === "string") {
      const bytes = Buffer.from(value); if (bytes.length > 28) throw Error("Fixture string is too long");
      return Buffer.concat([Buffer.from([64 + bytes.length]), bytes]);
    }
    if (typeof value === "number") {
      const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return Buffer.concat([Buffer.from([196]), bytes]);
    }
    if (Array.isArray(value)) return Buffer.concat([Buffer.from([value.length, 4]), ...value.map(encode)]);
    const entries = Object.entries(value as object);
    return Buffer.concat([Buffer.from([224 + entries.length]), ...entries.flatMap(([key, field]) => [encode(key), encode(field)])]);
  }
  const record = encode({ country: { iso_code: "GB" }, location });
  const metadata = encode({ node_count: 1, record_size: 24, ip_version: 6, database_type: databaseType,
    languages: ["en"], binary_format_major_version: 2, binary_format_minor_version: 0, build_epoch: 1700000000, description: { en: "Synthetic test data" } });
  return Buffer.concat([Buffer.from([0, 0, 17, 0, 0, 17]), Buffer.alloc(16), record, Buffer.from([171, 205, 239]), Buffer.from("MaxMind.com"), metadata]);
}
export function managedFixture(runtime: string, bytes = geoipFixture()) {
  const geoip = join(runtime, "geoip"); mkdirSync(geoip, { recursive: true });
  writeFileSync(join(geoip, "GeoLite2-City.mmdb"), bytes, { mode: 0o600 });
  writeFileSync(join(geoip, "manifest.json"), JSON.stringify({ version: 1, sha256: hash(bytes), release: "fixture",
    acquiredAt: "2026-11-07T00:00:00Z", databaseType: "GeoLite2-City", buildEpoch: "2023-11-14T22:13:20.000Z" }), { mode: 0o600 });
}
/** Prepare location data and patched Camofox markers. A mock package also gets a fixed exit-IP check. */
export function fixtureLocation(home: string, packageRoot?: string, ipCode = 'return "198.51.100.10";') {
  const upstream = join(home, "runtime", `camofox-${UPSTREAM_VERSION}`);
  mkdirSync(join(upstream, "lib"), { recursive: true });
  writeFileSync(join(upstream, "lib/browser-identity.js"), "// if (hasProxy) return {}; // Stelz never grants location access to arbitrary sites.");
  if (existsSync(join(upstream, "server.js"))) appendFileSync(join(upstream, "server.js"), "\n// Simulated server: const prepared = await (await import('./plugins/local-profile/index.js')).prepareProfileLaunch(baseOptions,\n");
  if (packageRoot) writeFileSync(join(packageRoot, "src/runtime/public-ip.ts"),
    `export async function publicIP(proxy: string, signal: AbortSignal): Promise<string> { ${ipCode} }`);
  managedFixture(join(home, "runtime"));
  return upstream;
}
/** Prepare model readiness metadata without loading a real fingerprint generator. */
export function fixtureModel(directory: string) {
  mkdirSync(directory, { recursive: true });
  const { MODEL_PIN } = fingerprintModel();
  for (const file of MODEL_PIN.files) writeFileSync(join(directory, file), "");
  writeFileSync(join(directory, "values.json.zst"), zstdCompressSync(Buffer.from('{"0":2}')));
  writeFileSync(join(directory, "values.dat"), "{}");
  writeFileSync(join(directory, ".pinned-model"), MODEL_PIN.sha256);
}
