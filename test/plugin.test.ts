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
  timezone: "America/New_York", addons: ["/current/addon"], "canvas:seed": 123 };

test("device replay preserves hardware but refreshes language, location, paths and new settings", () => {
  const saved = { ...generated, "navigator.hardwareConcurrency": 4, timezone: "Old/Zone", addons: ["/old/addon"] };
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
async function harness(mode: "direct" | "proxy" = "direct", waitForIP?: Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "stelz-regression-")), id = "identity-01";
  const stateDir = join(root, id), upstream = join(root, "upstream"), binary = join(root, "browser");
  mkdirSync(stateDir); mkdirSync(join(upstream, "mcp/lib"), { recursive: true });
  writeFileSync(binary, "test browser binary");
  writeFileSync(join(upstream, "mcp/lib/tool-contracts.mjs"), 'export const TOOL_DEFS = [];');
  const settings = { STELZ_PROFILE_ID: id, STELZ_PROFILE_DIR: stateDir, STELZ_UPSTREAM: upstream,
    CAMOUFOX_EXECUTABLE: binary, STELZ_MODE: mode, STELZ_EXPECTED_IP: "198.51.100.10" };
  const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings);
  const events = new EventEmitter(), routes = new Map<string, Handler>();
  const app: App = { get(path, ...handlers) { routes.set(path, handlers.at(-1)!); }, post(path, ...handlers) { routes.set(path, handlers.at(-1)!); } };
  let ipGate = waitForIP;
  const probe = { async goto() {}, async close() {}, async evaluate<T>(): Promise<T> {
    await ipGate; return { ip: "198.51.100.10" } as T;
  } };
  const context = Object.assign(new EventEmitter(), { async newPage() { return probe; }, async close() { context.emit("close"); } });
  await register(app, { auth: () => () => {}, sessions: new Map([[id, {}]]), events,
    async createLeasedPage() { return { page: probe, lease: {} }; }, async closeLeasedPage() {} });
  const emit = async (name: string, value: unknown = {}) => { await Promise.all(events.listeners(name).map(fn => fn(value))); };
  const state = () => JSON.parse(readFileSync(join(stateDir, "status.json"), "utf8")) as { phase: string; error?: string };
  const options = () => ({ env: { CAMOU_CONFIG_1: JSON.stringify(generated) } as Record<string, string>,
    firefoxUserPrefs: { fresh: true, "media.peerconnection.enabled": mode !== "proxy" } as Record<string, unknown>,
    ...(mode === "proxy" ? { proxy: { server: "http://127.0.0.1:9999" } } : {}) });
  const launch = async () => { const value = options(); await emit("browser:launching", { options: value }); return value; };
  const create = async () => {
    await emit("session:creating", { userId: id, contextOptions: {} });
    await emit("session:created", { userId: id, context });
  };
  const request = async (action: string) => {
    let code = 200, payload: unknown;
    const response = { status(value: number) { code = value; return response; }, json(value: unknown) { payload = value; } };
    await routes.get(`/local-profile/${action}`)!({}, response);
    return { code, payload };
  };
  return { id, stateDir, binary, context, emit, state, options, launch, create, request,
    setIPGate(value: Promise<void> | undefined) { ipGate = value; },
    async close() {
      await emit("server:shutdown");
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
    await h.request("pause"); resolve();
    assert.equal((await check).code, 409);
    assert.equal(h.state().phase, "paused");
    h.setIPGate(undefined);
    assert.equal((await h.request("resume")).code, 200);
    assert.equal(h.state().phase, "ready");
  } finally { resolve(); await h.close(); }
});
