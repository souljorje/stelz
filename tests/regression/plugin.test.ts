import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { freezeDevice, replayFingerprint, launchPreferences, applyProxyLocale } from "../../src/browser/fingerprint.ts";
import { locationResult } from "../../src/browser/location.ts";
import { register } from "../../src/browser/plugin.ts";
import { allowedBrowserTools } from "../../src/mcp/tool-policy.ts";
import { commitFingerprint, readFingerprintJournal, stageFingerprint, writeInitialized } from "../../src/browser/fingerprint-transaction.ts";
import type { Tool } from "../../src/browser/upstream.ts";
import { upstreamTyping } from "../helpers/upstream-typing.ts";
import { mockLauncherResources } from "../helpers/launcher-resources.ts";

mockLauncherResources();

const contractsUrl = pathToFileURL(join(dirname(createRequire(import.meta.url).resolve("@askjo/camofox-browser/package.json")),
  "mcp/lib/tool-contracts.mjs")).href;
const tabId = "79bed5c4-d5b8-4369-9d13-b159451ece91";

test("typing advertises optional per-call modes without changing upstream definitions", async () => {
  const { TOOL_DEFS } = await import(contractsUrl);
  const original = structuredClone(TOOL_DEFS);
  const tools = allowedBrowserTools<Tool>(TOOL_DEFS);
  assert.equal(tools.length, TOOL_DEFS.length - 2);
  const typing = tools.find((tool: { name: string }) => tool.name === "camofox_type");
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
  writeFileSync(join(root, "profiles.json"), JSON.stringify({ profiles: [{ id, typingMode: "balanced" }] }));
  writeFileSync(binary, "test browser binary");
  writeFileSync(join(upstream, "mcp/lib/tool-contracts.mjs"), fixture.canonical ? `export * from ${JSON.stringify(contractsUrl)};` : `
    export { TOOL_DEFS } from ${JSON.stringify(contractsUrl)};
    export async function runTool(name, args) { return globalThis.__stelzTool(name, args); }
    export function adaptResponse(_spec, payload) { return [{ type: "text", text: JSON.stringify(payload) }]; }
  `);
  const locationConfig = { timezone: "America/New_York", "locale:language": "en", "locale:region": "US", "geolocation:latitude": 40, "geolocation:longitude": -73 };
  const location = { version: 1, inputId: "fixture", attemptId: "test-start", result: { ...locationResult("ready"), valid: true, network: "passed", geoip: "passed" },
    prepared: { ip: "198.51.100.10", config: locationConfig, dataId: "fixture", engineId: "fixture" } };
  if (mode === "proxy") writeFileSync(join(stateDir, "location.json"), JSON.stringify(location));
  const settings = { STELZ_LOCATION_LAUNCH: JSON.stringify(location), STELZ_START_ID: "test-start", STELZ_HOME: root, STELZ_PROFILE_ID: id, STELZ_PROFILE_DIR: stateDir, STELZ_UPSTREAM: upstream,
    STELZ_CONFIGURATION_HASH: "a".repeat(64), STELZ_BOOTSTRAP_TOKEN: "test-bootstrap-secret",
    CAMOUFOX_EXECUTABLE: binary, PROXY_HOST: mode === "proxy" ? "127.0.0.1" : "", STELZ_EXPECTED_IP: fixture.expected ?? "198.51.100.10",
    CAMOFOX_PORT: String(fixture.port ?? 0), CAMOFOX_ACCESS_KEY: "fixture-key" };
  const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings);
  writeFileSync(join(stateDir, "running.json"), JSON.stringify({ instanceId: settings.STELZ_START_ID,
    configurationHash: settings.STELZ_CONFIGURATION_HASH, serverPid: process.pid }));
  const events = new EventEmitter(), routes = new Map<string, Handler>();
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
  await register(app, { auth: () => () => {}, events },
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
  return { id, identity, stateDir, binary, context, emit, state, options, launch, create, commit, request, rawRequest,
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
const snapshot = { controllerId: controller.id, name: "camofox_snapshot", args: { tabId } };

test("bootstrap preparation cannot admit control before the commit and matching marker", async () => {
  const h = await harness("direct", undefined, { expected: "" });
  try {
    await h.launch();
    await h.create(false);
    assert.equal(h.state().phase, "starting");
    assert.equal(existsSync(join(h.stateDir, "fingerprint.json")), false);
    for (const [action, body] of [["acquire", controller], ["check", {}], ["pause", {}], ["resume", {}],
      ["window-show", {}], ["tool", snapshot]] as const) assert.equal((await h.request(action, body)).code, 409, action);
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
    assert.equal((await h.request("tool", snapshot)).code, 409);
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
    assert.equal((await h.request("tool", snapshot)).code, 200);
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
        const body = { ...h.identity, ...controller, ...snapshot, ...invalid };
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
    assert.equal((await h.request("tool", snapshot)).code, 200);
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
    assert.equal((await h.request("tool", { ...snapshot, controllerId: next.id })).code, 200);
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
      assert.equal((await h.request(action, snapshot)).code, 409, action);
    }
    assert.equal((await h.request("release", { controllerId: controller.id })).code, 200);
    assert.deepEqual((await h.request("status")).payload, before);
    assert.equal(h.checks(), checks);
    assert.equal((await h.request("acquire", controller)).code, 409);
    assert.equal((await h.request("tool", { ...snapshot, controllerId: next.id })).code, 200);
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
      assert.equal((await h.rawRequest(action, { ...previous, ...snapshot })).code, 409);
    }
    assert.equal((await h.request("tool", snapshot)).code, 200);
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
      const response = await h.request(action, snapshot);
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
    assert.equal((await h.request("tool", { ...snapshot, controllerId: next.id })).code, 200);
  } finally { gate.resolve(); await h.close(); }
});

test("owned pause changes phase immediately and release waits for its admitted work", async () => {
  const h = await harness("direct", undefined, { expected: "" });
  const gate = Promise.withResolvers<void>(), started = Promise.withResolvers<void>();
  let paused = false, released = false, dispatched = 0;
  try {
    await h.launch(); await h.create(); await h.request("acquire", controller);
    h.setTool(async () => { dispatched++; started.resolve(); await gate.promise; return { spec: {}, payload: "ok" }; });
    const action = h.request("tool", snapshot);
    await started.promise;
    const queued = h.request("tool", snapshot);
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
    const action = h.request("tool", snapshot);
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
    assert.equal((await h.request("tool", { ...snapshot, controllerId: "controller-b" })).code, 200);
  } finally { gate.resolve(); await h.close(); }
});

async function canonicalHarness(options: { timeout?: number; type?: (body: Record<string, unknown>) => Promise<{ code: number; payload: unknown }> } = {}) {
  const requests: Array<{ method: string; url: string; authorization?: string; body?: Record<string, unknown> }> = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method!, url: req.url!, authorization: req.headers.authorization,
      body: body ? JSON.parse(body) : undefined });
    const path = new URL(req.url!, "http://localhost").pathname;
    if (path.endsWith("/type") && options.type) {
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
    for (const name of ["camofox_click", "camofox_type", "camofox_navigate", "camofox_scroll",
      "camofox_snapshot", "camofox_screenshot", "camofox_close_tab"]) {
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
      assert.equal((await h.request("tool", { ...snapshot, args })).code, 409);
    }
    assert.deepEqual(requests, []);
    assert.equal(h.state().phase, "ready");
    assert.equal((await h.request("tool", snapshot)).code, 200);
    assert.equal(requests.length, 1);
  } finally { await fixture.close(); }
});

test("canonical dispatch preserves valid tool routes, arguments, and authentication", async () => {
  const fixture = await canonicalHarness(), { h, requests } = fixture;
  try {
    await h.launch(); await h.create(); await h.request("acquire", controller);
    const cases: Array<[string, Record<string, unknown>, string, string]> = [
      ["camofox_create_tab", { url: "https://example.com" }, "POST", "/tabs"],
      ["camofox_list_tabs", {}, "GET", "/tabs"],
      ["camofox_click", { tabId, selector: "#x" }, "POST", `/tabs/${tabId}/click`],
      ["camofox_type", { tabId, selector: "#x", text: "hello" }, "POST", `/tabs/${tabId}/type`],
      ["camofox_navigate", { tabId, url: "https://example.com" }, "POST", `/tabs/${tabId}/navigate`],
      ["camofox_scroll", { tabId, direction: "down", amount: 100 }, "POST", `/tabs/${tabId}/scroll`],
      ["camofox_snapshot", { tabId, offset: 10 }, "GET", `/tabs/${tabId}/snapshot`],
      ["camofox_screenshot", { tabId }, "GET", `/tabs/${tabId}/screenshot`],
      ["camofox_close_tab", { tabId }, "DELETE", `/tabs/${tabId}`],
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
        assert.deepEqual(req.body, { ...body, userId: h.id, ...(name === "camofox_create_tab" ? { sessionKey: "default" } : {}),
          ...(name === "camofox_type" ? { typingMode: "balanced" } : {}) });
      } else assert.equal(url.searchParams.get("userId"), h.id);
      if (name === "camofox_snapshot") assert.equal(url.searchParams.get("offset"), "10");
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
      name: "camofox_type", args: { tabId, selector: "#message", text: "hello", ...args } });
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
    assert.equal((await type({ typingMode: "instant" })).code, 200);
    assert.equal(lastBody().typingMode, "keyboard", "Ignore caller-supplied internal fields");
    const count = requests.length;
    for (const mode of ["auto", "paced", "fill", "other", null, false, 1]) assert.equal((await type({ mode })).code, 409);
    assert.equal(requests.length, count);
    assert.equal(h.state().phase, "ready");
  } finally { await fixture.close(); }
});

test("the upstream typing timeout reaches the service as a terminal block", async () => {
  const route = upstreamTyping(async () => { throw Error("Keyboard timed out after 45000ms"); });
  const fixture = await canonicalHarness({ type: route.call }), { h, requests } = fixture;
  try {
    await h.launch(); await h.create(); await h.request("acquire", controller);
    const type = { controllerId: controller.id, name: "camofox_type",
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

test("the service deadline prevents overlap while the upstream typing lock remains held", async () => {
  let finish!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const route = upstreamTyping(async () => { entered(); await gate; });
  const fixture = await canonicalHarness({ type: route.call, timeout: 40 }), { h, requests } = fixture;
  try {
    await h.launch(); await h.create(); await h.request("acquire", controller);
    const type = { controllerId: controller.id, name: "camofox_type",
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
    const result = await h.request("tool", { controllerId: controller.id, name: "camofox_type",
      args: { tabId, selector: "#message", text: "hello" } });
    assert.equal(result.code, 200);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0]!.body, { selector: "#message", text: "hello", userId: h.id, typingMode: expected });
    assert.equal(((await h.request("status")).payload as { typingModeDefault: string }).typingModeDefault, fallback);
    const override = await h.request("tool", { controllerId: controller.id, name: "camofox_type",
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
    const actions = await Promise.all(Array.from({ length: 100 }, () => h.request("tool", snapshot)));
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
    assert.equal((await h.request("tool", snapshot)).code, 200);
    assert.equal(h.checks(), 1);
    clock = 120_100;
    const actions = await Promise.all(Array.from({ length: 5 }, () => h.request("tool", snapshot)));
    assert.ok(actions.every(action => action.code === 200)); assert.equal(h.checks(), 2);
    clock = 1;
    assert.equal((await h.request("tool", snapshot)).code, 200);
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
    for (let action = 0; action < 100; action++) assert.equal((await h.request("tool", snapshot)).code, 200);
    assert.equal(h.checks(), 1); assert.equal(dispatched, 100);
    clock = 120_000;
    const actions = await Promise.all(Array.from({ length: 5 }, () => h.request("tool", snapshot)));
    assert.ok(actions.every(action => action.code === 409));
    assert.equal(h.checks(), 2); assert.equal(dispatched, 100);
    assert.equal(h.state().verificationStatus, "verification_failed");
    assert.equal(h.state().phase, "verification_failed");
    assert.match(h.state().checkFailure!, /does not match/);
    h.setIP("198.51.100.10");
    assert.equal((await h.request("tool", snapshot)).code, 409);
    assert.equal(h.checks(), 2);
  } finally { await h.close(); }
});

test("recheck and resume bypass the cache and verification failure stays latched", async () => {
  const h = await harness("proxy", undefined, { interval: 120_000, now: () => 100 });
  try {
    await h.launch(); await h.create(); await h.request("acquire", controller);
    assert.equal((await h.request("check")).code, 200); assert.equal(h.checks(), 2);
    assert.equal((await h.request("pause")).code, 200);
    assert.equal((await h.request("tool", snapshot)).code, 409);
    assert.equal((await h.request("resume")).code, 200); assert.equal(h.checks(), 3);
    h.setIP("203.0.113.7");
    assert.equal((await h.request("check")).code, 409);
    const failedChecks = h.checks();
    h.setIP("198.51.100.10");
    assert.equal((await h.request("tool", snapshot)).code, 409);
    assert.equal(h.checks(), failedChecks);
    assert.equal((await h.request("check")).code, 200);
    assert.equal((await h.request("tool", snapshot)).code, 200);
    assert.equal(h.checks(), failedChecks + 1);
  } finally { await h.close(); }
});

test("an expired failed check blocks cached browser actions until recovery", async () => {
  let clock = 0;
  const h = await harness("proxy", undefined, { interval: 120_000, now: () => clock });
  try {
    await h.launch(); await h.create(); await h.request("acquire", controller);
    h.setIPError("offline"); clock = 119_999;
    assert.equal((await h.request("tool", snapshot)).code, 200);
    assert.equal(h.checks(), 1);
    clock = 120_000;
    assert.equal((await h.request("tool", snapshot)).code, 409);
    assert.equal(h.state().phase, "verification_failed");
    h.setIPError(undefined); clock = 0;
    assert.equal((await h.request("tool", snapshot)).code, 409);
    assert.equal((await h.request("check")).code, 200);
  } finally { await h.close(); }
});

test("a fresh cache cannot permit actions after the original browser is lost", async () => {
  const h = await harness("proxy", undefined, { interval: 120_000, now: () => 100 });
  try {
    await h.launch(); await h.create(); await h.request("acquire", controller);
    await h.emit("session:destroying", { userId: h.id });
    assert.equal((await h.request("tool", snapshot)).code, 409);
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
    assert.equal((await h.request("tool", snapshot)).code, 409);
    assert.equal(h.checks(), 2); assert.equal(dispatched, 1);
    assert.equal(h.state().verificationStatus, "verification_failed");
    assert.equal((await h.request("tool", snapshot)).code, 409);
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
    const failed = h.request("tool", snapshot);
    for (let attempt = 0; h.checks() < 2 && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(h.checks(), 2);
    const during = (await h.request("status")).payload as Record<string, unknown>;
    assert.equal(during.verificationStatus, "unverified"); assert.equal(during.verificationFresh, false);
    assert.equal(during.phase, "ready");
    const queued = h.request("tool", snapshot);
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
    assert.equal((await h.request("tool", snapshot)).code, 409);
    assert.equal(h.state().verificationStatus, "verification_failed");
    assert.equal((await h.request("tool", snapshot)).code, 409);
  } finally { await h.close(); }
});

test("page content, URLs, call logs, HTTP errors, and validation errors do not trigger IP checks", async () => {
  const h = await harness("proxy", undefined, { interval: 120_000, now: () => 0 });
  try {
    await h.launch(); await h.create(); await h.request("acquire", controller);
    h.setTool(async () => ({ spec: {}, payload: { snapshot: "NS_ERROR_PROXY_CONNECTION_REFUSED", url: "https://example.invalid/NS_ERROR_UNKNOWN_HOST" } }));
    assert.equal((await h.request("tool", snapshot)).code, 200);
    for (const message of [
      "500: An HTML body contains NS_ERROR_PROXY_CONNECTION_REFUSED",
      `500: ${JSON.stringify({ error: "Destination returned HTTP 503", code: "destination_unavailable" })}`,
      "page.goto: Invalid URL https://example.invalid/NS_ERROR_UNKNOWN_HOST",
      "Invalid selector\nCall log:\n  NS_ERROR_PROXY_CONNECTION_REFUSED",
    ]) {
      h.setTool(async () => { throw Error(message); });
      assert.equal((await h.request("tool", snapshot)).code, 409);
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
    assert.equal((await h.request("tool", snapshot)).code, 409);
    assert.equal(h.checks(), 0); assert.equal(h.state().phase, "ready");
  } finally { await h.close(); }
});

test("direct mode without an expected IP works when the IP service is unavailable", async () => {
  const h = await harness("direct", undefined, { expected: "", ipError: "offline" });
  try {
    await h.launch();
    await h.create();
    assert.equal((await h.request("acquire", controller)).code, 200);
    assert.equal((await h.request("tool", snapshot)).code, 200);
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
    assert.equal((await h.request("tool", snapshot)).code, 409);
    assert.equal(h.state().phase, "verification_failed");
    h.setIPError(undefined);
    assert.equal((await h.request("tool", snapshot)).code, 409);
    h.setIP("203.0.113.7");
    assert.equal((await h.request("check")).code, 409);
    assert.equal(h.state().phase, "verification_failed");
    h.setIP("198.51.100.10");
    assert.equal((await h.request("check")).code, 200);
    assert.equal(h.state().phase, "ready");
    assert.equal((await h.request("tool", snapshot)).code, 200);
  } finally { await h.close(); }
});

test("direct mode checks an explicitly expected IP and reports failure without proxy fallback wording", async () => {
  const h = await harness("direct");
  try {
    await h.launch(); await h.create();
    await h.request("acquire", controller);
    h.setIP("203.0.113.7");
    assert.equal((await h.request("tool", snapshot)).code, 409);
    assert.equal(h.state().phase, "verification_failed");
    assert.match(h.state().error!, /Expected exit IP/);
    assert.doesNotMatch(h.state().error!, /proxy|fallback/i);
    h.setIP("198.51.100.10");
    assert.equal((await h.request("check")).code, 200);
    assert.equal((await h.request("tool", snapshot)).code, 200);
  } finally { await h.close(); }
});

test("proxy mode verifies its exit even without an expected IP", async () => {
  const h = await harness("proxy", undefined, { expected: "" });
  try {
    await h.launch(); await h.create();
    assert.equal(h.checks(), 1);
    await h.request("acquire", controller);
    h.setIPError("offline");
    assert.equal((await h.request("tool", snapshot)).code, 409);
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

test("service rejects excluded upstream tools", async () => {
  const h = await harness("direct", undefined, { expected: "" });
  try {
    await h.launch();
    await h.create();
    await h.request("acquire", controller);
    for (const name of ["camofox_evaluate", "camofox_import_cookies"]) {
      assert.equal((await h.request("tool", { ...snapshot, name })).code, 409);
    }
    assert.equal((await h.request("tool", snapshot)).code, 200);
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
    const action = h.request("tool", snapshot);
    await started;
    const queued = h.request("tool", snapshot);
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
    const action = h.request("tool", snapshot);
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
    const action = h.request("tool", snapshot);
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
    assert.equal((await h.request("tool", snapshot)).code, 409);
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
    const action = h.request("tool", snapshot);
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
    assert.equal((await h.request("tool", snapshot)).code, 409);
    assert.equal(h.state().phase, "blocked");
    assert.equal((await h.request("tool", snapshot)).code, 409);
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
