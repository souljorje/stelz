import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { freezeDevice, replayFingerprint, launchPreferences } from "../src/fingerprint.ts";
import { register } from "../src/plugin.ts";

const generated = { "navigator.userAgent": "test UA", "navigator.hardwareConcurrency": 8,
  "navigator.languages": ["en-US"], "screen.width": 1440, "window.history.length": 1,
  timezone: "America/New_York", addons: [join(tmpdir(), "stelz-test-addons", "current")], "canvas:seed": 123 };

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
  assert.deepEqual(launchPreferences({ "media.peerconnection.enabled": true, "network.test": true, fresh: 1 }, true),
    { "media.peerconnection.enabled": false, "network.test": true, fresh: 1 });
  assert.deepEqual(launchPreferences({ fresh: 1 }, false), { fresh: 1 });
});

type App = Parameters<typeof register>[0];
type Handler = Parameters<App["post"]>[1];
async function harness(mode: "direct" | "proxy" = "direct", waitForIP?: Promise<void>,
  fixture: { expected?: string; timeout?: number; ipError?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "stelz-regression-")), id = "identity-01";
  const stateDir = join(root, id), upstream = join(root, "upstream"), binary = join(root, "browser");
  mkdirSync(stateDir); mkdirSync(join(upstream, "mcp/lib"), { recursive: true });
  writeFileSync(binary, "test browser binary");
  writeFileSync(join(upstream, "mcp/lib/tool-contracts.mjs"), `
    export const TOOL_DEFS = ["camofox_snapshot", "camofox_evaluate", "camofox_import_cookies"]
      .map(name => ({ name, description: name, inputSchema: { type: "object" } }));
    export async function runTool(name, args) { return globalThis.__stelzTool(name, args); }
    export function adaptResponse(_spec, payload) { return [{ type: "text", text: JSON.stringify(payload) }]; }
  `);
  const settings = { STELZ_PROFILE_ID: id, STELZ_PROFILE_DIR: stateDir, STELZ_UPSTREAM: upstream,
    CAMOUFOX_EXECUTABLE: binary, STELZ_MODE: mode, STELZ_EXPECTED_IP: fixture.expected ?? "198.51.100.10" };
  const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings);
  const events = new EventEmitter(), routes = new Map<string, Handler>();
  const app: App = { get(path, ...handlers) { routes.set(path, handlers.at(-1)!); }, post(path, ...handlers) { routes.set(path, handlers.at(-1)!); } };
  let ipGate = waitForIP;
  let ipError = fixture.ipError;
  let ip = "198.51.100.10";
  let checks = 0;
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
  const context = Object.assign(new EventEmitter(), { async newPage() { return probe; }, async close() { context.emit("close"); } });
  await register(app, { auth: () => () => {}, sessions: new Map([[id, {}]]), events,
    async createLeasedPage() { return { page: probe, lease: {} }; }, async closeLeasedPage() {} },
    { actionTimeoutMs: fixture.timeout });
  const emit = async (name: string, value: unknown = {}) => { await Promise.all(events.listeners(name).map(fn => fn(value))); };
  const state = () => JSON.parse(readFileSync(join(stateDir, "status.json"), "utf8")) as { phase: string; error?: string; checkFailure?: string };
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

test("a browser context close event blocks replacement even without an upstream lifecycle event", async () => {
  const h = await harness();
  try {
    await h.launch(); await h.create(); await h.context.close();
    assert.equal(h.state().phase, "blocked");
    await assert.rejects(h.create(), /Replacement browser context refused/);
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
const snapshot = { controllerId: controller.id, name: "camofox_snapshot", args: {} };

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
  const originalKill = process.kill;
  let signalled = false;
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (pid === process.pid && signal === "SIGTERM") { signalled = true; return true; }
    return originalKill(pid, signal);
  }) as typeof process.kill;
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
    assert.equal(signalled, true);
  } finally { process.kill = originalKill; finish?.({ spec: {}, payload: "done" }); await h.close(); }
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
