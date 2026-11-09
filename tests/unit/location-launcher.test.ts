import { expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { fingerprintModel } from "../../src/browser/camoufox.ts";

const proxies: string[] = [];
let reply: (url: string, init: RequestInit) => Promise<Response>;
mock.module("impit", () => ({ Impit: class { constructor(options: { proxyUrl: string }) { proxies.push(options.proxyUrl); }
  fetch(url: string, init: RequestInit) { return reply(url, init); } } }));
const { publicIP } = await import("../../src/runtime/public-ip.ts");
const { engineVersion, prepareProfileLaunch } = await import("../../src/browser/location-launch.ts");

test("the exit-IP check keeps every retry on the configured proxy and rejects malformed addresses", async () => {
  const requests: string[] = [], signal = new AbortController().signal;
  reply = async (url, init) => { requests.push(url); expect(init.signal).toBe(signal); return new Response("999.999.1.1"); };
  await expect(publicIP("http://fixture:password@proxy.test:80", signal)).rejects.toMatchObject({ code: "IP_DETECTION_FAILED" });
  expect(requests.length).toBe(6); expect(proxies).toEqual(["http://fixture:password@proxy.test:80"]);
});
test("the exit-IP check stops on proxy authentication and cancellation", async () => {
  let count = 0;
  reply = async () => { count++; return new Response("", { status: 407 }); };
  await expect(publicIP("http://proxy.test:80", new AbortController().signal)).rejects.toMatchObject({ code: "PROXY_AUTHENTICATION" });
  expect(count).toBe(1);
  const controller = new AbortController(); controller.abort();
  await expect(publicIP("http://proxy.test:80", controller.signal)).rejects.toThrow(); expect(count).toBe(1);
});
test("the launcher reads the paired engine version from a macOS bundle and requires the prepared model", async () => {
  const home = mkdtempSync(join(tmpdir(), "stelz-launcher-")), executable = join(home, "Camoufox.app/Contents/MacOS/camoufox");
  const previous = { CAMOUFOX_EXECUTABLE: process.env.CAMOUFOX_EXECUTABLE, CAMOUFOX_FPGEN_DATA: process.env.CAMOUFOX_FPGEN_DATA, PROXY_HOST: process.env.PROXY_HOST };
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    mkdirSync(join(home, "Camoufox.app/Contents/Resources"), { recursive: true }); mkdirSync(join(home, "Camoufox.app/Contents/MacOS"));
    const ini = join(home, "Camoufox.app/Contents/Resources/application.ini");
    writeFileSync(ini, "[App]\nVersion=152.0.4-beta.30\n");
    expect(() => engineVersion(executable)).toThrow(`Configured Camoufox 152.0.4-beta.30 at ${executable} is not supported. Set CAMOUFOX_EXECUTABLE to the installed Camoufox 156.0.1-beta.36 executable.`);
    writeFileSync(ini, "[App]\nVersion=156.0.1-beta.36\n");
    expect(engineVersion(executable)).toBe("156");
    Object.assign(process.env, { CAMOUFOX_EXECUTABLE: executable, CAMOUFOX_FPGEN_DATA: join(home, "missing") }); delete process.env.PROXY_HOST;
    await expect(prepareProfileLaunch({}, async options => options)).rejects.toThrow("Run stelz setup");
    const model = join(home, "model"); mkdirSync(model);
    const pin = fingerprintModel().MODEL_PIN;
    writeFileSync(join(model, ".pinned-model"), pin.sha256);
    for (const name of pin.files) writeFileSync(join(model, name), "fixture");
    writeFileSync(join(model, "values.json.zst"), zstdCompressSync(Buffer.from('{"0":4,"4":6}')));
    process.env.CAMOUFOX_FPGEN_DATA = model;
    expect(fingerprintModel().isModelInstalled(model)).toBe(true);
    let prepared = false;
    const prepare = async (options: Record<string, unknown>) => { prepared = true; return options; };
    await expect(prepareProfileLaunch({}, prepare)).rejects.toThrow("Run stelz setup");
    expect(prepared).toBe(false); expect(existsSync(join(model, "values.dat"))).toBe(false);
    writeFileSync(join(model, "values.dat"), "short");
    await expect(prepareProfileLaunch({}, prepare)).rejects.toThrow("Run stelz setup");
    expect(prepared).toBe(false); expect(readFileSync(join(model, "values.dat"), "utf8")).toBe("short");
    writeFileSync(join(model, "values.dat"), "0123456789");
    await expect(prepareProfileLaunch({}, prepare)).resolves.toMatchObject({ executable_path: executable, ff_version: "156" });
    expect(prepared).toBe(true);
  } finally {
    Object.defineProperty(process, "platform", platform);
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
    rmSync(home, { recursive: true, force: true });
  }
});
test("unsupported display platforms stop before upstream preparation can write global files", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  let called = false;
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    await expect(prepareProfileLaunch({}, async () => { called = true; })).rejects.toThrow("Browser Start requires macOS");
    expect(called).toBe(false);
  } finally { Object.defineProperty(process, "platform", platform); }
});
test("the real Camofox launch preparation propagates GeoIP failures without retrying disabled", async () => {
  const server = readFileSync("node_modules/@askjo/camofox-browser/server.js", "utf8");
  const source = server.slice(server.indexOf("async function buildLaunchOptionsWithGeoipFallback"), server.indexOf("async function launchBrowserInstance"))
    .replace("(await import('./plugins/local-profile/index.js'))", "plugin");
  const options: unknown[] = [], prepared = { geoip: "198.51.100.10", config: { timezone: "Europe/London" } };
  const build = new Function("plugin", "launchOptions", "withTimeout", "GEOIP_SETUP_TIMEOUT_MS", `${source};return buildLaunchOptionsWithGeoipFallback;`)(
    { prepareProfileLaunch: async (_base: unknown, prepare: (value: unknown) => Promise<unknown>) => prepare(prepared) }, async (value: unknown) => { options.push(value); throw Error("Unknown IP location"); }, (work: unknown) => work, 30000);
  await expect(build({ geoip: true, proxy: { server: "http://proxy.test:80" } })).rejects.toThrow("Unknown IP location");
  expect(options).toEqual([prepared]);
});
