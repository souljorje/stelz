import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { freezeDevice, replayFingerprint, launchPreferences, applyProxyLocale } from "../../src/browser/fingerprint.ts";
import { locationResult } from "../../src/browser/location.ts";
import { register } from "../../src/browser/plugin.ts";
import { browserTools } from "../../src/browser/catalog.ts";
import { commitFingerprint, readFingerprintJournal, stageFingerprint, writeInitialized } from "../../src/browser/fingerprint-transaction.ts";
import { upstreamTyping } from "../helpers/upstream-typing.ts";
import { mockLauncherResources } from "../helpers/launcher-resources.ts";
import { annotate, shop } from "../helpers/aria-fixtures.ts";

mockLauncherResources();

const packageDir = dirname(createRequire(import.meta.url).resolve("@askjo/camofox-browser/package.json"));
const contractsUrl = pathToFileURL(join(packageDir, "mcp/lib/tool-contracts.mjs")).href;
const tabId = "79bed5c4-d5b8-4369-9d13-b159451ece91";

test("typing advertises optional per-call modes without changing upstream definitions", async () => {
  const { TOOL_DEFS } = await import(contractsUrl);
  const original = structuredClone(TOOL_DEFS);
  const tools = browserTools(TOOL_DEFS);
  assert.equal(tools.size, 25);
  const typing = tools.get("tab_type")?.tool;
  assert.ok(typing);
  const mode = typing.inputSchema.properties?.mode;
  assert.ok(mode && typeof mode === "object" && "enum" in mode);
  assert.deepEqual(mode.enum, ["balanced", "keyboard", "instant"]);
  assert.deepEqual(typing.inputSchema.required, TOOL_DEFS.find((tool: { name: string }) => tool.name === "camofox_type").inputSchema.required);
  assert.ok(!typing.inputSchema.required?.includes("mode"));
  assert.deepEqual(TOOL_DEFS, original);
});

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

test("proxy policy wins and unrelated fresh preferences survive", () => {
  assert.deepEqual(launchPreferences({ "media.peerconnection.enabled": true, "network.proxy.failover_direct": true,
    "network.proxy.socks_remote_dns": false, "network.proxy.socks5_remote_dns": false, "network.test": true, fresh: 1 }, true),
    { "media.peerconnection.enabled": false, "network.proxy.failover_direct": false,
      "network.proxy.socks_remote_dns": true, "network.proxy.socks5_remote_dns": true, "network.test": true, fresh: 1 });
  assert.deepEqual(launchPreferences({ fresh: 1 }, false), { fresh: 1 });
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
      assert.equal(launched.firefoxUserPrefs["network.proxy.failover_direct"], false);
      assert.equal(launched.firefoxUserPrefs["network.proxy.socks_remote_dns"], true);
      assert.equal(launched.firefoxUserPrefs["network.proxy.socks5_remote_dns"], true);
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
    interval?: number; now?: () => number; observedTimezone?: string; fingerprintError?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "stelz-regression-")), id = "profile-01";
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
    { actionTimeoutMs: fixture.timeout, ipCheckIntervalMs: fixture.interval ?? 0, now: fixture.now,
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

test("a prior service lifetime cannot acquire, revoke, or operate the replacement service", async () => {
  const old = await harness("direct", undefined, { expected: "" });
  const previous = old.identity;
  await old.close();
  const h = await harness("direct", undefined, { expected: "" });
  try {
    await h.launch(); await h.create();
    assert.notEqual(h.identity.instanceId, previous.instanceId);
    assert.equal((await h.rawRequest("acquire", { ...previous, ...controller })).code, 409);
    assert.equal((await h.rawRequest("release", { ...previous, controllerId: controller.id })).code, 409);
    assert.equal((await h.request("acquire", controller)).code, 200);
    for (const action of ["tool", "release", "pause", "resume", "check"]) {
      assert.equal((await h.rawRequest(action, { ...previous, ...listTabs })).code, 409);
    }
    assert.equal((await h.request("tool", listTabs)).code, 200);
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
async function canonicalHarness(options: { timeout?: number; type?: (body: Record<string, unknown>) => Promise<Reply>;
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
  const h = await harness("direct", undefined, { expected: "", canonical: true, port: address.port, timeout: options.timeout });
  return { h, requests, async close() {
    try { await h.close(); }
    finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  } };
}

test("canonical dispatch rejects tab-ID route injection before any HTTP request", async () => {
  const fixture = await canonicalHarness(), { h, requests } = fixture;
  try {
    await h.launch(); await h.create(); await h.request("acquire", controller);
    for (const name of ["tab_click", "tab_type", "tab_navigate", "tab_scroll",
      "tab_snapshot", "tab_screenshot", "tab_close"]) {
      for (const invalid of [
        "../local-profile/stop?ignored=", `${tabId}/evaluate?ignored=`, "../sessions/profile-01/storage_state",
        "%2e%2e/local-profile/stop?ignored=", "..\\local-profile\\stop?ignored=", `${tabId}%2fevaluate`,
        `${tabId}?userId=another`, `${tabId}#ignored`, `${tabId}/../`, `${tabId}\n`, `\t${tabId}`,
        ".", "..", "", undefined, null, 123, [tabId], { tabId },
      ]) {
        const result = await h.request("tool", { controllerId: controller.id, name,
          args: { tabId: invalid, selector: "#x", expression: "1+1", text: "test", direction: "down", url: "https://example.com" } });
        assert.equal(result.code, 409, `${name}: ${JSON.stringify(invalid)}`);
        assert.match(String((result.payload as { error: string }).error), /tabId/);
      }
    }
    for (const args of [null, false, 1, [], "invalid"]) {
      assert.equal((await h.request("tool", { ...listTabs, args })).code, 409);
    }
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
      ["tab_click", { tabId, selector: "#x" }, "POST", `/tabs/${tabId}/click`],
      ["tab_type", { tabId, selector: "#x", text: "hello" }, "POST", `/tabs/${tabId}/type`],
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
        const { tabId: _tabId, ...body } = args;
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
      name: "tab_type", args: { tabId, selector: "#message", text: "hello", ...args } });
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
    const count = requests.length;
    assert.equal((await type({ typingMode: "instant" })).code, 409, "Reject caller-supplied internal fields");
    for (const mode of ["auto", "paced", "fill", "other", null, false, 1]) assert.equal((await type({ mode })).code, 409);
    assert.equal(requests.length, count);
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
      args: { tabId, selector: "#message", text: "hello" } });
    assert.equal(result.code, 200);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0]!.body, { selector: "#message", text: "hello", userId: h.id, typingMode: expected });
    assert.equal(((await h.request("status")).payload as { typingModeDefault: string }).typingModeDefault, fallback);
    const override = await h.request("tool", { controllerId: controller.id, name: "tab_type",
      args: { tabId, selector: "#message", text: "hello", mode: "keyboard" } });
    assert.equal(override.code, 200);
    assert.equal(requests.length, 2);
    assert.equal(requests[1]!.body?.typingMode, "keyboard");
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

test("an expired failed check blocks cached browser actions until recovery", async () => {
  let clock = 0;
  const h = await harness("proxy", undefined, { interval: 120_000, now: () => clock });
  try {
    await h.launch(); await h.create(); await h.request("acquire", controller);
    h.setIPError("offline"); clock = 119_999;
    assert.equal((await h.request("tool", listTabs)).code, 200);
    assert.equal(h.checks(), 1);
    clock = 120_000;
    assert.equal((await h.request("tool", listTabs)).code, 409);
    assert.equal(h.state().phase, "verification_failed");
    h.setIPError(undefined); clock = 0;
    assert.equal((await h.request("tool", listTabs)).code, 409);
    assert.equal((await h.request("check")).code, 200);
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
  "page.goto: NS_ERROR_UNKNOWN_HOST at https://example.invalid/",
  "page.goto: NS_ERROR_NET_TIMEOUT at https://example.invalid/",
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

test("a failed proxy check blocks actions until an explicit successful recheck", async () => {
  const h = await harness("proxy");
  try {
    await h.launch();
    await h.create();
    await h.request("acquire", controller);
    h.setIPError("network unavailable");
    assert.equal((await h.request("tool", listTabs)).code, 409);
    assert.equal(h.state().phase, "verification_failed");
    h.setIPError(undefined);
    assert.equal((await h.request("tool", listTabs)).code, 409);
    h.setIP("203.0.113.7");
    assert.equal((await h.request("check")).code, 409);
    assert.equal(h.state().phase, "verification_failed");
    h.setIP("198.51.100.10");
    assert.equal((await h.request("check")).code, 200);
    assert.equal(h.state().phase, "ready");
    assert.equal((await h.request("tool", listTabs)).code, 200);
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
    for (const name of ["tab_activate", "camofox_activate", "camofox_snapshot", "camofox_evaluate", "camofox_import_cookies", "camofox_import_local_storage",
      "camofox_export_storage_state", "camofox_upload", "camofox_viewport", "tab_viewport", "tab_upload", "tab_unknown", ""]) {
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

test("a stalled action times out but retains control until underlying work settles", async () => {
  const h = await harness("direct", undefined, { expected: "", timeout: 40 });
  let finish!: (value: unknown) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<unknown>(resolve => { finish = resolve; });
  let calls = 0;
  try {
    await h.launch();
    await h.create();
    await h.request("acquire", controller);
    h.setTool(async () => { calls++; entered(); return gate; });
    const action = h.request("tool", listTabs);
    await started;
    const queued = h.request("tool", listTabs);
    let released = false;
    const release = h.request("release", { controllerId: controller.id }).then(result => { released = true; return result; });
    assert.equal((await action).code, 409);
    assert.equal((await queued).code, 409);
    assert.equal(released, false);
    assert.equal(calls, 1);
    assert.equal(h.state().phase, "blocked");
    assert.equal((await h.request("acquire", { ...controller, id: "controller-b" })).code, 409);
    assert.equal((await h.request("check")).code, 409);
    finish({ spec: {}, payload: "late" });
    assert.equal((await release).code, 200);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(h.state().phase, "blocked");
  } finally { finish?.({ spec: {}, payload: "done" }); await h.close(); }
});

test("pause refuses to acknowledge human takeover when an upstream action remains uncertain", async () => {
  const h = await harness("direct", undefined, { expected: "", timeout: 40 });
  let finish!: (value: unknown) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<unknown>(resolve => { finish = resolve; });
  try {
    await h.launch();
    await h.create();
    await h.request("acquire", controller);
    h.setTool(async () => { entered(); return gate; });
    const action = h.request("tool", listTabs);
    await started;
    const pause = h.request("pause");
    assert.equal((await action).code, 409);
    assert.equal((await pause).code, 409);
    assert.equal(h.state().phase, "blocked");
  } finally { finish?.({ spec: {}, payload: "done" }); await h.close(); }
});

test("stop finishes when an upstream action stalls", async () => {
  const h = await harness("direct", undefined, { expected: "", timeout: 40 });
  let finish!: (value: unknown) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<unknown>(resolve => { finish = resolve; });
  try {
    await h.launch();
    await h.create();
    await h.request("acquire", controller);
    h.setTool(async () => { entered(); return gate; });
    const action = h.request("tool", listTabs);
    await started;
    const stop = h.request("stop");
    assert.equal((await action).code, 409);
    assert.equal((await stop).code, 200);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(h.shutdowns(), 1);
  } finally { finish?.({ spec: {}, payload: "done" }); await h.close(); }
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
  const h = await harness("proxy");
  let finish!: (value: unknown) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<unknown>(resolve => { finish = resolve; });
  try {
    await h.launch();
    await h.create();
    await h.request("acquire", controller);
    h.setTool(async () => { entered(); return gate; });
    const action = h.request("tool", listTabs);
    await started;
    const before = h.checks();
    const recheck = h.request("check");
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(h.checks(), before);
    finish({ spec: {}, payload: "done" });
    assert.equal((await action).code, 200);
    assert.equal((await recheck).code, 200);
    assert.equal(h.checks(), before + 1);
  } finally { finish?.({ spec: {}, payload: "done" }); await h.close(); }
});

test("an upstream timeout error blocks further browser actions", async () => {
  const h = await harness("direct", undefined, { expected: "" });
  try {
    await h.launch();
    await h.create();
    await h.request("acquire", controller);
    h.setTool(async () => { throw Error("upstream request timed out"); });
    assert.equal((await h.request("tool", listTabs)).code, 409);
    assert.equal(h.state().phase, "blocked");
    assert.equal((await h.request("tool", listTabs)).code, 409);
  } finally { await h.close(); }
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
async function snapshotFixture(options: { structure?: unknown } = {}) {
  const state = { page: annotate(shop()), shot: undefined as unknown, route: 0 };
  const tab = { refs: new Map<string, unknown>(), lastSnapshot: null as unknown, page: { url: () => "https://shop.test/" } };
  const fixture = await canonicalHarness({ reply: path => {
    if (!path.endsWith("/snapshot")) return undefined;
    state.route++;
    tab.refs = new Map(state.page.refs); tab.lastSnapshot = state.page.yaml;
    const asked = new URL(fixture.requests.at(-1)!.url, "http://localhost").searchParams.get("includeScreenshot") === "true";
    return { code: 200, payload: { url: "https://shop.test/", snapshot: state.page.yaml.slice(0, 80_000), structure: options.structure, refsCount: state.page.refs.size,
      truncated: false, totalChars: state.page.yaml.length, hasMore: false, nextOffset: null, ...(asked ? { screenshot: state.shot } : {}) } };
  } });
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
    assert.equal((await f.read("tab_click", { ref: "e7" })).code, 200);
    assert.equal(f.requests.at(-1)!.url, `/tabs/${tabId}/click`);
    assert.deepEqual(f.requests.at(-1)!.body, { ref: "e7", userId: f.h.id });
    f.tab.refs = new Map([...f.tab.refs, ["e7", { role: "link", name: "Moved", nth: 0 }]]);
    assert.match(errorOf(await f.read("tab_click", { ref: "e7" })), /ref e7 may have shifted/);
    // A selector goes to Camofox as it is.
    assert.equal((await f.read("tab_click", { selector: "#save" })).code, 200);
    assert.deepEqual(f.requests.at(-1)!.body, { selector: "#save", userId: f.h.id });
    // A controller that has read nothing has no reliable refs.
    assert.equal((await f.h.request("release", { controllerId: controller.id })).code, 200);
    assert.equal((await f.h.request("acquire", { ...controller, id: "controller-b" })).code, 200);
    assert.match(errorOf(await f.as("controller-b")("tab_click", { ref: "e7" })), /ref e7 may have shifted/);
  } finally { await f.close(); }
});

test("a ref that moved after a diff is refused, and a ref that the diff showed is accepted", async () => {
  const f = await snapshotFixture();
  try {
    await f.start();
    payloadOf(await f.read("tab_snapshot", { collapse: false }));
    assert.equal((await f.read("tab_click", { ref: "e5" })).code, 200);
    f.state.page = annotate(shop({ top: ['  - button "Menu"'] }));
    const diff = payloadOf(await f.read("tab_snapshot", { diff: true, collapse: false }));
    assert.match(diff.snapshot, /\+ {2}- button "Menu" \[e1\]/);
    const requests = f.requests.length;
    assert.equal((await f.read("tab_click", { ref: "e1" })).code, 200);
    assert.match(errorOf(await f.read("tab_click", { ref: "e5" })), /ref e5 may have shifted/);
    assert.equal(f.requests.length, requests + 1);
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

test("a viewId pages the cached view without a request, and an unknown or replaced viewId fails", async () => {
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
    assert.match(errorOf(await f.read("tab_snapshot", { offset: first.nextOffset, viewId: "v999" })), /Read a new tab_snapshot\./);
    assert.match(errorOf(await f.read("tab_snapshot", { offset: first.nextOffset })), /needs the viewId/);
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
