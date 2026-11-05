import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { freezeDevice, replayFingerprint, launchPreferences } from "../../packages/stelz/src/browser/fingerprint.ts";
import { register } from "../../packages/stelz/src/browser/plugin.ts";

const contractsUrl = pathToFileURL(join(dirname(createRequire(import.meta.url).resolve("@askjo/camofox-browser/package.json")),
  "mcp/lib/tool-contracts.mjs")).href;
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

test("device replay preserves hardware but refreshes language, location, paths and new settings", () => {
  const saved = { ...generated, "navigator.hardwareConcurrency": 4, timezone: "Old/Zone", addons: [join(tmpdir(), "stelz-test-addons", "old")] };
  const fresh = { ...generated, "navigator.languages": ["en-GB"], "window.history.length": 3, futureSetting: true };
  const result = replayFingerprint(saved, fresh);
  assert.equal(result["navigator.hardwareConcurrency"], 4);
  for (const key of ["timezone", "addons", "navigator.languages", "window.history.length", "futureSetting"] as const) {
    assert.deepEqual(result[key], fresh[key]);
  }
  assert.equal(freezeDevice(saved).timezone, undefined);
});

test("proxy policy wins and unrelated fresh preferences survive", () => {
  assert.deepEqual(launchPreferences({ "media.peerconnection.enabled": true, "network.proxy.failover_direct": true,
    "network.proxy.socks_remote_dns": false, "network.proxy.socks5_remote_dns": false, "network.test": true, fresh: 1 }, true),
    { "media.peerconnection.enabled": false, "network.proxy.failover_direct": false,
      "network.proxy.socks_remote_dns": true, "network.proxy.socks5_remote_dns": true, "network.test": true, fresh: 1 });
  assert.deepEqual(launchPreferences({ fresh: 1 }, false), { fresh: 1 });
});

type App = Parameters<typeof register>[0];
type Handler = Parameters<App["post"]>[1];
async function harness(mode: "direct" | "proxy" = "direct", waitForIP?: Promise<void>,
  fixture: { expected?: string; timeout?: number; ipError?: string; canonical?: boolean; port?: number;
    interval?: number; now?: () => number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "stelz-regression-")), id = "profile-01";
  const stateDir = join(root, id), upstream = join(root, "upstream"), binary = join(root, "browser");
  mkdirSync(stateDir); mkdirSync(join(upstream, "mcp/lib"), { recursive: true });
  writeFileSync(binary, "test browser binary");
  writeFileSync(join(upstream, "mcp/lib/tool-contracts.mjs"), fixture.canonical ? `export * from ${JSON.stringify(contractsUrl)};` : `
    export { TOOL_DEFS } from ${JSON.stringify(contractsUrl)};
    export async function runTool(name, args) { return globalThis.__stelzTool(name, args); }
    export function adaptResponse(_spec, payload) { return [{ type: "text", text: JSON.stringify(payload) }]; }
  `);
  const settings = { STELZ_PROFILE_ID: id, STELZ_PROFILE_DIR: stateDir, STELZ_UPSTREAM: upstream,
    CAMOUFOX_EXECUTABLE: binary, STELZ_MODE: mode, STELZ_EXPECTED_IP: fixture.expected ?? "198.51.100.10",
    CAMOFOX_PORT: String(fixture.port ?? 0), CAMOFOX_ACCESS_KEY: "fixture-key" };
  const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings);
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
  const probe = { async goto() {}, async close() {}, async evaluate<T>(): Promise<T> {
    checks++;
    await ipGate;
    if (ipError) throw Error(ipError);
    return { ip } as T;
  } };
  const pages = new Set<EventEmitter>([new EventEmitter()]);
  const context = Object.assign(new EventEmitter(), { pages: () => [...pages], async newPage() { return probe; }, async close() { context.emit("close"); } });
  await register(app, { auth: () => () => {}, sessions: new Map([[id, {}]]), events,
    async createLeasedPage() { return { page: probe, lease: {} }; }, async closeLeasedPage() {} },
    { actionTimeoutMs: fixture.timeout, ipCheckIntervalMs: fixture.interval ?? 0, now: fixture.now,
      shutdown: () => { shutdowns++; events.emit("server:shutdown"); } });
  const emit = async (name: string, value: unknown = {}) => { await Promise.all(events.listeners(name).map(fn => fn(value))); };
  const state = () => JSON.parse(readFileSync(join(stateDir, "status.json"), "utf8")) as {
    phase: string; verificationStatus: string; verificationRequired: boolean; error?: string; checkFailure?: string;
  };
  const options = () => ({ env: { CAMOU_CONFIG_1: JSON.stringify(generated) } as Record<string, string>,
    firefoxUserPrefs: { fresh: true, "media.peerconnection.enabled": mode !== "proxy" } as Record<string, unknown>,
    ...(mode === "proxy" ? { proxy: { server: "http://127.0.0.1:9999" } } : {}) });
  const launch = async () => { const value = options(); await emit("browser:launching", { options: value }); return value; };
  const create = async () => {
    await emit("session:creating", { userId: id, contextOptions: {} });
    await emit("session:created", { userId: id, context });
  };
  const request = async (action: string, body: Record<string, unknown> = {}) => {
    let code = 200, payload: unknown;
    const response = { status(value: number) { code = value; return response; }, json(value: unknown) { payload = value; } };
    await routes.get(`/local-profile/${action}`)!({ body }, response);
    return { code, payload };
  };
  return { id, stateDir, binary, context, emit, state, options, launch, create, request,
    setIPGate(value: Promise<void> | undefined) { ipGate = value; },
    setIPError(value: string | undefined) { ipError = value; },
    setIP(value: string) { ip = value; },
    checks() { return checks; },
    shutdowns() { return shutdowns; },
    openPage() { const page = new EventEmitter(); pages.add(page); context.emit("page", page); return page; },
    closePage(page = [...pages][0]!) { pages.delete(page); page.emit("close"); },
    setTool(value: typeof runTool) { runTool = value; },
    async close() {
      await emit("server:shutdown");
      globals.__stelzTool = previousTool;
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      rmSync(root, { recursive: true, force: true });
    } };
}

test("the actual launch hook keeps WebRTC disabled when a legacy direct pin is reused with a proxy", async () => {
  const h = await harness("proxy");
  try {
    const pin = { version: 1, engineSha256: createHash("sha256").update(readFileSync(h.binary)).digest("hex"),
      config: generated, preferences: { "media.peerconnection.enabled": true, stale: true } };
    writeFileSync(join(h.stateDir, "fingerprint.json"), JSON.stringify(pin));
    const before = readFileSync(join(h.stateDir, "fingerprint.json"), "utf8");
    const options = await h.launch();
    assert.equal(options.firefoxUserPrefs["media.peerconnection.enabled"], false);
    assert.equal(options.firefoxUserPrefs["network.proxy.failover_direct"], false);
    assert.equal(options.firefoxUserPrefs["network.proxy.socks_remote_dns"], true);
    assert.equal(options.firefoxUserPrefs["network.proxy.socks5_remote_dns"], true);
    assert.equal((options.proxy as Record<string, unknown>).bypass, "127.0.0.1,localhost");
    assert.equal(options.firefoxUserPrefs.fresh, true);
    assert.equal(options.firefoxUserPrefs.stale, undefined);
    assert.equal(readFileSync(join(h.stateDir, "fingerprint.json"), "utf8"), before);
  } finally { await h.close(); }
});

test("a new pin stores device fields, not Firefox security preferences", async () => {
  const h = await harness();
  try {
    await h.launch();
    const pin = JSON.parse(readFileSync(join(h.stateDir, "fingerprint.json"), "utf8"));
    assert.equal(pin.version, 2); assert.equal(pin.preferences, undefined);
    assert.equal(pin.config.timezone, undefined); assert.equal(pin.config["canvas:seed"], 123);
  } finally { await h.close(); }
});

for (const version of [1, 2]) for (const enabled of [true, false]) {
  test(`the launch hook keeps schema-${version} WebGL2 support ${enabled} when the fresh GPU differs`, async () => {
    const h = await harness();
    try {
      const gpu = { "webGl:vendor": "saved GPU", "webGl:parameters": {},
        ...(enabled ? { "webGl2:parameters": {}, "webGl2:supportedExtensions": ["saved extension"] } : {}) };
      writeFileSync(join(h.stateDir, "fingerprint.json"), JSON.stringify({ version,
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

async function canonicalHarness() {
  const requests: Array<{ method: string; url: string; authorization?: string; body?: Record<string, unknown> }> = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method!, url: req.url!, authorization: req.headers.authorization,
      body: body ? JSON.parse(body) : undefined });
    if (new URL(req.url!, "http://localhost").pathname.endsWith("/screenshot")) {
      res.writeHead(200, { "Content-Type": "image/png" }).end("fixture-image");
    } else res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const h = await harness("direct", undefined, { expected: "", canonical: true, port: address.port });
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
        assert.deepEqual(req.body, { ...body, userId: h.id, ...(name === "camofox_create_tab" ? { sessionKey: "default" } : {}) });
      } else assert.equal(url.searchParams.get("userId"), h.id);
      if (name === "camofox_snapshot") assert.equal(url.searchParams.get("offset"), "10");
    }
    assert.equal(requests.length, cases.length);
  } finally { await fixture.close(); }
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

test("a startup IP failure leaves the original context available for recheck", async () => {
  const h = await harness("proxy", undefined, { ipError: "network unavailable" });
  try {
    await h.launch();
    await h.create();
    assert.equal(h.state().phase, "verification_failed");
    assert.equal((await h.request("acquire", controller)).code, 200);
    h.setIPError(undefined);
    assert.equal((await h.request("check")).code, 200);
    assert.equal(h.state().phase, "ready");
    assert.equal((await h.request("tool", snapshot)).code, 200);
    await assert.rejects(h.create(), /Replacement browser context refused/);
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

test("a stalled action times out, releases the queue, and blocks overlapping actions", async () => {
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
    const release = h.request("release", { controllerId: controller.id });
    assert.equal((await action).code, 409);
    assert.equal((await queued).code, 409);
    assert.equal((await release).code, 200);
    assert.equal(calls, 1);
    assert.equal(h.state().phase, "blocked");
    assert.equal((await h.request("acquire", { ...controller, id: "controller-b" })).code, 409);
    assert.equal((await h.request("check")).code, 409);
    finish({ spec: {}, payload: "late" });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(h.state().phase, "blocked");
  } finally { finish?.({ spec: {}, payload: "done" }); await h.close(); }
});

test("pause finishes when an upstream action stalls", async () => {
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
    assert.equal((await pause).code, 200);
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
