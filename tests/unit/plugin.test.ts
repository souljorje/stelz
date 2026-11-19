import { test } from "bun:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { freezeDevice, replayFingerprint, launchPreferences, applyProxyLocale, readChunks } from "../../src/browser/fingerprint.ts";
import { locationResult } from "../../src/browser/location.ts";
import { register } from "../../src/browser/plugin.ts";
import { uncertainClickError, UNCERTAIN_CLICK } from "../../src/browser/click-guard.ts";
import { commitFingerprint, readFingerprintJournal, stageFingerprint, writeInitialized } from "../../src/browser/fingerprint-transaction.ts";
import { upstreamTyping } from "../helpers/upstream-typing.ts";
import { mockLauncherResources } from "../helpers/launcher-resources.ts";
import { annotate, shop } from "../helpers/aria-fixtures.ts";

mockLauncherResources();

const packageDir = dirname(createRequire(import.meta.url).resolve("@askjo/camofox-browser/package.json"));
const contractsUrl = pathToFileURL(join(packageDir, "mcp/lib/tool-contracts.mjs")).href;
const tabId = "79bed5c4-d5b8-4369-9d13-b159451ece91";

const generated = { "navigator.userAgent": "test UA", "navigator.hardwareConcurrency": 8,
  "navigator.languages": ["en-US"], "screen.width": 1440, "window.history.length": 1,
  timezone: "America/New_York", addons: [join(tmpdir(), "stelz-test-addons", "current")], "canvas:seed": 123 };

test("status advertises window controls only for a current browser inventory", async () => {
  const h = await harness("direct", undefined, { expected: "" });
  try {
    await h.launch(); await h.create();
    const before = (await h.request("status")).payload as { instanceId: string; windowControls: { available: boolean } };
    assert.equal(before.windowControls.available, false);
    const inventory = { instanceId: before.instanceId, windows: [{ id: 1, title: "Window", focused: true, state: "normal",
      tabs: [{ id: 1, title: "Page", url: "https://example.test/", active: true }] }] };
    assert.equal((await h.request("window-bridge", inventory)).code, 200);
    assert.equal(((await h.request("status")).payload as typeof before).windowControls.available, true);
    await h.request("window-bridge", { ...inventory, windows: [] });
    assert.equal(((await h.request("status")).payload as typeof before).windowControls.available, false);
    await h.request("window-bridge", inventory);
    await h.emit("browser:closed");
    assert.equal(((await h.request("status")).payload as typeof before).windowControls.available, false);
  } finally { await h.close(); }
});

test("device replay preserves hardware, refreshes runtime settings, and leaves native window dimensions unspoofed", () => {
  const saved = { ...generated, "navigator.hardwareConcurrency": 4, timezone: "Old/Zone", addons: [join(tmpdir(), "stelz-test-addons", "old")],
    "window.outerHeight": 800 };
  const fresh = { ...generated, "navigator.languages": ["en-GB"], "window.history.length": 3,
    "window.outerHeight": 790, "window.outerWidth": 1200, "window.innerWidth": 1200, "window.innerHeight": 704, futureSetting: true };
  const result = replayFingerprint(saved, fresh);
  assert.equal(result["navigator.hardwareConcurrency"], 4);
  for (const key of ["timezone", "addons", "navigator.languages", "window.history.length", "futureSetting"] as const) {
    assert.deepEqual(result[key], fresh[key]);
  }
  assert.equal(freezeDevice(saved).timezone, undefined);
  for (const key of ["window.innerWidth", "window.innerHeight", "window.outerWidth", "window.outerHeight"]) assert.equal(key in result, false);
  assert.equal(saved["window.outerHeight"], 800);
  assert.equal(fresh["window.outerHeight"], 790);
});

test("proxy policy wins, the restore-session offer is off, and unrelated fresh preferences survive", () => {
  const noRestoreOffer = { "browser.startup.couldRestoreSession.count": -1 };
  assert.deepEqual(launchPreferences({ "media.peerconnection.enabled": true, "network.proxy.failover_direct": true,
    "network.proxy.socks_remote_dns": false, "network.proxy.socks5_remote_dns": false, "network.test": true, fresh: 1 }, true),
    { "media.peerconnection.enabled": false, "network.proxy.failover_direct": false,
      "network.proxy.socks_remote_dns": true, "network.proxy.socks5_remote_dns": true, "network.test": true, fresh: 1, ...noRestoreOffer });
  assert.deepEqual(launchPreferences({ fresh: 1, "browser.startup.couldRestoreSession.count": 0 }, false), { fresh: 1, ...noRestoreOffer });
});

test("proxy host controls verification and security policy independently of ambient routing", async () => {
  const previous = process.env.STELZ_MODE;
  try {
    process.env.STELZ_MODE = "proxy";
    const direct = await harness("direct", undefined, { expected: "", ipError: "offline" });
    try {
      await direct.launch(); await direct.create();
      assert.equal(direct.checks(), 0);
      assert.equal(direct.state().verificationRequired, false);
      assert.equal(Object.hasOwn(direct.state(), "mode"), false);
    } finally { await direct.close(); }
    process.env.STELZ_MODE = "direct";
    const proxied = await harness("proxy", undefined, { expected: "" });
    try {
      const launched = await proxied.launch(); await proxied.create();
      assert.equal(proxied.checks(), 1);
      assert.equal(proxied.state().verificationRequired, true);
      assert.equal(launched.firefoxUserPrefs["media.peerconnection.enabled"], false);
      assert.equal(Object.hasOwn((await proxied.request("status")).payload as object, "mode"), false);
    } finally { await proxied.close(); }
    const missing = await harness("proxy", undefined, { expected: "" });
    try {
      const options = missing.options(); delete options.proxy;
      await assert.rejects(missing.emit("browser:launching", { options }), /Proxy launch configuration is missing/);
    } finally { await missing.close(); }
  } finally {
    if (previous === undefined) delete process.env.STELZ_MODE;
    else process.env.STELZ_MODE = previous;
  }
});

test("proxy language stays stable for the current country across resampled launch locales", () => {
  for (const sampled of ["en", "it", "es"]) {
    const fresh = { "locale:region": "US", "locale:language": sampled, "locale:script": "Latn",
      timezone: "America/Chicago", "geolocation:latitude": 41, "geolocation:longitude": -87 };
    const normalized = applyProxyLocale(fresh, true);
    assert.equal(normalized["locale:language"], "en");
    assert.equal(normalized["locale:script"], undefined);
    assert.equal(normalized.timezone, fresh.timezone);
    assert.equal(normalized["geolocation:latitude"], fresh["geolocation:latitude"]);
    assert.equal(normalized["geolocation:longitude"], fresh["geolocation:longitude"]);
    assert.equal(fresh["locale:language"], sampled);
  }
});

test("proxy language follows a new country while explicit lists and direct policy remain current", () => {
  const country = { "locale:region": "GE", "locale:language": "ru", timezone: "Asia/Tbilisi" };
  assert.equal(applyProxyLocale(country, true)["locale:language"], "ka");
  assert.deepEqual(applyProxyLocale(country, false), country);
  const explicit = { ...country, "locale:all": "ru-GE, ru" };
  assert.deepEqual(applyProxyLocale(explicit, true), explicit);
  for (const config of [{ "locale:language": "fr" }, { "locale:region": "ZZ", "locale:language": "fr" }])
    assert.deepEqual(applyProxyLocale(config, true), config);
});

type App = Parameters<typeof register>[0];
type Handler = Parameters<App["post"]>[1];
async function harness(mode: "direct" | "proxy" = "direct", waitForIP?: Promise<void>,
  fixture: { expected?: string; timeout?: number; ipError?: string; canonical?: boolean; port?: number;
    interval?: number; now?: () => number; observedTimezone?: string; fingerprintError?: string; observeTimeout?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "stelz-plugin-")), id = "profile-01";
  const stateDir = join(root, id), upstream = join(root, "upstream"), binary = join(root, "browser");
  mkdirSync(stateDir); mkdirSync(join(upstream, "mcp/lib"), { recursive: true });
  // The plugin loads the ARIA helpers from the Camofox tree.
  symlinkSync(join(packageDir, "lib"), join(upstream, "lib"), "dir");
  writeFileSync(join(root, "profiles.json"), JSON.stringify({ profiles: [{ id, typingMode: "balanced" }] }));
  writeFileSync(binary, "test browser binary");
  writeFileSync(join(upstream, "mcp/lib/tool-contracts.mjs"), fixture.canonical ? `export * from ${JSON.stringify(contractsUrl)};` : `
    export { TOOL_DEFS } from ${JSON.stringify(contractsUrl)};
    export async function runTool(name, args) { return globalThis.__stelzTool(name, args); }
  `);
  const locationConfig = { timezone: "America/New_York", "locale:language": "en", "locale:region": "US", "geolocation:latitude": 40, "geolocation:longitude": -73 };
  const location = { version: 1, inputId: "fixture", attemptId: "test-start", result: { ...locationResult("ready"), valid: true, network: "passed", geoip: "passed" },
    prepared: { ip: "198.51.100.10", config: locationConfig, dataId: "fixture", engineId: "fixture" } };
  if (mode === "proxy") writeFileSync(join(stateDir, "location.json"), JSON.stringify(location));
  const settings = { STELZ_LOCATION_LAUNCH: JSON.stringify(location), STELZ_START_ID: "test-start", STELZ_HOME: root, STELZ_PROFILE_ID: id, STELZ_PROFILE_DIR: stateDir, STELZ_UPSTREAM: upstream,
    STELZ_CONFIGURATION_HASH: "a".repeat(64), STELZ_BOOTSTRAP_TOKEN: "test-bootstrap-secret",
    STELZ_CAMOUFOX_EXECUTABLE: binary, PROXY_HOST: mode === "proxy" ? "127.0.0.1" : "", STELZ_EXPECTED_IP: fixture.expected ?? "198.51.100.10",
    CAMOFOX_PORT: String(fixture.port ?? 0), CAMOFOX_ACCESS_KEY: "fixture-key" };
  const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings);
  writeFileSync(join(stateDir, "running.json"), JSON.stringify({ instanceId: settings.STELZ_START_ID,
    configurationHash: settings.STELZ_CONFIGURATION_HASH, serverPid: process.pid }));
  const events = new EventEmitter(), routes = new Map<string, Handler>(), sessions = new Map<string, unknown>();
  const app: App = { get(path, ...handlers) { routes.set(path, handlers.at(-1)!); }, post(path, ...handlers) { routes.set(path, handlers.at(-1)!); } };
  let ipGate = waitForIP;
  let ipError = fixture.ipError;
  let ip = "198.51.100.10";
  let checks = 0;
  let shutdowns = 0;
  let runTool: (name: string, args: Record<string, unknown>) => Promise<unknown> = async () => ({ spec: {}, payload: "ok" });
  const globals = globalThis as typeof globalThis & { __stelzTool?: typeof runTool };
  const previousTool = globals.__stelzTool;
  globals.__stelzTool = (name, args) => runTool(name, args);
  const pages = new Set<EventEmitter>([Object.assign(new EventEmitter(), { url: () => "about:blank", async evaluate() {
    return { timezone: fixture.observedTimezone ?? "America/New_York", locale: "en-US", language: "en-US", languages: ["en-US"] };
  } })]);
  const context = Object.assign(new EventEmitter(), { pages: () => [...pages], async close() { context.emit("close"); } });
  await register(app, { auth: () => () => {}, events, sessions },
    { actionTimeoutMs: fixture.timeout, observeTimeoutMs: fixture.observeTimeout, ipCheckIntervalMs: fixture.interval ?? 0, now: fixture.now,
      verifyFingerprint: async () => { if (fixture.fingerprintError) throw Error(fixture.fingerprintError); },
      shutdown: () => { shutdowns++; events.emit("server:shutdown"); } });
  const emit = async (name: string, value: unknown = {}) => { await Promise.all(events.listeners(name).map(fn => fn(value))); };
  const state = () => JSON.parse(readFileSync(join(stateDir, "status.json"), "utf8")) as {
    profileId: string; instanceId: string;
    phase: string; verificationStatus: string; verificationRequired: boolean; error?: string; checkFailure?: string;
  };
  const options = () => ({ env: { CAMOU_CONFIG_1: JSON.stringify({ ...generated, ...(mode === "proxy" ? locationConfig : {}) }) } as Record<string, string>,
    firefoxUserPrefs: { fresh: true, "media.peerconnection.enabled": mode !== "proxy" } as Record<string, unknown>,
    ...(mode === "proxy" ? { proxy: { server: "http://127.0.0.1:9999" } } : {}) });
  const launch = async () => { const value = options(); await emit("browser:launching", { options: value }); return value; };
  const create = async (admit = true) => {
    await emit("session:creating", { userId: id, contextOptions: {} });
    await emit("session:created", { userId: id, context });
    if (admit) await commit();
  };
  const rawRequest = async (action: string, body?: Record<string, unknown>, headers?: Record<string, string>) => {
    let code = 200, payload: unknown;
    const response = { status(value: number) { code = value; return response; }, json(value: unknown) { payload = value; } };
    await routes.get(`/local-profile/${action}`)!({ body, headers }, response);
    return { code, payload };
  };
  const commit = async () => {
    const journal = readFingerprintJournal(stateDir)!;
    commitFingerprint(stateDir, journal.owner, journal.sha256);
    writeInitialized(stateDir, { instanceId: journal.owner.attemptId, browserInstanceId: journal.owner.browserInstanceId,
      configurationHash: journal.owner.configurationHash, fingerprintSha256: journal.sha256 });
    const ack = await rawRequest("startup-ack", { instanceId: journal.owner.attemptId, browserInstanceId: journal.owner.browserInstanceId },
      { "x-stelz-bootstrap": settings.STELZ_BOOTSTRAP_TOKEN });
    assert.equal(ack.code, 200);
  };
  const identity = { profileId: id, instanceId: state().instanceId };
  let bridgeStopped = false, bridgeTimer: ReturnType<typeof setTimeout>;
  let networkResult: { id: string; body?: string; failed?: true } | undefined;
  async function networkTick() {
    const response = await rawRequest("network-bridge", { instanceId: identity.instanceId, result: networkResult });
    networkResult = undefined;
    const pending = (response.payload as { request?: { id: string } }).request;
    if (pending) {
      checks++;
      await ipGate;
      networkResult = ipError ? { id: pending.id, failed: true } : { id: pending.id, body: JSON.stringify({ ip }) };
    }
    if (!bridgeStopped) bridgeTimer = setTimeout(networkTick, 0);
  }
  bridgeTimer = setTimeout(networkTick, 0);
  const request = (action: string, body: Record<string, unknown> = {}) => rawRequest(action,
    ["acquire", "release", "tool"].includes(action) || Object.hasOwn(body, "controllerId") ? { ...identity, ...body } : body);
  return { id, identity, stateDir, binary, context, sessions, emit, state, options, launch, create, commit, request, rawRequest,
    setIPGate(value: Promise<void> | undefined) { ipGate = value; },
    setIPError(value: string | undefined) { ipError = value; },
    setIP(value: string) { ip = value; },
    checks() { return checks; },
    async waitForChecks(count: number) {
      const deadline = Date.now() + 1000;
      while (checks < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
      assert.equal(checks, count, "The browser add-on did not receive the admitted IP check.");
    },
    shutdowns() { return shutdowns; },
    openPage() { const page = new EventEmitter(); pages.add(page); context.emit("page", page); return page; },
    closePage(page = [...pages][0]!) { pages.delete(page); page.emit("close"); },
    setTool(value: typeof runTool) { runTool = value; },
    async close() {
      bridgeStopped = true; clearTimeout(bridgeTimer);
      await emit("server:shutdown");
      globals.__stelzTool = previousTool;
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      rmSync(root, { recursive: true, force: true });
    } };
}

test("the actual launch hook rejects schema-1 fingerprint pins", async () => {
  const h = await harness("proxy");
  try {
    const pin = { version: 1, engineSha256: createHash("sha256").update(readFileSync(h.binary)).digest("hex"),
      config: generated, preferences: { "media.peerconnection.enabled": true, stale: true } };
    writeFileSync(join(h.stateDir, "fingerprint.json"), JSON.stringify(pin));
    const before = readFileSync(join(h.stateDir, "fingerprint.json"), "utf8");
    await assert.rejects(h.launch(), /pin\.version/);
    assert.equal(readFileSync(join(h.stateDir, "fingerprint.json"), "utf8"), before);
  } finally { await h.close(); }
});

test("the launch hook applies current-country language without changing an existing device pin", async () => {
  const h = await harness("proxy");
  try {
    const pin = { version: 2, engineSha256: createHash("sha256").update(readFileSync(h.binary)).digest("hex"), config: generated };
    const before = JSON.stringify(pin);
    writeFileSync(join(h.stateDir, "fingerprint.json"), before);
    const options = h.options();
    options.env.CAMOU_CONFIG_1 = JSON.stringify({ ...JSON.parse(options.env.CAMOU_CONFIG_1!), "locale:region": "US", "locale:language": "it" });
    await h.emit("browser:launching", { options });
    const effective = JSON.parse(options.env.CAMOU_CONFIG_1!);
    assert.equal(effective["locale:language"], "en");
    assert.equal(effective["locale:region"], "US");
    assert.equal(effective.timezone, generated.timezone);
    assert.equal(readFileSync(join(h.stateDir, "fingerprint.json"), "utf8"), before);
    assert.equal(options.firefoxUserPrefs["media.peerconnection.enabled"], false);
  } finally { await h.close(); }
});

test("a saved pin replays despite an invalid unused generated device sample", async () => {
  const h = await harness("direct", undefined, { expected: "" });
  try {
    const pin = { version: 2, engineSha256: createHash("sha256").update(readFileSync(h.binary)).digest("hex"), config: freezeDevice(generated) };
    const before = JSON.stringify(pin, null, 4) + "\n";
    writeFileSync(join(h.stateDir, "fingerprint.json"), before);
    const options = h.options();
    options.env.CAMOU_CONFIG_1 = JSON.stringify({ ...generated, "screen.width": -1 });
    await h.emit("browser:launching", { options });
    assert.equal(JSON.parse(options.env.CAMOU_CONFIG_1!)["screen.width"], generated["screen.width"]);
    assert.equal(readFileSync(join(h.stateDir, "fingerprint.json"), "utf8"), before);
  } finally { await h.close(); }
});

test("an unfinished journal replays its candidate despite an invalid unused generated sample", async () => {
  const h = await harness("direct", undefined, { expected: "" });
  try {
    const engineSha256 = createHash("sha256").update(readFileSync(h.binary)).digest("hex");
    const owner = { profileId: h.id, attemptId: "test-start", browserInstanceId: h.identity.instanceId,
      configurationHash: "a".repeat(64), serverPid: process.pid };
    const staged = stageFingerprint(h.stateDir, owner, { version: 2, engineSha256, config: freezeDevice(generated) }, engineSha256);
    const options = h.options();
    options.env.CAMOU_CONFIG_1 = JSON.stringify({ ...generated, "screen.width": -1 });
    await h.emit("browser:launching", { options });
    assert.equal(readFingerprintJournal(h.stateDir)!.candidate, staged.candidate);
    assert.equal(JSON.parse(options.env.CAMOU_CONFIG_1!)["screen.width"], generated["screen.width"]);
    assert.equal(existsSync(join(h.stateDir, "fingerprint.json")), false);
  } finally { await h.close(); }
});

test("an invalid selected new device is rejected before staging", async () => {
  const h = await harness("direct", undefined, { expected: "" });
  try {
    const options = h.options();
    options.env.CAMOU_CONFIG_1 = JSON.stringify({ ...generated, "screen.width": -1 });
    await assert.rejects(h.emit("browser:launching", { options }), /geometry\.value\.invalid/);
    assert.equal(readFingerprintJournal(h.stateDir), undefined);
    assert.equal(existsSync(join(h.stateDir, "fingerprint.json")), false);
  } finally { await h.close(); }
});

test("a new pin stores device fields, not Firefox security preferences", async () => {
  const h = await harness();
  try {
    await h.launch();
    assert.equal(existsSync(join(h.stateDir, "fingerprint.json")), false);
    await h.create();
    const pin = JSON.parse(readFileSync(join(h.stateDir, "fingerprint.json"), "utf8"));
    assert.equal(pin.version, 2); assert.equal(pin.preferences, undefined);
    assert.equal(pin.config.timezone, undefined); assert.equal(pin.config["canvas:seed"], 123);
  } finally { await h.close(); }
});

for (const enabled of [true, false]) {
  test(`the launch hook keeps WebGL2 support ${enabled} when the fresh GPU differs`, async () => {
    const h = await harness();
    try {
      const gpu = { "webGl:vendor": "saved GPU", "webGl:parameters": {},
        ...(enabled ? { "webGl2:parameters": {}, "webGl2:supportedExtensions": ["saved extension"] } : {}) };
      writeFileSync(join(h.stateDir, "fingerprint.json"), JSON.stringify({ version: 2,
        engineSha256: createHash("sha256").update(readFileSync(h.binary)).digest("hex"), config: { ...generated, ...gpu } }));
      const options = h.options();
      options.env.CAMOU_CONFIG_1 = JSON.stringify({ ...generated, "webGl:parameters": {},
        ...(!enabled ? { "webGl2:parameters": {}, "webGl2:supportedExtensions": ["fresh extension"] } : {}) });
      options.firefoxUserPrefs["webgl.enable-webgl2"] = !enabled;
      await h.emit("browser:launching", { options });
      assert.equal(options.firefoxUserPrefs["webgl.enable-webgl2"], enabled);
      const effective = JSON.parse(options.env.CAMOU_CONFIG_1!);
      assert.deepEqual(effective["webGl2:supportedExtensions"], enabled ? ["saved extension"] : undefined);
      assert.equal("webGl2:parameters" in effective, enabled);
    } finally { await h.close(); }
  });
}

for (const savedApple of [true, false]) {
  test(`the launch hook derives DPR and WebGPU from the saved ${savedApple ? "Apple" : "Intel"} device`, async () => {
    const h = await harness("direct", undefined, { expected: "" });
    try {
      const device = (apple: boolean) => ({ ...generated,
        "navigator.userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:158.0) Gecko/20100101 Firefox/158.0",
        "navigator.platform": "MacIntel", "window.devicePixelRatio": apple ? 2 : 1,
        "webGl:vendor": apple ? "Apple" : "Intel Inc.",
        "webGl:renderer": apple ? "Apple M1" : "Intel Iris OpenGL Engine", "webGl:parameters": {} });
      const before = JSON.stringify({ version: 2,
        engineSha256: createHash("sha256").update(readFileSync(h.binary)).digest("hex"), config: freezeDevice(device(savedApple)) });
      writeFileSync(join(h.stateDir, "fingerprint.json"), before);
      const options = h.options();
      options.env.CAMOU_CONFIG_1 = JSON.stringify(device(!savedApple));
      Object.assign(options.firefoxUserPrefs, { "dom.webgpu.enabled": !savedApple, "gfx.blacklist.webgpu": 1,
        "privacy.baselineFingerprintingProtection.overrides": "+CanvasImageExtractionPrompt", unrelated: true });
      if (!savedApple) options.firefoxUserPrefs["layout.css.devPixelsPerPx"] = "2";
      options.env.CAMOU_PREFS_1 = JSON.stringify(options.firefoxUserPrefs);
      await h.emit("browser:launching", { options });
      const effective = readChunks(options.env, "CAMOU_CONFIG") as Record<string, unknown>;
      assert.equal(effective["window.devicePixelRatio"], savedApple ? 2 : 1);
      assert.equal(effective["webGl:vendor"], savedApple ? "Apple" : "Intel Inc.");
      assert.equal(options.firefoxUserPrefs["layout.css.devPixelsPerPx"], savedApple ? "2" : undefined);
      assert.equal(options.firefoxUserPrefs["dom.webgpu.enabled"], savedApple);
      assert.equal(options.firefoxUserPrefs["gfx.blacklist.webgpu"], savedApple ? 4 : undefined);
      assert.equal(options.firefoxUserPrefs["privacy.baselineFingerprintingProtection.overrides"], "+CanvasImageExtractionPrompt");
      assert.equal(options.firefoxUserPrefs.unrelated, true);
      assert.deepEqual(readChunks(options.env, "CAMOU_PREFS"), options.firefoxUserPrefs);
      assert.equal(readFileSync(join(h.stateDir, "fingerprint.json"), "utf8"), before);
    } finally { await h.close(); }
  });
}

test("session destruction latches a block before cleanup and refuses upstream recovery", async () => {
  const h = await harness();
  try {
    await h.launch(); await h.create(); assert.equal(h.state().phase, "ready");
    await h.emit("session:destroying", { userId: h.id });
    assert.equal(h.state().phase, "blocked");
    await assert.rejects(h.create(), /Replacement browser context refused/);
    assert.equal(h.state().phase, "blocked");
  } finally { await h.close(); }
});

test("browser:launching cannot clear a browser:restart block", async () => {
  const h = await harness();
  try {
    await h.launch(); await h.create(); await h.emit("browser:restart");
    await assert.rejects(h.launch(), /Replacement browser refused/);
    assert.equal(h.state().phase, "blocked");
  } finally { await h.close(); }
});

test("a second context is refused even without a destruction notification", async () => {
  const h = await harness();
  try { await h.launch(); await h.create(); await assert.rejects(h.create(), /Replacement browser context refused/); }
  finally { await h.close(); }
});

test("closing the browser context stops the lifetime once and refuses replacement", async () => {
  const h = await harness();
  try {
    await h.launch(); await h.create(); await h.context.close();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.state().phase, "stopped");
    assert.equal(h.shutdowns(), 1);
    await h.context.close(); await h.emit("browser:closed");
    assert.equal(h.shutdowns(), 1);
    await assert.rejects(h.create(), /Replacement browser context refused/);
  } finally { await h.close(); }
});

test("a browser disconnect stops the lifetime without an upstream close event", async () => {
  const h = await harness();
  try {
    const browser = new EventEmitter();
    await h.launch(); await h.emit("browser:launched", { browser }); await h.create();
    browser.emit("disconnected");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.state().phase, "stopped");
    assert.equal(h.shutdowns(), 1);
  } finally { await h.close(); }
});

test("closing an already blocked browser still stops the lifetime", async () => {
  const h = await harness();
  try {
    await h.launch(); await h.create(); await h.emit("browser:restart");
    assert.equal(h.state().phase, "blocked");
    await h.context.close();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.state().phase, "stopped");
    assert.equal(h.shutdowns(), 1);
    await assert.rejects(h.launch(), /Replacement browser refused/);
  } finally { await h.close(); }
});

test("closing the last page stops a connected Firefox context, but other pages keep it running", async () => {
  const h = await harness();
  try {
    await h.launch(); await h.create();
    const second = h.openPage();
    h.closePage();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.state().phase, "ready");
    assert.equal(h.shutdowns(), 0);
    h.closePage(second);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.state().phase, "stopped");
    assert.equal(h.shutdowns(), 1);
  } finally { await h.close(); }
});

test("an in-flight IP check cannot restore ready after context loss", async () => {
  let resolve!: () => void;
  const gate = new Promise<void>(done => { resolve = done; });
  const h = await harness("direct", gate);
  try {
    await h.launch();
    await h.emit("session:creating", { userId: h.id, contextOptions: {} });
    const pending = h.emit("session:created", { userId: h.id, context: h.context });
    const rejected = assert.rejects(pending);
    await h.emit("browser:restart"); resolve(); await rejected;
    assert.equal(h.state().phase, "blocked");
    assert.match(h.state().error!, /Browser restart refused/);
    assert.equal(h.shutdowns(), 1);
  } finally { resolve(); await h.close(); }
});

test("graceful shutdown is not reclassified as a recovery failure", async () => {
  const h = await harness();
  try {
    await h.launch(); await h.create(); await h.emit("server:shutdown");
    await h.emit("session:destroying", { userId: h.id }); await h.context.close();
    await h.emit("browser:closed"); assert.equal(h.state().phase, "stopped");
  } finally { await h.close(); }
});


test("pausing during an IP check does not become an irreversible context-loss block", async () => {
  const h = await harness();
  let resolve!: () => void;
  const gate = new Promise<void>(done => { resolve = done; });
  try {
    await h.launch(); await h.create(); h.setIPGate(gate);
    const check = h.request("check");
    const pause = h.request("pause");
    resolve();
    assert.equal((await check).code, 200);
    await pause;
    assert.equal(h.state().phase, "paused");
    h.setIPGate(undefined);
    assert.equal((await h.request("resume")).code, 200);
    assert.equal(h.state().phase, "ready");
  } finally { resolve(); await h.close(); }
});

const controller = { id: "controller-a", pid: process.pid, label: "test" };
// A plain action. tab_snapshot has its own path, which reads the tab state of Camofox.
const listTabs = { controllerId: controller.id, name: "tab_list", args: {} };

test("bootstrap preparation cannot admit control before the commit and matching marker", async () => {
  const h = await harness("direct", undefined, { expected: "" });
  try {
    await h.launch();
    await h.create(false);
    assert.equal(h.state().phase, "starting");
    assert.equal(existsSync(join(h.stateDir, "fingerprint.json")), false);
    for (const [action, body] of [["acquire", controller], ["check", {}], ["pause", {}], ["resume", {}],
      ["window-show", {}], ["tool", listTabs]] as const) assert.equal((await h.request(action, body)).code, 409, action);
    const journal = readFingerprintJournal(h.stateDir)!;
    const body = { instanceId: journal.owner.attemptId, browserInstanceId: journal.owner.browserInstanceId };
    assert.equal((await h.rawRequest("startup-ack", body, { "x-stelz-bootstrap": "wrong" })).code, 409);
    assert.equal((await h.rawRequest("startup-ack", body, { "x-stelz-bootstrap": "test-bootstrap-secret" })).code, 409);
    writeInitialized(h.stateDir, { instanceId: journal.owner.attemptId, browserInstanceId: journal.owner.browserInstanceId,
      configurationHash: journal.owner.configurationHash, fingerprintSha256: journal.sha256 });
    assert.equal((await h.rawRequest("startup-ack", body, { "x-stelz-bootstrap": "test-bootstrap-secret" })).code, 409);
    assert.equal((await h.request("acquire", controller)).code, 409);
    commitFingerprint(h.stateDir, journal.owner, journal.sha256);
    assert.equal((await h.rawRequest("startup-ack", { ...body, instanceId: "older-attempt" },
      { "x-stelz-bootstrap": "test-bootstrap-secret" })).code, 409);
    assert.equal((await h.rawRequest("startup-ack", { ...body, browserInstanceId: "older-browser" },
      { "x-stelz-bootstrap": "test-bootstrap-secret" })).code, 409);
    await h.commit();
    assert.equal(h.state().phase, "ready");
    assert.equal((await h.request("acquire", controller)).code, 200);
  } finally { await h.close(); }
});

test("a stale reservation cannot acknowledge or retain browser admission", async () => {
  const h = await harness("direct", undefined, { expected: "" });
  try {
    await h.launch(); await h.create(false);
    const journal = readFingerprintJournal(h.stateDir)!;
    commitFingerprint(h.stateDir, journal.owner, journal.sha256);
    writeInitialized(h.stateDir, { instanceId: journal.owner.attemptId, browserInstanceId: journal.owner.browserInstanceId,
      configurationHash: journal.owner.configurationHash, fingerprintSha256: journal.sha256 });
    writeFileSync(join(h.stateDir, "running.json"), JSON.stringify({ instanceId: "new-attempt",
      configurationHash: journal.owner.configurationHash, serverPid: process.pid }));
    assert.equal((await h.rawRequest("startup-ack", { instanceId: journal.owner.attemptId,
      browserInstanceId: journal.owner.browserInstanceId }, { "x-stelz-bootstrap": "test-bootstrap-secret" })).code, 409);
    assert.equal((await h.request("acquire", controller)).code, 409);
    assert.equal(h.state().phase, "starting");
  } finally { await h.close(); }
});

test("removing the matching marker blocks an existing controller's actions and recheck", async () => {
  const h = await harness("direct", undefined, { expected: "" });
  try {
    await h.launch(); await h.create();
    assert.equal((await h.request("acquire", controller)).code, 200);
    rmSync(join(h.stateDir, "initialized.json"));
    assert.equal((await h.request("tool", listTabs)).code, 409);
    assert.equal((await h.request("check", { controllerId: controller.id })).code, 409);
    assert.equal((await h.request("pause", { controllerId: controller.id })).code, 409);
  } finally { await h.close(); }
});

test("admission rejects a journal owned by a different profile", async () => {
  const h = await harness("direct", undefined, { expected: "" });
  try {
    await h.launch(); await h.create();
    const file = join(h.stateDir, "fingerprint-transaction.json");
    const journal = JSON.parse(readFileSync(file, "utf8"));
    journal.owner.profileId = "another-profile";
    writeFileSync(file, JSON.stringify(journal));
    assert.equal((await h.request("acquire", controller)).code, 409);
    assert.equal(h.state().phase, "ready");
  } finally { await h.close(); }
});

test("a stop for an older service instance leaves the current browser running", async () => {
  const h = await harness("direct", undefined, { expected: "" });
  try {
    await h.launch(); await h.create();
    assert.equal((await h.rawRequest("stop", { instanceId: "older-attempt" })).code, 409);
    assert.equal(h.state().phase, "ready");
    assert.equal(h.shutdowns(), 0);
  } finally { await h.close(); }
});

test("control status pins protocol and service identity without disclosing controller credentials", async () => {
  const h = await harness("direct", undefined, { expected: "" });
  try {
    await h.launch(); await h.create();
    const acquired = await h.request("acquire", { ...controller, credential: "private-credential" });
    assert.equal(acquired.code, 200);
    const summary = { pid: controller.pid, label: controller.label, activeActions: 0, releasing: false };
    for (const response of [acquired, await h.request("status")]) {
      const value = response.payload as Record<string, unknown>;
      assert.equal(value.profileId, h.id);
      assert.equal(value.instanceId, h.identity.instanceId);
      assert.deepEqual(value.controller, summary);
      assert.ok(!JSON.stringify(value).includes(controller.id));
      assert.ok(!JSON.stringify(value).includes("private-credential"));
    }
    assert.equal((await h.request("acquire", controller)).code, 409);
    assert.equal((await h.request("tool", listTabs)).code, 200);
  } finally { await h.close(); }
});

test("foreign and incomplete service envelopes fail before lease checks or effects", async () => {
  const h = await harness();
  let dispatched = 0;
  const invalidIdentities = [
    { profileId: "other-profile" }, { instanceId: "other-service" },
    { profileId: undefined }, { instanceId: undefined },
    { profileId: null }, { instanceId: 123 },
  ];
  try {
    // Identity is checked even before the browser is ready.
    const starting = await h.rawRequest("acquire", controller);
    assert.equal(starting.code, 409);
    assert.match((starting.payload as { error: string }).error, /profile and service instance/);
    await h.launch(); await h.create(); await h.request("acquire", controller);
    h.setTool(async () => { dispatched++; return { spec: {}, payload: "ok" }; });
    const checks = h.checks(), before = (await h.request("status")).payload;
    for (const action of ["acquire", "tool", "release", "pause", "resume", "check"]) {
      for (const invalid of invalidIdentities) {
        const body = { ...h.identity, ...controller, ...listTabs, ...invalid };
        const result = await h.rawRequest(action, body);
        assert.equal(result.code, 409, action);
        assert.match((result.payload as { error: string }).error, /profile and service instance/, action);
      }
    }
    for (const action of ["acquire", "tool", "release"]) assert.equal((await h.rawRequest(action)).code, 409);
    for (const action of ["tool", "release", "pause", "resume", "check"]) {
      for (const controllerId of [undefined, null, "", 123, [], {}]) {
        assert.equal((await h.rawRequest(action, { ...h.identity, controllerId })).code, 409, action);
      }
    }
    for (const invalid of invalidIdentities) {
      assert.equal((await h.rawRequest("release", { ...h.identity, ...invalid, controllerId: "future-controller" })).code, 409);
    }
    assert.equal(h.checks(), checks);
    assert.equal(dispatched, 0);
    assert.deepEqual((await h.request("status")).payload, before);
    assert.equal((await h.request("tool", listTabs)).code, 200);
    await h.request("release", { controllerId: controller.id });
    assert.equal((await h.request("acquire", { ...controller, id: "future-controller" })).code, 200);
  } finally { await h.close(); }
});

test("acquisition validates controller fields without coercing malformed credentials", async () => {
  const h = await harness("direct", undefined, { expected: "" });
  try {
    await h.launch(); await h.create();
    for (const invalid of [{ id: "" }, { id: 123 }, { id: undefined }, { pid: String(process.pid) },
      { pid: 0 }, { pid: 1.5 }, { label: undefined }, { label: 123 }]) {
      assert.equal((await h.request("acquire", { ...controller, ...invalid })).code, 409);
      assert.equal(((await h.request("status")).payload as { controller: unknown }).controller, null);
    }
    assert.equal((await h.request("acquire", controller)).code, 200);
  } finally { await h.close(); }
});

test("release before delayed acquisition permanently revokes that ID while preserving other owners", async () => {
  const h = await harness("direct", undefined, { expected: "" });
  const next = { ...controller, id: "controller-b", label: "next" };
  try {
    // Interrupted acquisition cleanup is valid even before browser startup.
    assert.equal((await h.request("release", { controllerId: controller.id })).code, 200);
    await h.launch(); await h.create();
    assert.equal((await h.request("acquire", controller)).code, 409);
    assert.equal((await h.request("acquire", next)).code, 200);
    assert.equal((await h.request("release", { controllerId: controller.id })).code, 200);
    assert.equal((await h.request("release", { controllerId: "never-acquired" })).code, 200);
    assert.equal((await h.request("tool", { ...listTabs, controllerId: next.id })).code, 200);
    await h.request("release", { controllerId: next.id });
    for (const id of [controller.id, next.id, "never-acquired"]) {
      const result = await h.request("acquire", { ...controller, id });
      assert.equal(result.code, 409);
      assert.match((result.payload as { error: string }).error, /revoked/);
    }
  } finally { await h.close(); }
});

test("operator handoff fences every old-owner action and stale cleanup preserves the new lease", async () => {
  const h = await harness("proxy");
  const next = { ...controller, id: "controller-b", label: "next" };
  try {
    await h.launch(); await h.create(); await h.request("acquire", controller);
    assert.equal((await h.request("handoff")).code, 200);
    assert.equal((await h.request("acquire", next)).code, 200);
    const before = (await h.request("status")).payload, checks = h.checks();
    for (const action of ["tool", "pause", "resume", "check"]) {
      assert.equal((await h.request(action, listTabs)).code, 409, action);
    }
    assert.equal((await h.request("release", { controllerId: controller.id })).code, 200);
    assert.deepEqual((await h.request("status")).payload, before);
    assert.equal(h.checks(), checks);
    assert.equal((await h.request("acquire", controller)).code, 409);
    assert.equal((await h.request("tool", { ...listTabs, controllerId: next.id })).code, 200);
    // Operator controls remain available without a controller envelope.
    assert.equal((await h.request("pause")).code, 200);
    assert.equal((await h.request("check")).code, 200);
    assert.equal((await h.request("resume")).code, 200);
  } finally { await h.close(); }
});

for (const operation of ["check", "resume"]) test(`release drains an admitted ${operation} and rejects further owned controls`, async () => {
  const h = await harness("proxy");
  const gate = Promise.withResolvers<void>();
  const next = { ...controller, id: "controller-b", label: "next" };
  let released = false;
  try {
    await h.launch(); await h.create(); await h.request("acquire", controller);
    if (operation === "resume") await h.request("pause");
    const phase = h.state().phase, checks = h.checks();
    h.setIPGate(gate.promise);
    const admitted = h.request(operation, { controllerId: controller.id });
    await h.waitForChecks(checks + 1);
    assert.equal(h.checks(), checks + 1);
    const release = h.request("release", { controllerId: controller.id }).then(result => { released = true; return result; });
    for (const action of ["pause", "resume", "check", "tool"]) {
      const response = await h.request(action, listTabs);
      assert.equal(response.code, 409, action);
      assert.match((response.payload as { error: string }).error, /Acquire/, action);
    }
    assert.equal((await h.request("acquire", next)).code, 409);
    const summary = ((await h.request("status")).payload as { controller: unknown }).controller;
    assert.deepEqual(summary, { pid: controller.pid, label: controller.label, activeActions: 1, releasing: true });
    assert.equal(released, false);
    assert.equal(h.state().phase, phase);
    assert.equal(h.checks(), checks + 1);
    gate.resolve();
    assert.equal((await admitted).code, 200);
    assert.equal((await release).code, 200);
    assert.equal(h.state().phase, "ready");
    assert.equal((await h.request("acquire", next)).code, 200);
    assert.equal((await h.request("release", { controllerId: controller.id })).code, 200);
    assert.equal((await h.request("tool", { ...listTabs, controllerId: next.id })).code, 200);
  } finally { gate.resolve(); await h.close(); }
});

test("owned pause changes phase immediately and release waits for its admitted work", async () => {
  const h = await harness("direct", undefined, { expected: "" });
  const gate = Promise.withResolvers<void>(), started = Promise.withResolvers<void>();
  let paused = false, released = false, dispatched = 0;
  try {
    await h.launch(); await h.create(); await h.request("acquire", controller);
    h.setTool(async () => { dispatched++; started.resolve(); await gate.promise; return { spec: {}, payload: "ok" }; });
    const action = h.request("tool", listTabs);
    await started.promise;
    const queued = h.request("tool", listTabs);
    const pause = h.request("pause", { controllerId: controller.id }).then(result => { paused = true; return result; });
    assert.equal(h.state().phase, "paused");
    const release = h.request("release", { controllerId: controller.id }).then(result => { released = true; return result; });
    assert.equal((await h.request("resume", { controllerId: controller.id })).code, 409);
    assert.equal((await h.request("pause", { controllerId: controller.id })).code, 409);
    assert.equal((await h.request("acquire", { ...controller, id: "controller-b" })).code, 409);
    assert.equal(paused, false); assert.equal(released, false);
    assert.deepEqual(((await h.request("status")).payload as { controller: unknown }).controller,
      { pid: controller.pid, label: controller.label, activeActions: 3, releasing: true });
    gate.resolve();
    assert.equal((await action).code, 200);
    assert.equal((await queued).code, 409);
    assert.equal((await pause).code, 200);
    assert.equal((await release).code, 200);
    assert.equal(dispatched, 1);
    assert.equal(h.state().phase, "paused");
    assert.equal((await h.request("acquire", { ...controller, id: "controller-b" })).code, 200);
    assert.equal((await h.request("resume", { controllerId: "controller-b" })).code, 200);
  } finally { gate.resolve(); await h.close(); }
});

for (const queued of [false, true]) test(`a newer pause supersedes a ${queued ? "queued" : "running"} resume`, async () => {
  const h = await harness("proxy");
  const gate = Promise.withResolvers<void>();
  let pauseFinished = false;
  try {
    await h.launch(); await h.create(); await h.request("acquire", controller);
    await h.request("pause", { controllerId: controller.id });
    h.setIPGate(gate.promise);
    const before = h.checks();
    const check = queued ? h.request("check", { controllerId: controller.id }) : undefined;
    const resume = h.request("resume", { controllerId: controller.id });
    await h.waitForChecks(before + 1);
    const checks = h.checks();
    const pause = h.request("pause", { controllerId: controller.id }).then(result => { pauseFinished = true; return result; });
    assert.equal(h.state().phase, "paused");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(pauseFinished, false);
    gate.resolve();
    if (check) assert.equal((await check).code, 200);
    const stale = await resume;
    assert.equal(stale.code, 409);
    assert.match((stale.payload as { error: string }).error, /newer pause/);
    assert.equal((await pause).code, 200);
    assert.equal(h.state().phase, "paused");
    assert.equal(h.checks(), checks + (queued ? 1 : 0));
    assert.equal((await h.request("resume", { controllerId: controller.id })).code, 200);
    assert.equal(h.state().phase, "ready");
  } finally { gate.resolve(); await h.close(); }
});

test("operator handoff waits for admitted browser work before another owner can acquire", async () => {
  const h = await harness("direct", undefined, { expected: "" });
  const gate = Promise.withResolvers<void>(), started = Promise.withResolvers<void>();
  let handedOff = false;
  try {
    await h.launch(); await h.create(); await h.request("acquire", controller);
    h.setTool(async () => { started.resolve(); await gate.promise; return { spec: {}, payload: "ok" }; });
    const action = h.request("tool", listTabs);
    await started.promise;
    const handoff = h.request("handoff").then(result => { handedOff = true; return result; });
    assert.equal((await h.request("pause", { controllerId: controller.id })).code, 409);
    assert.equal((await h.request("acquire", { ...controller, id: "controller-b" })).code, 409);
    assert.equal(handedOff, false);
    gate.resolve(); await action;
    assert.equal((await handoff).code, 200);
    assert.equal((await h.request("acquire", controller)).code, 409);
    assert.equal((await h.request("acquire", { ...controller, id: "controller-b" })).code, 200);
    assert.equal((await h.request("release", { controllerId: controller.id })).code, 200);
    assert.equal((await h.request("tool", { ...listTabs, controllerId: "controller-b" })).code, 200);
  } finally { gate.resolve(); await h.close(); }
});

type Reply = { code: number; payload: unknown };
async function canonicalHarness(options: { timeout?: number; observeTimeout?: number; type?: (body: Record<string, unknown>) => Promise<Reply>;
  reply?: (path: string) => Promise<Reply | undefined> | Reply | undefined } = {}) {
  const requests: Array<{ method: string; url: string; authorization?: string; body?: Record<string, unknown> }> = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method!, url: req.url!, authorization: req.headers.authorization,
      body: body ? JSON.parse(body) : undefined });
    const path = new URL(req.url!, "http://localhost").pathname;
    const custom = await options.reply?.(path);
    if (custom) {
      res.writeHead(custom.code, { "Content-Type": "application/json" }).end(JSON.stringify(custom.payload));
    } else if (path.endsWith("/type") && options.type) {
      const response = await options.type(JSON.parse(body));
      res.writeHead(response.code, { "Content-Type": "application/json" }).end(JSON.stringify(response.payload));
    } else if (path.endsWith("/screenshot")) {
      res.writeHead(200, { "Content-Type": "image/png" }).end("fixture-image");
    } else res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const h = await harness("direct", undefined, { expected: "", canonical: true, port: address.port, timeout: options.timeout, observeTimeout: options.observeTimeout });
  return { h, requests, async close() {
    try { await h.close(); }
    finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  } };
}

test("canonical dispatch rejects tab-ID route injection before any HTTP request", async () => {
  const fixture = await canonicalHarness(), { h, requests } = fixture;
  try {
    await h.launch(); await h.create(); await h.request("acquire", controller);
    for (const name of ["tab_click", "tab_close"]) {
      const result = await h.request("tool", { controllerId: controller.id, name, args: { tabId: "../local-profile/stop?ignored=", selector: "#x" } });
      assert.equal(result.code, 409, name);
      assert.match(String((result.payload as { error: string }).error), /tabId/);
    }
    assert.equal((await h.request("tool", { ...listTabs, args: null })).code, 409);
    assert.deepEqual(requests, []);
    assert.equal(h.state().phase, "ready");
    assert.equal((await h.request("tool", listTabs)).code, 200);
    assert.equal(requests.length, 1);
  } finally { await fixture.close(); }
});

test("canonical dispatch preserves valid tool routes, arguments, and authentication", async () => {
  const fixture = await canonicalHarness(), { h, requests } = fixture;
  try {
    await h.launch(); await h.create(); await h.request("acquire", controller);
    const cases: Array<[string, Record<string, unknown>, string, string]> = [
      ["tab_create", { url: "https://example.com" }, "POST", "/tabs"],
      ["tab_list", {}, "GET", "/tabs"],
      ["tab_click", { tabId, selector: "#x", observe: "none" }, "POST", `/tabs/${tabId}/click`],
      ["tab_type", { tabId, selector: "#x", text: "hello", observe: "none" }, "POST", `/tabs/${tabId}/type`],
      ["tab_navigate", { tabId, url: "https://example.com" }, "POST", `/tabs/${tabId}/navigate`],
      ["tab_scroll", { tabId, direction: "down", amount: 100 }, "POST", `/tabs/${tabId}/scroll`],
      ["tab_screenshot", { tabId }, "GET", `/tabs/${tabId}/screenshot`],
      ["tab_close", { tabId }, "DELETE", `/tabs/${tabId}`],
    ];
    for (const [name, args, method, path] of cases) {
      assert.equal((await h.request("tool", { controllerId: controller.id, name, args })).code, 200, name);
      const req = requests.at(-1)!;
      const url = new URL(req.url, "http://localhost");
      assert.equal(req.method, method);
      assert.equal(url.pathname, path);
      assert.equal(req.authorization, "Bearer fixture-key");
      if (method === "POST") {
        // Stelz keeps observe to itself.
        const { tabId: _tabId, observe: _observe, ...body } = args;
        assert.deepEqual(req.body, { ...body, userId: h.id, ...(name === "tab_create" ? { sessionKey: "default" } : {}),
          ...(name === "tab_type" ? { typingMode: "balanced" } : {}) });
      } else assert.equal(url.searchParams.get("userId"), h.id);
    }
    assert.equal(requests.length, cases.length);
  } finally { await fixture.close(); }
});

test("typing overrides reach Camofox per call and profile defaults update in the same lifetime", async () => {
  const fixture = await canonicalHarness(), { h, requests } = fixture;
  const catalog = join(dirname(h.stateDir), "profiles.json");
  const configure = (typingMode: string) => writeFileSync(catalog, JSON.stringify({ profiles: [{ id: h.id, typingMode }] }));
  try {
    await h.launch(); await h.create(); await h.request("acquire", controller);
    const type = (args: Record<string, unknown> = {}) => h.request("tool", { controllerId: controller.id,
      name: "tab_type", args: { tabId, selector: "#message", text: "hello", observe: "none", ...args } });
    const lastBody = () => { const body = requests.at(-1)?.body; if (!body) throw Error("Missing request body"); return body; };
    configure("instant");
    for (const mode of ["balanced", "keyboard", "instant"]) {
      assert.equal((await type({ mode })).code, 200);
      assert.equal(lastBody().typingMode, mode);
      assert.equal(Object.hasOwn(lastBody(), "mode"), false, "Do not collide with Camofox's REST mode");
    }
    assert.equal((await type()).code, 200);
    assert.equal(lastBody().typingMode, "instant", "Overrides must not persist to the next call");
    configure("keyboard");
    assert.equal((await type()).code, 200);
    assert.equal(lastBody().typingMode, "keyboard");
    assert.equal(h.state().phase, "ready");
  } finally { await fixture.close(); }
});

test("the upstream typing timeout reaches the service as a terminal block", async () => {
  const route = upstreamTyping(async () => { throw Error("Keyboard timed out after 45000ms"); });
  const fixture = await canonicalHarness({ type: route.call }), { h, requests } = fixture;
  try {
    await h.launch(); await h.create(); await h.request("acquire", controller);
    const type = { controllerId: controller.id, name: "tab_type",
      args: { tabId, selector: "#message", text: "hello", mode: "keyboard", pressEnter: true } };
    const response = await h.request("tool", type);
    assert.equal(response.code, 409);
    assert.match(String((response.payload as { error: string }).error), /Typing timeout/);
    assert.equal(h.state().phase, "blocked");
    assert.equal((await h.request("tool", type)).code, 409);
    assert.equal(requests.length, 1);
    assert.deepEqual(route.events, []);
    assert.equal(route.refreshes(), 0);
  } finally { await fixture.close(); }
});

const evaluateTimeout = { error: "action timed out after 1000ms; the tab was kept and the script may still be running in the page",
  code: "evaluate_timeout", retryable: false, tabKept: true };
const allowScripts = (h: { id: string; stateDir: string }) =>
  writeFileSync(join(dirname(h.stateDir), "profiles.json"), JSON.stringify({ profiles: [{ id: h.id, allowScripts: true }] }));

test("an upstream evaluate timeout is a clean error that keeps the profile ready", async () => {
  const fixture = await canonicalHarness({ reply: path => path.endsWith("/evaluate") ? { code: 504, payload: evaluateTimeout } : undefined }), { h, requests } = fixture;
  try {
    allowScripts(h);
    await h.launch(); await h.create(); await h.request("acquire", controller);
    const evaluate = { controllerId: controller.id, name: "tab_evaluate", args: { tabId, expression: "while (true) {}", timeoutMs: 1000 } };
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await h.request("tool", evaluate);
      assert.equal(result.code, 409);
      const message = String((result.payload as { error: string }).error);
      assert.match(message, /may still run in the page/);
      assert.match(message, /Read a snapshot/);
      assert.match(message, /Do not run the script again/);
      assert.equal(h.state().phase, "ready");
      assert.equal(h.state().error, undefined);
    }
    assert.deepEqual(requests[0]!.body, { userId: h.id, expression: "while (true) {}", timeoutMs: 1000 });
    assert.equal((await h.request("tool", listTabs)).code, 200);
    assert.equal(requests.length, 3);
  } finally { await fixture.close(); }
});

test("other upstream timeouts still block the browser lifetime", async () => {
  const bodies: Array<[string, Reply]> = [
    ["/evaluate", { code: 504, payload: { error: "action timed out after 1000ms", retryable: false } }],
    ["/evaluate", { code: 504, payload: { ...evaluateTimeout, code: "another_timeout" } }],
    ["/evaluate", { code: 500, payload: { error: "timeout", code: "evaluate_timeout" } }],
    ["/click", { code: 504, payload: { error: "Timeout 30000ms exceeded", code: "evaluate_timeout" } }],
  ];
  for (const [suffix, response] of bodies) {
    const fixture = await canonicalHarness({ reply: path => path.endsWith(suffix) ? response : undefined }), { h } = fixture;
    try {
      allowScripts(h);
      await h.launch(); await h.create(); await h.request("acquire", controller);
      const call = suffix === "/click" ? { name: "tab_click", args: { tabId, selector: "#x" } } : { name: "tab_evaluate", args: { tabId, expression: "1" } };
      const result = await h.request("tool", { controllerId: controller.id, ...call });
      assert.equal(result.code, 409, JSON.stringify(response));
      if (suffix === "/click") assert.doesNotMatch(String((result.payload as { error: string }).error), /Do not run the script again/);
      assert.equal(h.state().phase, "blocked", JSON.stringify(response));
      assert.equal((await h.request("tool", listTabs)).code, 409);
    } finally { await fixture.close(); }
  }
});

test("the service deadline of an evaluate still blocks the browser lifetime", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fixture = await canonicalHarness({ timeout: 40, reply: async path => path.endsWith("/evaluate") ? (await gate, { code: 200, payload: { ok: true } }) : undefined }), { h } = fixture;
  try {
    allowScripts(h);
    await h.launch(); await h.create(); await h.request("acquire", controller);
    const result = await h.request("tool", { controllerId: controller.id, name: "tab_evaluate", args: { tabId, expression: "1", timeoutMs: 1000 } });
    assert.equal(result.code, 409);
    assert.match(String((result.payload as { error: string }).error), /time limit/);
    assert.doesNotMatch(String((result.payload as { error: string }).error), /Do not run the script again/);
    assert.equal(h.state().phase, "blocked");
  } finally { release(); await fixture.close(); }
});

test("the service deadline prevents overlap while the upstream typing lock remains held", async () => {
  let finish!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const route = upstreamTyping(async () => { entered(); await gate; });
  const fixture = await canonicalHarness({ type: route.call, timeout: 40 }), { h, requests } = fixture;
  try {
    await h.launch(); await h.create(); await h.request("acquire", controller);
    const type = { controllerId: controller.id, name: "tab_type",
      args: { tabId, selector: "#message", text: "hello", mode: "keyboard" } };
    const action = h.request("tool", type);
    await started;
    await route.advance(30_001);
    assert.equal((await action).code, 409);
    assert.equal(h.state().phase, "blocked");
    assert.equal((await h.request("tool", type)).code, 409);
    assert.equal(requests.length, 1);
    finish();
    await route.advance(0);
    assert.equal(h.state().phase, "blocked");
  } finally { finish(); await fixture.close(); }
});

for (const [serviceMode, profileMode, expected, fallback] of [
  [undefined, undefined, "keyboard", "keyboard"],
  ["instant", undefined, "instant", "instant"],
  ["keyboard", undefined, "keyboard", "keyboard"],
  ["instant", "balanced", "balanced", "instant"],
] as const) test(`typing dispatch uses ${expected} with service ${serviceMode ?? "unset"} and profile ${profileMode ?? "unset"}`, async () => {
  const fixture = await canonicalHarness(), { h, requests } = fixture;
  const previous = process.env.STELZ_TYPING_MODE;
  try {
    if (serviceMode === undefined) delete process.env.STELZ_TYPING_MODE;
    else process.env.STELZ_TYPING_MODE = serviceMode;
    writeFileSync(join(dirname(h.stateDir), "profiles.json"), JSON.stringify({ profiles: [
      { id: h.id, ...(profileMode === undefined ? {} : { typingMode: profileMode }) },
    ] }));
    await h.launch(); await h.create(); await h.request("acquire", controller);
    const result = await h.request("tool", { controllerId: controller.id, name: "tab_type",
      args: { tabId, selector: "#message", text: "hello", observe: "none" } });
    assert.equal(result.code, 200);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0]!.body, { selector: "#message", text: "hello", userId: h.id, typingMode: expected });
    assert.equal(((await h.request("status")).payload as { typingModeDefault: string }).typingModeDefault, fallback);
  } finally {
    if (previous === undefined) delete process.env.STELZ_TYPING_MODE;
    else process.env.STELZ_TYPING_MODE = previous;
    await fixture.close();
  }
});

for (const interval of [0, 120_000]) test(`IP interval ${interval} bounds checks for 100 queued browser actions`, async () => {
  const h = await harness("proxy", undefined, { interval, now: () => 100 });
  try {
    await h.launch(); await h.create(); await h.request("acquire", controller);
    const actions = await Promise.all(Array.from({ length: 100 }, () => h.request("tool", listTabs)));
    assert.ok(actions.every(action => action.code === 200));
    assert.equal(h.checks(), interval === 0 ? 101 : 1);
    assert.equal(((await h.request("status")).payload as { verificationIntervalMs: number }).verificationIntervalMs, interval);
  } finally { await h.close(); }
});

test("expiry refreshes once for queued actions and a clock rollback forces a fresh check", async () => {
  let clock = 100;
  const h = await harness("proxy", undefined, { interval: 120_000, now: () => clock });
  try {
    await h.launch(); await h.create(); await h.request("acquire", controller);
    clock = 120_099;
    assert.equal((await h.request("tool", listTabs)).code, 200);
    assert.equal(h.checks(), 1);
    clock = 120_100;
    const actions = await Promise.all(Array.from({ length: 5 }, () => h.request("tool", listTabs)));
    assert.ok(actions.every(action => action.code === 200)); assert.equal(h.checks(), 2);
    clock = 1;
    assert.equal((await h.request("tool", listTabs)).code, 200);
    assert.equal(h.checks(), 3);
  } finally { await h.close(); }
});

test("verification status is separate from lifecycle phase and cache freshness", async () => {
  let clock = 0;
  const h = await harness("proxy", undefined, { interval: 120_000, now: () => clock });
  try {
    assert.equal(h.state().verificationStatus, "unverified");
    assert.equal(h.state().verificationRequired, true);
    await h.launch(); await h.create();
    const verified = (await h.request("status")).payload as Record<string, unknown>;
    assert.equal(verified.phase, "ready");
    assert.equal(verified.verificationStatus, "verified");
    assert.equal(verified.verificationFresh, true);
    clock = 120_000;
    const expired = (await h.request("status")).payload as Record<string, unknown>;
    assert.equal(expired.verificationStatus, "verified");
    assert.equal(expired.verificationFresh, false);
    assert.equal(h.checks(), 1);
    h.setIP("203.0.113.7");
    assert.equal((await h.request("check")).code, 409);
    const failed = (await h.request("status")).payload as Record<string, unknown>;
    assert.equal(failed.verificationStatus, "verification_failed");
    assert.equal(failed.verificationFresh, false);
    h.setIP("198.51.100.10");
    assert.equal((await h.request("check")).code, 200);
    assert.equal(h.state().verificationStatus, "verified");
  } finally { await h.close(); }
});

test("a mismatched exit after 100 cached actions blocks every subsequent action", async () => {
  let clock = 0, dispatched = 0;
  const h = await harness("proxy", undefined, { interval: 120_000, now: () => clock });
  try {
    await h.launch(); await h.create(); await h.request("acquire", controller);
    h.setTool(async () => { dispatched++; return { spec: {}, payload: "ok" }; });
    h.setIP("203.0.113.7");
    for (let action = 0; action < 100; action++) assert.equal((await h.request("tool", listTabs)).code, 200);
    assert.equal(h.checks(), 1); assert.equal(dispatched, 100);
    clock = 120_000;
    const actions = await Promise.all(Array.from({ length: 5 }, () => h.request("tool", listTabs)));
    assert.ok(actions.every(action => action.code === 409));
    assert.equal(h.checks(), 2); assert.equal(dispatched, 100);
    assert.equal(h.state().verificationStatus, "verification_failed");
    assert.equal(h.state().phase, "verification_failed");
    assert.match(h.state().checkFailure!, /does not match/);
    h.setIP("198.51.100.10");
    assert.equal((await h.request("tool", listTabs)).code, 409);
    assert.equal(h.checks(), 2);
  } finally { await h.close(); }
});

test("recheck and resume bypass the cache and verification failure stays latched", async () => {
  const h = await harness("proxy", undefined, { interval: 120_000, now: () => 100 });
  try {
    await h.launch(); await h.create(); await h.request("acquire", controller);
    assert.equal((await h.request("check")).code, 200); assert.equal(h.checks(), 2);
    assert.equal((await h.request("pause")).code, 200);
    assert.equal((await h.request("tool", listTabs)).code, 409);
    assert.equal((await h.request("resume")).code, 200); assert.equal(h.checks(), 3);
    h.setIP("203.0.113.7");
    assert.equal((await h.request("check")).code, 409);
    const failedChecks = h.checks();
    h.setIP("198.51.100.10");
    assert.equal((await h.request("tool", listTabs)).code, 409);
    assert.equal(h.checks(), failedChecks);
    assert.equal((await h.request("check")).code, 200);
    assert.equal((await h.request("tool", listTabs)).code, 200);
    assert.equal(h.checks(), failedChecks + 1);
  } finally { await h.close(); }
});

test("a fresh cache cannot permit actions after the original browser is lost", async () => {
  const h = await harness("proxy", undefined, { interval: 120_000, now: () => 100 });
  try {
    await h.launch(); await h.create(); await h.request("acquire", controller);
    await h.emit("session:destroying", { userId: h.id });
    assert.equal((await h.request("tool", listTabs)).code, 409);
    assert.equal(h.checks(), 1);
  } finally { await h.close(); }
});

for (const diagnostic of [
  "page.goto: NS_ERROR_PROXY_CONNECTION_REFUSED at https://example.invalid/",
  "page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://example.invalid/",
]) test(`a browser network failure bypasses a fresh cache and blocks a mismatched exit: ${diagnostic}`, async () => {
  const h = await harness("proxy", undefined, { interval: 120_000, now: () => 0 });
  let dispatched = 0;
  try {
    await h.launch(); await h.create(); await h.request("acquire", controller);
    h.setIP("203.0.113.7");
    h.setTool(async () => { dispatched++; throw Error(`500: ${JSON.stringify({ error: diagnostic, retryable: false })}`); });
    assert.equal((await h.request("tool", listTabs)).code, 409);
    assert.equal(h.checks(), 2); assert.equal(dispatched, 1);
    assert.equal(h.state().verificationStatus, "verification_failed");
    assert.equal((await h.request("tool", listTabs)).code, 409);
    assert.equal(h.checks(), 2); assert.equal(dispatched, 1);
  } finally { await h.close(); }
});

test("network recovery shares the action queue, exposes unverified status, and never replays an action", async () => {
  const h = await harness("proxy", undefined, { interval: 120_000, now: () => 0 });
  let finish!: () => void, dispatched = 0;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  try {
    await h.launch(); await h.create(); await h.request("acquire", controller);
    h.setIPGate(gate);
    h.setTool(async () => { dispatched++; throw Error("page.goto: NS_ERROR_NET_RESET at https://example.invalid/"); });
    const failed = h.request("tool", listTabs);
    for (let attempt = 0; h.checks() < 2 && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(h.checks(), 2);
    const during = (await h.request("status")).payload as Record<string, unknown>;
    assert.equal(during.verificationStatus, "unverified"); assert.equal(during.verificationFresh, false);
    assert.equal(during.phase, "ready");
    const queued = h.request("tool", listTabs);
    assert.equal(dispatched, 1);
    h.setTool(async () => { dispatched++; return { spec: {}, payload: "ok" }; });
    finish();
    assert.equal((await failed).code, 409); assert.equal((await queued).code, 200);
    assert.equal(dispatched, 2); assert.equal(h.checks(), 2);
    assert.equal(h.state().verificationStatus, "verified");
  } finally { finish(); await h.close(); }
});

test("a structured network error in a successful upstream response also invalidates verification", async () => {
  const h = await harness("proxy", undefined, { interval: 120_000, now: () => 0 });
  try {
    await h.launch(); await h.create(); await h.request("acquire", controller);
    h.setTool(async () => ({ spec: {}, payload: { error: "page.goto: NS_ERROR_PROXY_BAD_GATEWAY at https://example.invalid/" } }));
    h.setIPError("offline");
    assert.equal((await h.request("tool", listTabs)).code, 409);
    assert.equal(h.state().verificationStatus, "verification_failed");
    assert.equal((await h.request("tool", listTabs)).code, 409);
  } finally { await h.close(); }
});

test("page content, URLs, call logs, HTTP errors, and validation errors do not trigger IP checks", async () => {
  const h = await harness("proxy", undefined, { interval: 120_000, now: () => 0 });
  try {
    await h.launch(); await h.create(); await h.request("acquire", controller);
    h.setTool(async () => ({ spec: {}, payload: { snapshot: "NS_ERROR_PROXY_CONNECTION_REFUSED", url: "https://example.invalid/NS_ERROR_UNKNOWN_HOST" } }));
    assert.equal((await h.request("tool", listTabs)).code, 200);
    for (const message of [
      "500: An HTML body contains NS_ERROR_PROXY_CONNECTION_REFUSED",
      `500: ${JSON.stringify({ error: "Destination returned HTTP 503", code: "destination_unavailable" })}`,
      "page.goto: Invalid URL https://example.invalid/NS_ERROR_UNKNOWN_HOST",
      "Invalid selector\nCall log:\n  NS_ERROR_PROXY_CONNECTION_REFUSED",
    ]) {
      h.setTool(async () => { throw Error(message); });
      assert.equal((await h.request("tool", listTabs)).code, 409);
    }
    assert.equal(h.checks(), 1); assert.equal(h.state().phase, "ready");
    assert.equal(h.state().verificationStatus, "verified");
  } finally { await h.close(); }
});

test("direct mode without an expected IP does not acquire a health-check dependency after network failure", async () => {
  const h = await harness("direct", undefined, { interval: 120_000, expected: "" });
  try {
    await h.launch(); await h.create(); await h.request("acquire", controller);
    h.setTool(async () => { throw Error("page.goto: NS_ERROR_UNKNOWN_HOST at https://example.invalid/"); });
    assert.equal((await h.request("tool", listTabs)).code, 409);
    assert.equal(h.checks(), 0); assert.equal(h.state().phase, "ready");
  } finally { await h.close(); }
});

test("direct mode without an expected IP works when the IP service is unavailable", async () => {
  const h = await harness("direct", undefined, { expected: "", ipError: "offline" });
  try {
    await h.launch();
    await h.create();
    assert.equal((await h.request("acquire", controller)).code, 200);
    assert.equal((await h.request("tool", listTabs)).code, 200);
    assert.equal((await h.request("pause")).code, 200);
    assert.equal((await h.request("resume")).code, 200);
    assert.equal(h.checks(), 0);
    assert.equal(h.state().verificationStatus, "unverified");
    assert.equal(h.state().verificationRequired, false);
  } finally { await h.close(); }
});

test("direct mode checks an explicitly expected IP and reports failure without proxy fallback wording", async () => {
  const h = await harness("direct");
  try {
    await h.launch(); await h.create();
    await h.request("acquire", controller);
    h.setIP("203.0.113.7");
    assert.equal((await h.request("tool", listTabs)).code, 409);
    assert.equal(h.state().phase, "verification_failed");
    assert.match(h.state().error!, /Expected exit IP/);
    assert.doesNotMatch(h.state().error!, /proxy|fallback/i);
    h.setIP("198.51.100.10");
    assert.equal((await h.request("check")).code, 200);
    assert.equal((await h.request("tool", listTabs)).code, 200);
  } finally { await h.close(); }
});

test("proxy mode verifies its exit even without an expected IP", async () => {
  const h = await harness("proxy", undefined, { expected: "" });
  try {
    await h.launch(); await h.create();
    assert.equal(h.checks(), 1);
    await h.request("acquire", controller);
    h.setIPError("offline");
    assert.equal((await h.request("tool", listTabs)).code, 409);
    assert.equal(h.state().phase, "verification_failed");
    assert.match(h.state().error!, /Proxy exit IP/);
    assert.match(h.state().error!, /Direct fallback is disabled/);
  } finally { await h.close(); }
});

test("a startup IP failure closes only its attempt and denies acquisition", async () => {
  const h = await harness("proxy", undefined, { ipError: "network unavailable" });
  try {
    await h.launch();
    await assert.rejects(h.create(), /browser exit IP check failed/);
    assert.equal(h.state().phase, "blocked");
    assert.equal(h.shutdowns(), 1);
    assert.equal((await h.request("acquire", controller)).code, 409);
    const failure = JSON.parse(readFileSync(join(h.stateDir, "location.json"), "utf8")).result;
    assert.equal(failure.phase, "browser_verification");
    assert.equal(failure.code, "BROWSER_IP_FAILED");
    assert.equal(failure.browserStarted, true);
  } finally { await h.close(); }
});

test("a proxied fingerprint failure preserves the unchecked browser location result", async () => {
  const h = await harness("proxy", undefined, { fingerprintError: "Runtime fingerprint geometry differs" });
  try {
    const before = readFileSync(join(h.stateDir, "location.json"), "utf8");
    await h.launch();
    await assert.rejects(h.create(), /fingerprint geometry differs/);
    assert.equal(readFileSync(join(h.stateDir, "location.json"), "utf8"), before);
    assert.equal(JSON.parse(before).result.browser, "not_checked");
    assert.match(h.state().error!, /fingerprint geometry differs/);
    assert.equal(h.state().phase, "blocked");
    assert.equal(existsSync(join(h.stateDir, "fingerprint.json")), false);
    assert.equal((await h.request("acquire", controller)).code, 409);
  } finally { await h.close(); }
});

test("an IP failure during resume preserves the pause after recheck", async () => {
  const h = await harness("proxy");
  try {
    await h.launch();
    await h.create();
    await h.request("pause");
    h.setIPError("offline");
    assert.equal((await h.request("resume")).code, 409);
    assert.equal(h.state().phase, "verification_failed");
    h.setIPError(undefined);
    assert.equal((await h.request("check")).code, 200);
    assert.equal(h.state().phase, "paused");
    assert.equal((await h.request("resume")).code, 200);
  } finally { await h.close(); }
});

test("service rejects held, excluded, upstream-named, and unknown tools", async () => {
  const h = await harness("direct", undefined, { expected: "" });
  let dispatched = 0;
  try {
    await h.launch();
    await h.create();
    await h.request("acquire", controller);
    h.setTool(async () => { dispatched++; return { spec: {}, payload: "ok" }; });
    for (const name of ["tab_activate", "camofox_snapshot", "camofox_evaluate", "tab_upload", "tab_unknown", ""]) {
      const result = await h.request("tool", { ...listTabs, name });
      assert.equal(result.code, 409, name);
      assert.match(String((result.payload as { error: string }).error), /Unknown browser tool/);
    }
    assert.equal(dispatched, 0);
    assert.equal((await h.request("tool", listTabs)).code, 200);
    assert.equal(dispatched, 1);
  } finally { await h.close(); }
});

test("a scripts tool needs the profile switch, and the service reads it on each call", async () => {
  const h = await harness("direct", undefined, { expected: "" });
  const catalog = join(dirname(h.stateDir), "profiles.json");
  const configure = (allowScripts?: boolean) => writeFileSync(catalog, JSON.stringify({ profiles: [{ id: h.id, ...(allowScripts === undefined ? {} : { allowScripts }) }] }));
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const scripts = { tab_evaluate: { tabId, expression: "1+1" }, tab_init_script: { tabId, script: "window.x = 1" } } as const;
  try {
    await h.launch(); await h.create(); await h.request("acquire", controller);
    h.setTool(async (name, args) => { calls.push({ name, args }); return { spec: {}, payload: { ok: true } }; });
    for (const state of [undefined, false, "yes", 1] as const) {
      configure(state as boolean | undefined);
      for (const [name, args] of Object.entries(scripts)) {
        const result = await h.request("tool", { controllerId: controller.id, name, args });
        assert.equal(result.code, 409, `${name} with ${String(state)}`);
        const message = String((result.payload as { error: string }).error);
        assert.match(message, new RegExp(`stelz profile config ${h.id} --allow-scripts`));
        assert.match(message, /UI/);
      }
    }
    assert.equal(calls.length, 0);
    assert.equal(h.state().phase, "ready");
    configure(true);
    for (const [name, args] of Object.entries(scripts)) assert.equal((await h.request("tool", { controllerId: controller.id, name, args })).code, 200, name);
    assert.deepEqual(calls.map(call => call.name), ["camofox_evaluate", "camofox_init_script"]);
    configure(false);
    assert.equal((await h.request("tool", { controllerId: controller.id, name: "tab_evaluate", args: scripts.tab_evaluate })).code, 409);
    assert.equal(calls.length, 2);
    // Other tools never need the switch.
    assert.equal((await h.request("tool", listTabs)).code, 200);
    // A profile that left the catalog fails closed.
    writeFileSync(catalog, JSON.stringify({ profiles: [] }));
    assert.equal((await h.request("tool", { controllerId: controller.id, name: "tab_evaluate", args: scripts.tab_evaluate })).code, 409);
    assert.equal(calls.length, 3);
  } finally { await h.close(); }
});

test("the service returns the raw payload and its response kind", async () => {
  const h = await harness("direct", undefined, { expected: "" });
  try {
    await h.launch(); await h.create(); await h.request("acquire", controller);
    const shots = { url: "https://example.test/", snapshot: "- heading \"Title\" [e1]", refsCount: 1, truncated: false, nextOffset: null, screenshot: { data: "aW1n", mimeType: "image/png" } };
    for (const [spec, payload, kind] of [[{}, { ok: true }, "json"], [{ responseKind: "json" }, [1, 2], "json"], [{ responseKind: "snapshot" }, shots, "snapshot"],
      [{ responseKind: "image" }, { type: "image", data: "aW1n", mimeType: "image/png" }, "image"]] as const) {
      h.setTool(async () => ({ spec, payload }));
      const result = await h.request("tool", listTabs);
      assert.equal(result.code, 200);
      assert.deepEqual(result.payload, { kind, payload });
      assert.equal(Object.hasOwn(result.payload as object, "content"), false);
    }
  } finally { await h.close(); }
});

// A tool call that enters and then waits for `finish`.
function stall() {
  const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<unknown>();
  const stalled = { calls: 0, started: entered.promise, finish: (value: unknown = { spec: {}, payload: "done" }) => gate.resolve(value),
    tool: async () => { stalled.calls++; entered.resolve(); return gate.promise; } };
  return stalled;
}

test("a stalled action times out but retains control until underlying work settles", async () => {
  const h = await harness("direct", undefined, { expected: "", timeout: 40 }), s = stall();
  try {
    await h.launch();
    await h.create();
    await h.request("acquire", controller);
    h.setTool(s.tool);
    const action = h.request("tool", listTabs);
    await s.started;
    const queued = h.request("tool", listTabs);
    let released = false;
    const release = h.request("release", { controllerId: controller.id }).then(result => { released = true; return result; });
    assert.equal((await action).code, 409);
    assert.equal((await queued).code, 409);
    assert.equal(released, false);
    assert.equal(s.calls, 1);
    assert.equal(h.state().phase, "blocked");
    assert.equal((await h.request("acquire", { ...controller, id: "controller-b" })).code, 409);
    assert.equal((await h.request("check")).code, 409);
    s.finish({ spec: {}, payload: "late" });
    assert.equal((await release).code, 200);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(h.state().phase, "blocked");
  } finally { s.finish(); await h.close(); }
});

test("pause refuses to acknowledge human takeover when an upstream action remains uncertain", async () => {
  const h = await harness("direct", undefined, { expected: "", timeout: 40 }), s = stall();
  try {
    await h.launch();
    await h.create();
    await h.request("acquire", controller);
    h.setTool(s.tool);
    const action = h.request("tool", listTabs);
    await s.started;
    const pause = h.request("pause");
    assert.equal((await action).code, 409);
    assert.equal((await pause).code, 409);
    assert.equal(h.state().phase, "blocked");
  } finally { s.finish(); await h.close(); }
});

test("stop finishes when an upstream action stalls", async () => {
  const h = await harness("direct", undefined, { expected: "", timeout: 40 }), s = stall();
  try {
    await h.launch();
    await h.create();
    await h.request("acquire", controller);
    h.setTool(s.tool);
    const action = h.request("tool", listTabs);
    await s.started;
    const stop = h.request("stop");
    assert.equal((await action).code, 409);
    assert.equal((await stop).code, 200);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(h.shutdowns(), 1);
  } finally { s.finish(); await h.close(); }
});

test("a stalled IP check cannot be cleared while its browser operation is outstanding", async () => {
  const h = await harness("proxy", undefined, { timeout: 40 });
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  try {
    await h.launch();
    await h.create();
    await h.request("acquire", controller);
    h.setIPGate(gate);
    assert.equal((await h.request("tool", listTabs)).code, 409);
    assert.equal(h.state().phase, "blocked");
    assert.equal((await h.request("check")).code, 409);
    finish();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(h.state().phase, "blocked");
  } finally { finish(); await h.close(); }
});

test("an explicit recheck waits for the active browser action", async () => {
  const h = await harness("proxy"), s = stall();
  try {
    await h.launch();
    await h.create();
    await h.request("acquire", controller);
    h.setTool(s.tool);
    const action = h.request("tool", listTabs);
    await s.started;
    const before = h.checks();
    const recheck = h.request("check");
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(h.checks(), before);
    s.finish();
    assert.equal((await action).code, 200);
    assert.equal((await recheck).code, 200);
    assert.equal(h.checks(), before + 1);
  } finally { s.finish(); await h.close(); }
});

test("initial browser location mismatch closes the attempt and persists its specific failure", async () => {
  const h = await harness("proxy", undefined, { observedTimezone: "Europe/London" });
  try {
    await h.launch(); await assert.rejects(h.create(), /browser location/);
    const failure = JSON.parse(readFileSync(join(h.stateDir, "location.json"), "utf8"));
    assert.equal(failure.result.code, "BROWSER_LOCATION_MISMATCH"); assert.equal(failure.result.browserStarted, true);
    assert.equal((await h.request("acquire", controller)).code, 409);
    assert.equal(h.state().phase, "blocked");
  } finally { await h.close(); }
});
test("a startup verification deadline closes its attempt and a late reply cannot make it ready", async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const h = await harness("proxy", gate, { timeout: 40 });
  try {
    await h.launch(); await assert.rejects(h.create(), /time limit/);
    release(); await new Promise(resolve => setTimeout(resolve, 50));
    const failure = JSON.parse(readFileSync(join(h.stateDir, "location.json"), "utf8"));
    assert.equal(failure.result.status, "blocked"); assert.equal(failure.result.browserStarted, true);
    assert.equal((await h.request("acquire", controller)).code, 409);
    assert.equal(h.state().phase, "blocked");
  } finally { release(); await h.close(); }
});

// The snapshot path reads the full page from the tab state of Camofox, in the same queued action as the snapshot route.
// The fake route does what the real one does: it rebuilds the refs and the last snapshot of the tab, and then it replies.
async function snapshotFixture(options: { structure?: unknown; timeout?: number; observeTimeout?: number } = {}) {
  // `act` answers the routes of the actions, and `snapshot` can change the page or fail a snapshot route. Both start unset.
  const state = { page: annotate(shop()), shot: undefined as unknown, route: 0,
    act: undefined as ((path: string, body: Record<string, unknown> | undefined) => Reply | Promise<Reply> | undefined) | undefined, delay: 0,
    snapshot: undefined as ((route: number) => Reply | Promise<Reply> | undefined) | undefined };
  const tab = { refs: new Map<string, unknown>(), lastSnapshot: null as unknown, page: { url: () => "https://shop.test/" } };
  const fixture = await canonicalHarness({ reply: path => {
    if (!path.endsWith("/snapshot")) return state.act?.(path, fixture.requests.at(-1)!.body);
    state.route++;
    const custom = state.snapshot?.(state.route);
    if (custom) return custom;
    tab.refs = new Map(state.page.refs); tab.lastSnapshot = state.page.yaml;
    const asked = new URL(fixture.requests.at(-1)!.url, "http://localhost").searchParams.get("includeScreenshot") === "true";
    const answer = { code: 200, payload: { url: "https://shop.test/", snapshot: state.page.yaml.slice(0, 80_000), structure: options.structure, refsCount: state.page.refs.size,
      truncated: false, totalChars: state.page.yaml.length, hasMore: false, nextOffset: null, ...(asked ? { screenshot: state.shot } : {}) } };
    return state.delay ? new Promise<Reply>(resolve => setTimeout(() => resolve(answer), state.delay)) : answer;
  }, timeout: options.timeout, observeTimeout: options.observeTimeout });
  const { h, requests } = fixture;
  h.sessions.set(h.id, { tabGroups: new Map([["default", new Map([[tabId, tab]])]]) });
  const as = (controllerId: string) => (name: string, args: Record<string, unknown> = {}) => h.request("tool", { controllerId, name, args: { tabId, ...args } });
  return { ...fixture, state, tab, h, requests, read: as(controller.id), as,
    async start() { await h.launch(); await h.create(); assert.equal((await h.request("acquire", controller)).code, 200); } };
}
const payloadOf = (result: { code: number; payload: unknown }) => {
  assert.equal(result.code, 200, JSON.stringify(result.payload));
  return (result.payload as { kind: string; payload: Record<string, any> }).payload;
};
const errorOf = (result: { code: number; payload: unknown }) => {
  assert.equal(result.code, 409);
  return String((result.payload as { error: string }).error);
};

test("tab_snapshot asks for no screenshot unless the caller wants one, and reads the full page from the tab state", async () => {
  const f = await snapshotFixture({ structure: { forms: [], tables: [{ id: "table-0" }] } });
  try {
    await f.start();
    const first = await f.read("tab_snapshot");
    assert.equal(first.code, 200);
    assert.equal((first.payload as { kind: string }).kind, "snapshot");
    const reply = payloadOf(first);
    assert.deepEqual(Object.keys(reply), ["url", "refsCount", "truncated", "viewId", "snapshot"]);
    assert.match(reply.snapshot, /- … 11 more like this/);
    assert.equal(reply.refsCount, f.state.page.refs.size);
    const route = new URL(f.requests.at(-1)!.url, "http://localhost");
    assert.equal(f.requests.length, 1);
    assert.equal(route.pathname, `/tabs/${tabId}/snapshot`);
    assert.equal(route.searchParams.get("includeScreenshot"), "false");
    assert.equal(route.searchParams.get("userId"), f.h.id);
    assert.equal(route.searchParams.has("offset"), false);
    assert.equal(route.searchParams.has("annotateScreenshot"), false);
    assert.equal(f.requests.at(-1)!.authorization, "Bearer fixture-key");
    // The structure is dropped unless the caller asks for it. The screenshot is sent when the caller asks for it.
    assert.equal(Object.hasOwn(reply, "structure"), false);
    f.state.shot = { data: "aW1n", mimeType: "image/png" };
    const more = payloadOf(await f.read("tab_snapshot", { includeScreenshot: true, includeStructure: true }));
    assert.equal(new URL(f.requests.at(-1)!.url, "http://localhost").searchParams.get("includeScreenshot"), "true");
    assert.deepEqual(more.screenshot, { data: "aW1n", mimeType: "image/png" });
    assert.deepEqual(more.structure, { forms: [], tables: [{ id: "table-0" }] });
    assert.equal(Object.hasOwn(payloadOf(await f.read("tab_snapshot")), "screenshot"), false);
  } finally { await f.close(); }
});

test("the shaping arguments reach the view, and a scope that fails is an error", async () => {
  const f = await snapshotFixture();
  try {
    await f.start();
    assert.equal(payloadOf(await f.read("tab_snapshot", { scope: { role: "contentinfo" } })).snapshot, "- contentinfo:\n  - text: © Shop");
    assert.match(payloadOf(await f.read("tab_snapshot", { contains: "lamp 7", collapse: false })).snapshot, /^- main:\n {2}- list "Results":/);
    assert.match(errorOf(await f.read("tab_snapshot", { scope: { role: "list" } })), /The scope matches 2 elements/);
    assert.match(errorOf(await f.read("tab_snapshot", { scope: { role: "table" } })), /No element matches the scope/);
    assert.match(errorOf(await f.read("tab_snapshot", { maxChars: 100 })), /maxChars must be/);
  } finally { await f.close(); }
});

test("the baseline belongs to one controller, and acquire, release, and resume clear it", async () => {
  const f = await snapshotFixture();
  const b = { id: "controller-b", pid: process.pid, label: "test" };
  const diff = { diff: true, collapse: false };
  try {
    await f.start();
    assert.equal(payloadOf(await f.read("tab_snapshot", diff)).baseline, true);
    f.state.page = annotate(shop({ change: { 5: 30 } }));
    const second = payloadOf(await f.read("tab_snapshot", diff));
    assert.equal(Object.hasOwn(second, "baseline"), false);
    assert.match(second.snapshot, /^# Diff from your last snapshot/);
    assert.match(second.snapshot, /\n\+ {6}- text: \$35$/);
    assert.equal(payloadOf(await f.read("tab_snapshot", diff)).snapshot, "# No change since your last snapshot.");
    // Resume clears it, because a person used the window during the pause.
    assert.equal((await f.h.request("pause", { controllerId: controller.id })).code, 200);
    assert.equal((await f.h.request("resume", { controllerId: controller.id })).code, 200);
    assert.equal(payloadOf(await f.read("tab_snapshot", diff)).baseline, true);
    assert.equal(payloadOf(await f.read("tab_snapshot", diff)).snapshot, "# No change since your last snapshot.");
    // Release clears it, and the next controller starts empty.
    assert.equal((await f.h.request("release", { controllerId: controller.id })).code, 200);
    assert.equal((await f.h.request("acquire", b)).code, 200);
    assert.equal(payloadOf(await f.as(b.id)("tab_snapshot", diff)).baseline, true);
    assert.equal(payloadOf(await f.as(b.id)("tab_snapshot", diff)).snapshot, "# No change since your last snapshot.");
    // The first controller acquires again. It starts empty, although it read the same page before.
    assert.equal((await f.h.request("release", { controllerId: b.id })).code, 200);
    assert.equal((await f.h.request("acquire", { ...controller, id: "controller-c" })).code, 200);
    assert.equal(payloadOf(await f.as("controller-c")("tab_snapshot", diff)).baseline, true);
  } finally { await f.close(); }
});

test("the guard refuses a ref before any request, accepts a ref that a reply showed, and does not check a selector", async () => {
  const f = await snapshotFixture();
  try {
    await f.start();
    const reply = payloadOf(await f.read("tab_snapshot"));
    const shown = [...reply.snapshot.matchAll(/\[(e\d+)\]/g)].map(match => match[1]);
    assert.ok(shown.includes("e7") && !shown.includes("e9"));
    const requests = f.requests.length;
    const refusal = (ref: string) => `ref ${ref} may have shifted. Read tab_snapshot again, or target the element by role and name.`;
    for (const name of ["tab_click", "tab_type", "tab_select", "tab_mouse_wheel"]) {
      // e9 is a collapsed item. The controller never saw it. e999 does not exist.
      for (const ref of ["e9", "e999"]) assert.equal(errorOf(await f.read(name, { ref, ...(name === "tab_type" ? { text: "x" } : {}) })), refusal(ref), `${name} ${ref}`);
    }
    // No request reached Camofox, and the profile stays usable.
    assert.equal(f.requests.length, requests);
    assert.equal(f.h.state().phase, "ready");
    // A shown ref passes. The ref is checked again at the call: a rebuilt ref table that moved e7 makes it unsafe.
    assert.equal((await f.read("tab_click", { ref: "e7", observe: "none" })).code, 200);
    assert.equal(f.requests.at(-1)!.url, `/tabs/${tabId}/click`);
    assert.deepEqual(f.requests.at(-1)!.body, { ref: "e7", userId: f.h.id });
    f.tab.refs = new Map([...f.tab.refs, ["e7", { role: "link", name: "Moved", nth: 0 }]]);
    assert.match(errorOf(await f.read("tab_click", { ref: "e7" })), /ref e7 may have shifted/);
    // A selector goes to Camofox as it is.
    assert.equal((await f.read("tab_click", { selector: "#save", observe: "none" })).code, 200);
    assert.deepEqual(f.requests.at(-1)!.body, { selector: "#save", userId: f.h.id });
    // A controller that has read nothing has no reliable refs.
    assert.equal((await f.h.request("release", { controllerId: controller.id })).code, 200);
    assert.equal((await f.h.request("acquire", { ...controller, id: "controller-b" })).code, 200);
    assert.match(errorOf(await f.as("controller-b")("tab_click", { ref: "e7" })), /ref e7 may have shifted/);
  } finally { await f.close(); }
});

test("a closed tab drops what the controller knew about it", async () => {
  const f = await snapshotFixture();
  try {
    await f.start();
    payloadOf(await f.read("tab_snapshot", { collapse: false }));
    assert.equal((await f.read("tab_close")).code, 200);
    assert.match(errorOf(await f.read("tab_click", { ref: "e5" })), /ref e5 may have shifted/);
    assert.equal(payloadOf(await f.read("tab_snapshot", { diff: true })).baseline, true);
  } finally { await f.close(); }
});

test("a viewId pages the cached view without a request, and a replaced viewId fails", async () => {
  const f = await snapshotFixture();
  f.state.page = annotate(shop({ items: 60 }));
  try {
    await f.start();
    const first = payloadOf(await f.read("tab_snapshot", { collapse: false, maxChars: 1000 }));
    assert.equal(first.truncated, true);
    assert.ok(first.nextOffset > 0);
    const requests = f.requests.length, routes = f.state.route;
    const second = payloadOf(await f.read("tab_snapshot", { offset: first.nextOffset, viewId: first.viewId, maxChars: 1000 }));
    assert.equal(f.requests.length, requests);
    assert.equal(f.state.route, routes);
    assert.equal(second.viewId, first.viewId);
    assert.equal(second.url, "https://shop.test/");
    assert.equal(second.refsCount, first.refsCount);
    assert.ok(!second.snapshot.startsWith("- banner"));
    assert.equal(f.state.page.yaml.split("\n").slice(0, 3).join("\n"), first.snapshot.split("\n").slice(0, 3).join("\n"));
    const replaced = payloadOf(await f.read("tab_snapshot", { collapse: false, maxChars: 1000 }));
    assert.match(errorOf(await f.read("tab_snapshot", { offset: first.nextOffset, viewId: first.viewId })), /Read a new tab_snapshot\./);
    assert.equal((await f.read("tab_snapshot", { offset: replaced.nextOffset, viewId: replaced.viewId })).code, 200);
    // After a resume, no view is cached.
    assert.equal((await f.h.request("pause", { controllerId: controller.id })).code, 200);
    assert.equal((await f.h.request("resume", { controllerId: controller.id })).code, 200);
    assert.match(errorOf(await f.read("tab_snapshot", { offset: replaced.nextOffset, viewId: replaced.viewId })), /Read a new tab_snapshot\./);
  } finally { await f.close(); }
});

test("a page that is gone fails the paging of its view", async () => {
  const f = await snapshotFixture();
  f.state.page = annotate(shop({ items: 60 }));
  try {
    await f.start();
    const first = payloadOf(await f.read("tab_snapshot", { collapse: false, maxChars: 1000 }));
    f.h.sessions.set(f.h.id, { tabGroups: new Map([["default", new Map()]]) });
    assert.match(errorOf(await f.read("tab_snapshot", { offset: first.nextOffset, viewId: first.viewId })), /no longer exists/);
  } finally { await f.close(); }
});

test("a changed tab state of Camofox fails closed, before and after the snapshot, and the guard fails closed too", async () => {
  const f = await snapshotFixture();
  const changed = "Stelz cannot read the page state of Camofox, because its internal tab state has changed. Update Stelz.";
  try {
    await f.start();
    payloadOf(await f.read("tab_snapshot"));
    const { tab, h } = f, original = h.sessions.get(h.id);
    const group = (state: unknown) => ({ tabGroups: new Map([["default", new Map([[tabId, state]])]]) });
    // The structure is not what Stelz expects.
    for (const broken of [group({ ...tab, refs: {} }), group({ ...tab, refs: new Map([["e1", { role: "button" }]]) }), group(null),
      { tabGroups: {} }, { tabGroups: new Map([["default", {}]]) }]) {
      h.sessions.set(h.id, broken);
      assert.equal(errorOf(await f.read("tab_snapshot")), changed);
      assert.equal(errorOf(await f.read("tab_click", { ref: "e5" })), changed);
    }
    h.sessions.set(h.id, original);
    // The route replied, and the tab state does not hold the snapshot that the reply describes. The route rewrites both fields, so the test pins them.
    const pin = (key: "lastSnapshot" | "refs", value: unknown) => Object.defineProperty(tab, key, { get: () => value, set() {}, configurable: true });
    const unpin = (key: "lastSnapshot" | "refs", value: unknown) => Object.defineProperty(tab, key, { value, writable: true, configurable: true, enumerable: true });
    for (const value of [null, undefined, 5, {}, f.state.page.yaml + " "]) {
      pin("lastSnapshot", value);
      assert.equal(errorOf(await f.read("tab_snapshot")), changed, String(value));
    }
    unpin("lastSnapshot", null);
    pin("refs", new Map([...f.state.page.refs].slice(1)));
    assert.equal(errorOf(await f.read("tab_snapshot")), changed);
    unpin("refs", new Map());
    // The session is gone after the route replied.
    h.sessions.delete(h.id);
    assert.equal(errorOf(await f.read("tab_snapshot")), changed);
    // The failures changed nothing. The next valid read works, against the baseline of the first read.
    h.sessions.set(h.id, original);
    assert.equal(payloadOf(await f.read("tab_snapshot", { diff: true })).snapshot, "# No change since your last snapshot.");
    assert.equal(h.state().phase, "ready");
  } finally { await f.close(); }
});

test("the reply of a click that failed its role check has no embedded snapshot, and neither does a failed extract", async () => {
  const full = "- heading \"Whole page\" [e1]\n".repeat(2000);
  const mismatch = { ok: false, code: "semantic_target_mismatch", retryable: true, recovery: "use_returned_snapshot",
    error: "The referenced element no longer matches the requested role or accessible name. No click was performed; use the returned snapshot and a current ref.",
    ref: "e3", expected: { role: "button" }, actual: { role: "link", accessibleName: "Home" }, url: "https://shop.test/", snapshot: full, refsCount: 4 };
  let route: "click" | "refs" | "extract" = "click";
  const f = await canonicalHarness({ reply: path => {
    if (path.endsWith("/click")) return { code: 200, payload: mismatch };
    if (path.endsWith("/extract")) return route === "refs"
      ? { code: 409, payload: { error: "no refs available -- call GET /tabs/:tabId/snapshot first to build the ref table", snapshot: full } }
      : { code: 422, payload: { ok: false, error: "No match for field title", snapshot: full } };
    return undefined;
  } });
  const h = f.h;
  try {
    await h.launch(); await h.create(); await h.request("acquire", controller);
    // A selector click reaches the role check. A ref click would need a ref that the controller saw.
    const click = await h.request("tool", { controllerId: controller.id, name: "tab_click", args: { tabId, selector: "#x", expected_role: "button" } });
    const { snapshot: _dropped, ...rest } = mismatch;
    assert.deepEqual((click.payload as { payload: unknown }).payload, { ...rest, recovery: "read_tab_snapshot", hint: "Read tab_snapshot for the current page.",
      error: "The referenced element no longer matches the requested role or accessible name. No click was performed. Read tab_snapshot, then use a current ref." });
    for (const [kind, code] of [["refs", 409], ["extract", 422]] as const) {
      route = kind;
      const result = await h.request("tool", { controllerId: controller.id, name: "tab_extract", args: { tabId, schema: { type: "object", properties: {} } } });
      const message = errorOf(result);
      assert.ok(message.startsWith(`${code}: `), message);
      assert.ok(message.length < 400, message.length.toString());
      assert.equal(JSON.parse(message.slice(5)).hint, "Read tab_snapshot for the current page.");
      assert.equal(Object.hasOwn(JSON.parse(message.slice(5)), "snapshot"), false);
    }
  } finally { await f.close(); }
});

test("a click that passed has its upstream payload, and an extract error that is not an object is kept", async () => {
  const f = await canonicalHarness({ reply: path => path.endsWith("/extract") ? { code: 500, payload: { error: "Extract failed" } } : undefined });
  try {
    await f.h.launch(); await f.h.create(); await f.h.request("acquire", controller);
    const click = await f.h.request("tool", { controllerId: controller.id, name: "tab_click", args: { tabId, selector: "#x" } });
    assert.deepEqual((click.payload as { payload: unknown }).payload, { ok: true });
    const failed = await f.h.request("tool", { controllerId: controller.id, name: "tab_extract", args: { tabId, schema: { type: "object", properties: {} } } });
    assert.equal(errorOf(failed), '500: {"error":"Extract failed"}');
  } finally { await f.close(); }
});

// Role/name targets, the observation after an action, and tab_wait with a target. They all read fresh snapshots in the queued action.
type Raw = { kind: string; payload: any; observation?: any };
const raw = (result: { code: number; payload: unknown }) => {
  assert.equal(result.code, 200, JSON.stringify(result.payload));
  return result.payload as Raw;
};
const refOf = (page: { refs: Map<string, { role: string; name: string }> }, role: string, name: string) =>
  [...page.refs].find(([, entry]) => entry.role === role && entry.name === name)![0];
type Sent = { method: string; url: string; body?: Record<string, unknown> };
const route = (request: Sent) => `${request.method} ${new URL(request.url, "http://localhost").pathname.replace(tabId, "TAB")}`;
const menu = { top: ['  - button "Menu"'] };
const NOTE = "The action completed. Read tab_snapshot to see the page.";
const SHIFTED = /ref e\d+ may have shifted/;

test("a target is read from a fresh snapshot in the queued action, and upstream gets one action request with the ref", async () => {
  const f = await snapshotFixture();
  try {
    await f.start();
    const cases: Array<[string, Record<string, unknown>, Record<string, unknown>, string]> = [
      ["tab_click", { target: { role: "BUTTON", name: " add  lamp 3" } }, {}, refOf(f.state.page, "button", "Add Lamp 3")],
      ["tab_type", { target: { role: "textbox", name: "Email" }, text: "a@b.test" }, { text: "a@b.test", typingMode: "balanced" }, refOf(f.state.page, "textbox", "Email")],
      ["tab_select", { target: { role: "searchbox", name: "Search" }, option: "red" }, { option: "red" }, refOf(f.state.page, "searchbox", "Search")],
    ];
    for (const [name, args, body, ref] of cases) {
      const before = f.requests.length;
      assert.equal((await f.read(name, { ...args, observe: "none" })).code, 200, name);
      const sent = f.requests.slice(before);
      // One snapshot read without a screenshot, then one action request. Upstream knows neither target nor observe.
      assert.deepEqual(sent.map(route), ["GET /tabs/TAB/snapshot", `POST /tabs/TAB/${name.slice(4)}`], name);
      assert.equal(new URL(sent[0]!.url, "http://localhost").searchParams.get("includeScreenshot"), "false");
      assert.deepEqual(sent[1]!.body, { ref, userId: f.h.id, ...body }, name);
    }
    // The ref comes from the snapshot of the same action, so the guard has nothing to check. A controller that read nothing can use a target and not a ref.
    assert.equal((await f.h.request("release", { controllerId: controller.id })).code, 200);
    assert.equal((await f.h.request("acquire", { ...controller, id: "controller-b" })).code, 200);
    const b = f.as("controller-b"), add = refOf(f.state.page, "button", "Add Lamp 3");
    assert.match(errorOf(await b("tab_click", { ref: add })), SHIFTED);
    assert.equal((await b("tab_click", { target: { role: "button", name: "Add Lamp 3" }, observe: "none" })).code, 200);
    assert.equal(f.h.state().phase, "ready");
  } finally { await f.close(); }
});

test("a target uses the page as it is now, and its read changes no baseline, no latest view, and no shown ref", async () => {
  const f = await snapshotFixture();
  try {
    await f.start();
    const first = payloadOf(await f.read("tab_snapshot", { collapse: false, maxChars: 1000 }));
    assert.ok(first.nextOffset > 0);
    const old = refOf(f.state.page, "button", "Add Lamp 3");
    // A button at the top moves every ref. The controller has not read the new page. The target still finds the right element.
    f.state.page = annotate(shop(menu));
    const now = refOf(f.state.page, "button", "Add Lamp 3");
    assert.notEqual(now, old);
    assert.equal((await f.read("tab_click", { target: { role: "button", name: "Add Lamp 3" }, observe: "none" })).code, 200);
    assert.equal(f.requests.at(-1)!.body!.ref, now);
    // The latest view is still the first one, so its viewId still pages.
    const second = payloadOf(await f.read("tab_snapshot", { offset: first.nextOffset, viewId: first.viewId, maxChars: 1000 }));
    assert.equal(second.viewId, first.viewId);
    // The Menu button is a new line with ref e1 in the page that the target read. The controller never received that page.
    assert.match(errorOf(await f.read("tab_click", { ref: "e1" })), SHIFTED);
    // The baseline is still the first page, so a diff shows the Menu button. It is not "No change".
    const diff = payloadOf(await f.read("tab_snapshot", { diff: true, collapse: false }));
    assert.equal(Object.hasOwn(diff, "baseline"), false);
    assert.match(diff.snapshot, /\+ {2}- button "Menu" \[e1\]/);
  } finally { await f.close(); }
});

test("a target that names no safe element fails before any action request and does not block the profile", async () => {
  const f = await snapshotFixture();
  try {
    await f.start();
    const refused = async (target: Record<string, unknown>, pattern: RegExp) => {
      const before = f.requests.length;
      assert.match(errorOf(await f.read("tab_click", { target })), pattern, JSON.stringify(target));
      // The snapshot read happened. The action did not.
      assert.deepEqual(f.requests.slice(before).map(route), ["GET /tabs/TAB/snapshot"]);
      assert.equal(f.h.state().phase, "ready");
    };
    await refused({ role: "button", name: "Add Lamp 99" }, /^No element matches the target: role "button" and name "Add Lamp 99"\. Elements with this role: button "Add Lamp \d+", button "Add Lamp \d+", button "Add Lamp \d+", button "Add Lamp \d+", button "Add Lamp \d+"\.$/);
    f.state.page = annotate(['- button "Add"', '- button "Add"'].join("\n"));
    await refused({ role: "button", name: "Add" }, /^The target matches 2 elements: role "button" and name "Add"\. Pass nth \(0 to 1\)\.$/);
    const before = f.requests.length;
    assert.equal((await f.read("tab_click", { target: { role: "button", name: "Add", nth: 1 }, observe: "none" })).code, 200);
    assert.equal(f.requests.slice(before).length, 2);
    // A word in a name never blocks the profile. The message of a timeout does, and a name can contain that word.
    for (const word of ["timeout", "timed out", "Session timeout"]) {
      f.state.page = annotate(`- button "Add"`);
      await refused({ role: "button", name: word }, new RegExp(`No element matches the target: role "button" and name "${word}"`));
    }
    assert.match(errorOf(await f.read("tab_snapshot", { scope: { role: "button", name: "timeout" } })), /No element matches the scope/);
    assert.equal(f.h.state().phase, "ready");
  } finally { await f.close(); }
});

test("observe diff returns the diff from the same queued action, and it is a view that updates the baseline, the latest view, and the shown refs", async () => {
  const f = await snapshotFixture();
  try {
    await f.start();
    const first = payloadOf(await f.read("tab_snapshot", { collapse: false, maxChars: 1000 }));
    const old = refOf(f.state.page, "searchbox", "Search");
    // The click changes the page, and Camofox rebuilds the refs of the tab when its snapshot route runs.
    f.state.act = path => { if (path.endsWith("/click")) f.state.page = annotate(shop(menu)); return undefined; };
    const before = f.requests.length;
    const result = raw(await f.read("tab_click", { selector: "#menu" }));
    assert.deepEqual(f.requests.slice(before).map(route), ["POST /tabs/TAB/click", "GET /tabs/TAB/snapshot"]);
    assert.equal(new URL(f.requests.at(-1)!.url, "http://localhost").searchParams.get("includeScreenshot"), "false");
    assert.deepEqual(result.payload, { ok: true });
    assert.equal(result.kind, "json");
    assert.equal(result.observation.kind, "snapshot");
    const view = result.observation.payload;
    assert.deepEqual(Object.keys(view), ["url", "refsCount", "truncated", "viewId", "snapshot"]);
    assert.match(view.snapshot, /^# Diff from your last snapshot/);
    assert.match(view.snapshot, /\+ {2}- button "Menu" \[e1\]/);
    assert.ok(view.snapshot.length < 500);
    assert.notEqual(view.viewId, first.viewId);
    // The diff showed e1. Search is unchanged and moved, and no reply showed it.
    assert.equal((await f.read("tab_click", { ref: "e1", observe: "none" })).code, 200);
    assert.match(errorOf(await f.read("tab_click", { ref: old })), SHIFTED);
    // The latest view moved: the first view cannot page any more.
    assert.match(errorOf(await f.read("tab_snapshot", { offset: first.nextOffset, viewId: first.viewId })), /Read a new tab_snapshot\./);
    // The baseline moved: the page of the observation is the baseline of the next diff.
    assert.equal(payloadOf(await f.read("tab_snapshot", { diff: true, collapse: false })).snapshot, "# No change since your last snapshot.");
  } finally { await f.close(); }
});

test("click, type, select, and press observe by default, and observe none returns the action result only", async () => {
  const f = await snapshotFixture();
  try {
    await f.start();
    payloadOf(await f.read("tab_snapshot"));
    const calls: Array<[string, Record<string, unknown>]> = [["tab_click", { selector: "#a" }], ["tab_type", { selector: "#a", text: "x" }],
      ["tab_select", { selector: "#a", option: "b" }], ["tab_press", { key: "Tab" }]];
    for (const [name, args] of calls) {
      let before = f.requests.length;
      const observed = raw(await f.read(name, args));
      assert.deepEqual(f.requests.slice(before).map(route), [`POST /tabs/TAB/${name.slice(4)}`, "GET /tabs/TAB/snapshot"], name);
      assert.equal(observed.observation.kind, "snapshot", name);
      before = f.requests.length;
      const same = raw(await f.read(name, { ...args, observe: "diff" }));
      assert.equal(same.observation.kind, "snapshot", name);
      before = f.requests.length;
      const bare = raw(await f.read(name, { ...args, observe: "none" }));
      assert.deepEqual(f.requests.slice(before).map(route), [`POST /tabs/TAB/${name.slice(4)}`], name);
      assert.equal(Object.hasOwn(bare, "observation"), false, name);
      assert.deepEqual(bare, { kind: "json", payload: { ok: true } }, name);
    }
    // Other tools never observe.
    const before = f.requests.length;
    assert.equal(Object.hasOwn(raw(await f.read("tab_scroll", { direction: "down" })), "observation"), false);
    assert.equal(f.requests.length, before + 1);
  } finally { await f.close(); }
});

test("an observation that fails after a successful action is still a success with a note, and the action is never repeated", async () => {
  const f = await snapshotFixture();
  try {
    await f.start();
    payloadOf(await f.read("tab_snapshot", { collapse: false }));
    const clicks = () => f.requests.filter(request => request.url.endsWith("/click")).length;
    const sessions = f.h.sessions.get(f.h.id);
    const modes: Array<[string, () => void, () => void]> = [
      ["the snapshot route fails", () => { f.state.snapshot = () => ({ code: 500, payload: { error: "Snapshot failed" } }); }, () => { f.state.snapshot = undefined; }],
      ["the tab state is not what Stelz expects", () => { f.state.act = () => { f.h.sessions.set(f.h.id, { tabGroups: {} }); return undefined; }; },
        () => { f.state.act = undefined; f.h.sessions.set(f.h.id, sessions); }],
    ];
    for (const [label, fail, restore] of modes) {
      fail();
      const before = clicks();
      const result = raw(await f.read("tab_click", { selector: "#save" }));
      assert.deepEqual(result, { kind: "json", payload: { ok: true }, observation: { error: NOTE } }, label);
      assert.equal(clicks(), before + 1, label);
      assert.equal(f.h.state().phase, "ready", label);
      restore();
    }
    // The failed reads changed nothing. The baseline is still the first page.
    assert.equal(payloadOf(await f.read("tab_snapshot", { diff: true, collapse: false })).snapshot, "# No change since your last snapshot.");
    // A snapshot that times out may leave work in the browser. The action still succeeded, and the lifetime is blocked as for any timeout.
    f.state.snapshot = () => ({ code: 500, payload: { error: "action timed out after 30000ms" } });
    const timed = raw(await f.read("tab_click", { selector: "#save" }));
    assert.deepEqual(timed.observation, { error: NOTE });
    assert.equal(f.h.state().phase, "blocked");
  } finally { await f.close(); }
});

test("an observation that hangs after a successful action ends at its own time limit: success with the note, a blocked profile, and no service deadline error", async () => {
  // The service deadline of the action is 1 second here. The read has 150 ms of its own, and it hangs.
  const f = await snapshotFixture({ timeout: 1000, observeTimeout: 150 });
  let release!: (reply: Reply) => void;
  const hung = new Promise<Reply>(resolve => { release = resolve; });
  const activeActions = async () => ((await f.h.request("status")).payload as { controller: { activeActions: number } }).controller.activeActions;
  try {
    await f.start();
    payloadOf(await f.read("tab_snapshot", { collapse: false }));
    f.state.snapshot = () => hung;
    const clicks = () => f.requests.filter(request => request.url.endsWith("/click")).length;
    const before = clicks(), started = Date.now();
    const result = raw(await f.read("tab_click", { selector: "#save" }));
    assert.deepEqual(result, { kind: "json", payload: { ok: true }, observation: { error: NOTE } });
    // The read ended at its own limit, long before the deadline of the service. The click happened once.
    assert.ok(Date.now() - started < 800, `The call took ${Date.now() - started} ms.`);
    assert.equal(clicks(), before + 1);
    // The upstream read can still run. The lifetime is blocked, and the controller keeps the unfinished work.
    assert.equal(f.h.state().phase, "blocked");
    assert.match(String(f.h.state().error), /exceeded its time limit/);
    assert.equal(await activeActions(), 1);
    assert.match(errorOf(await f.read("tab_click", { selector: "#save" })), /Profile is blocked/);
    assert.equal(clicks(), before + 1);
    // The read ends later, and the controller holds no work then.
    release({ code: 200, payload: { ok: true } });
    const deadline = Date.now() + 2000;
    while (await activeActions() > 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(await activeActions(), 0);
  } finally { release({ code: 200, payload: { ok: true } }); await f.close(); }
});

// The 5 s read is as long as the default test timeout of Bun.
test("a slow read after an action that finishes within its limit is not cut short, and the service deadline still ends a slow action", async () => {
  const f = await snapshotFixture({ timeout: 400, observeTimeout: 5000 });
  try {
    await f.start();
    payloadOf(await f.read("tab_snapshot", { collapse: false }));
    // The read takes longer than the service deadline of the action. It has its own, longer limit, so the call still succeeds with the page.
    f.state.delay = 700;
    const result = raw(await f.read("tab_click", { selector: "#save" }));
    assert.equal(result.observation.kind, "snapshot");
    assert.equal(f.h.state().phase, "ready");
    // An action that passes the service deadline is still an error, and it has no observation.
    f.state.delay = 0;
    f.state.act = () => new Promise<Reply>(resolve => setTimeout(() => resolve({ code: 200, payload: { ok: true } }), 900));
    assert.match(errorOf(await f.read("tab_click", { selector: "#save" })), /exceeded its time limit/);
    assert.equal(f.h.state().phase, "blocked");
  } finally { await f.close(); }
}, 30_000);

test("an uncertain click blocks the lifetime, further actions, and release/reacquire without retries", async () => {
  const f = await snapshotFixture();
  try {
    await f.start();
    payloadOf(await f.read("tab_snapshot"));
    const error = uncertainClickError(Error("locator.click: Timeout 23000ms exceeded. performing click action"));
    f.state.act = path => path.endsWith("/click") ? { code: error.statusCode, payload: { error: error.message, retryable: false } } : undefined;
    const before = f.requests.length;
    const response = await f.read("tab_click", { selector: "#save" });
    assert.equal(response.code, 409);
    assert.match(errorOf(response), /^409:/);
    assert.ok(errorOf(response).includes(UNCERTAIN_CLICK));
    assert.equal(f.h.state().phase, "blocked");
    assert.equal(f.h.state().error, UNCERTAIN_CLICK);
    // No retry or observation follows the uncertain action, including after a release.
    assert.match(errorOf(await f.read("tab_click", { selector: "#save" })), /Profile is blocked/);
    assert.match(errorOf(await f.read("tab_snapshot")), /Profile is blocked/);
    assert.equal((await f.h.request("release", { controllerId: controller.id })).code, 200);
    for (const id of [controller.id, "controller-after-uncertainty"])
      assert.equal((await f.h.request("acquire", { ...controller, id })).code, 409);
    assert.equal(f.h.state().phase, "blocked");
    assert.deepEqual(f.requests.slice(before).map(route), ["POST /tabs/TAB/click"]);
  } finally { await f.close(); }
});

test("a failed action returns its error and no observation", async () => {
  const f = await snapshotFixture();
  try {
    await f.start();
    payloadOf(await f.read("tab_snapshot"));
    f.state.act = path => path.endsWith("/click") ? { code: 409, payload: { error: "Element is not visible" } } : undefined;
    const before = f.requests.length;
    assert.match(errorOf(await f.read("tab_click", { selector: "#save" })), /Element is not visible/);
    // No snapshot request followed the action.
    assert.deepEqual(f.requests.slice(before).map(route), ["POST /tabs/TAB/click"]);
    assert.equal(f.h.state().phase, "ready");
    f.state.act = () => ({ code: 404, payload: { error: "Tab not found" } });
    for (const [name, args] of [["tab_type", { selector: "#a", text: "x" }], ["tab_select", { selector: "#a", option: "b" }], ["tab_press", { key: "Tab" }]] as const) {
      const count = f.requests.length;
      assert.match(errorOf(await f.read(name, args)), /^404:/, name);
      assert.equal(f.requests.length, count + 1, name);
    }
    // A refused click is not an error, and it did not happen. It has nothing to observe.
    const mismatch = { ok: false, code: "semantic_target_mismatch", error: "No click was performed.", snapshot: "- main:" };
    f.state.act = () => ({ code: 200, payload: mismatch });
    const count = f.requests.length, refused = raw(await f.read("tab_click", { selector: "#save", expected_role: "button" }));
    assert.equal(Object.hasOwn(refused, "observation"), false);
    assert.equal(f.requests.length, count + 1);
    assert.equal(Object.hasOwn(refused.payload, "snapshot"), false);
  } finally { await f.close(); }
});

test("an observation of a target action is one queued action, so another controller action cannot come between", async () => {
  const f = await snapshotFixture();
  try {
    await f.start();
    const calls = await Promise.all([1, 2, 3].map(() => f.read("tab_click", { target: { role: "button", name: "Add Lamp 3" } })));
    assert.ok(calls.every(call => call.code === 200));
    // Each call is its own run of snapshot, click, snapshot. The runs do not interleave.
    assert.deepEqual(f.requests.map(route), Array.from({ length: 3 }, () => ["GET /tabs/TAB/snapshot", "POST /tabs/TAB/click", "GET /tabs/TAB/snapshot"]).flat());
  } finally { await f.close(); }
});

test("tab_wait with a target polls fresh snapshots until the element is on the page, and the polls are not views", async () => {
  const f = await snapshotFixture();
  try {
    await f.start();
    payloadOf(await f.read("tab_snapshot", { collapse: false }));
    // The button appears at the fourth snapshot of the wait. The polls rebuild the refs of the tab, as any snapshot does.
    const routes = f.state.route;
    f.state.snapshot = n => { if (n >= routes + 3) f.state.page = annotate(shop(({ top: ['  - button "Done"'] }))); return undefined; };
    const before = f.requests.length;
    const result = raw(await f.read("tab_wait", { target: { role: "button", name: "done" }, timeout: 5000 }));
    assert.equal(result.kind, "json");
    assert.deepEqual(Object.keys(result.payload), ["found", "waitedMs", "matched"]);
    assert.equal(result.payload.found, true);
    assert.equal(result.payload.matched, '- button "Done"');
    assert.ok(result.payload.waitedMs >= 500 && result.payload.waitedMs < 3000, String(result.payload.waitedMs));
    assert.equal(Object.hasOwn(result, "observation"), false);
    assert.deepEqual(f.requests.slice(before).map(route), Array(3).fill("GET /tabs/TAB/snapshot"));
    // The polls did not change the baseline or the shown refs. The diff of the next snapshot shows the button, and refs that the polls saw are refused.
    assert.match(errorOf(await f.read("tab_click", { ref: "e1" })), SHIFTED);
    const diff = payloadOf(await f.read("tab_snapshot", { diff: true, collapse: false }));
    assert.match(diff.snapshot, /\+ {2}- button "Done" \[e1\]/);
  } finally { await f.close(); }
});

test("tab_wait with a text, or with a target that is already there, returns at once", async () => {
  const f = await snapshotFixture();
  try {
    await f.start();
    const before = f.requests.length;
    const present = raw(await f.read("tab_wait", { target: { role: "button", name: "Add Lamp 1" }, timeout: 5000 }));
    assert.equal(present.payload.found, true);
    assert.ok(present.payload.waitedMs < 250, String(present.payload.waitedMs));
    const text = raw(await f.read("tab_wait", { contains: "© shop", timeout: 5000 }));
    assert.equal(text.payload.found, true);
    assert.equal(text.payload.matched, "- text: © Shop");
    assert.equal(f.requests.length, before + 2);
    // A text that appears later.
    const routes = f.state.route;
    f.state.snapshot = n => { if (n > routes) f.state.page = annotate(shop().replace("© Shop", "Order placed")); return undefined; };
    const later = raw(await f.read("tab_wait", { contains: "ORDER PLACED", timeout: 5000 }));
    assert.deepEqual([later.payload.found, later.payload.matched], [true, "- text: Order placed"]);
  } finally { await f.close(); }
});

test("tab_wait that reaches its timeout is a clean result, not an error, and the profile stays ready", async () => {
  const f = await snapshotFixture();
  try {
    await f.start();
    const before = f.requests.length;
    const started = Date.now();
    const result = raw(await f.read("tab_wait", { target: { role: "button", name: "Never" }, timeout: 700 }));
    assert.deepEqual(Object.keys(result.payload), ["found", "waitedMs", "reason"]);
    assert.equal(result.payload.found, false);
    assert.equal(result.payload.reason, "timeout");
    assert.ok(result.payload.waitedMs >= 700 && result.payload.waitedMs < 1500, String(result.payload.waitedMs));
    assert.ok(Date.now() - started < 3000);
    // About one poll every 300 ms: at 0, 300, 600, and at the timeout.
    const polls = f.requests.length - before;
    assert.ok(polls >= 3 && polls <= 5, String(polls));
    assert.equal(f.h.state().phase, "ready");
    // A zero timeout polls once.
    const count = f.requests.length;
    assert.equal(raw(await f.read("tab_wait", { contains: "Never", timeout: 0 })).payload.reason, "timeout");
    assert.equal(f.requests.length, count + 1);
    assert.equal((await f.read("tab_click", { selector: "#ok", observe: "none" })).code, 200);
  } finally { await f.close(); }
});

test("a pause or a release during tab_wait ends it at once with a clean reason", async () => {
  const f = await snapshotFixture();
  try {
    await f.start();
    const target = { role: "button", name: "Never" };
    // Run the request after the wait has made its first poll.
    const during = async (call: () => Promise<{ code: number; payload: unknown }>) => {
      const deadline = Date.now() + 2000;
      while (f.state.route < 1 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
      assert.ok(f.state.route >= 1, "The wait did not start.");
      return call();
    };
    // The pause waits for the admitted wait. The wait does not wait for its timeout.
    let started = Date.now();
    const wait = f.read("tab_wait", { target, timeout: 30_000 });
    const [paused, afterPause] = await Promise.all([during(() => f.h.request("pause", { controllerId: controller.id })), wait]);
    assert.equal(paused.code, 200);
    assert.equal(f.h.state().phase, "paused");
    assert.ok(Date.now() - started < 3000);
    assert.deepEqual({ ...raw(afterPause).payload, waitedMs: 0 }, { found: false, waitedMs: 0, reason: "paused" });
    // A wait on a paused profile is refused like any action. Resume, then release during a wait.
    assert.match(errorOf(await f.read("tab_wait", { target, timeout: 1000 })), /Profile is paused/);
    assert.equal((await f.h.request("resume", { controllerId: controller.id })).code, 200);
    f.state.route = 0; started = Date.now();
    const second = f.read("tab_wait", { contains: "Never", timeout: 30_000 });
    const [released, afterRelease] = await Promise.all([during(() => f.h.request("release", { controllerId: controller.id })), second]);
    assert.equal(released.code, 200);
    assert.ok(Date.now() - started < 3000);
    assert.deepEqual({ ...raw(afterRelease).payload, waitedMs: 0 }, { found: false, waitedMs: 0, reason: "releasing" });
    assert.equal(f.h.state().phase, "ready");
    assert.equal((await f.h.request("acquire", { ...controller, id: "controller-b" })).code, 200);
  } finally { await f.close(); }
});

test("tab_wait without a target or a text is the upstream wait, with only its own arguments", async () => {
  const f = await snapshotFixture();
  try {
    await f.start();
    const before = f.requests.length;
    assert.deepEqual(raw(await f.read("tab_wait", { timeout: 500, waitForNetwork: false })), { kind: "json", payload: { ok: true } });
    const sent = f.requests.slice(before);
    assert.deepEqual(sent.map(route), ["POST /tabs/TAB/wait"]);
    assert.deepEqual(sent[0]!.body, { timeout: 500, waitForNetwork: false, userId: f.h.id });
  } finally { await f.close(); }
});

test("a poll that fails ends tab_wait with the error, and a poll error that names a timeout still blocks like any timeout", async () => {
  const f = await snapshotFixture();
  try {
    await f.start();
    f.state.snapshot = () => ({ code: 500, payload: { error: "Snapshot failed" } });
    assert.match(errorOf(await f.read("tab_wait", { contains: "x", timeout: 1000 })), /^500:/);
    assert.equal(f.h.state().phase, "ready");
    f.state.snapshot = () => ({ code: 500, payload: { error: "action timed out after 30000ms" } });
    assert.match(errorOf(await f.read("tab_wait", { contains: "x", timeout: 1000 })), /timed out/);
    assert.equal(f.h.state().phase, "blocked");
  } finally { await f.close(); }
});
