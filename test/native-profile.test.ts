import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { launchProfileBrowser, claimProfileContext } from "../src/native-profile.ts";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "stelz-native-"));
  let persistent = 0, ephemeral = 0, newContexts = 0, launchedPath = "", launchedOptions: Record<string, unknown> = {};
  const browser = { async newContext() { newContexts++; return context; } };
  const context = Object.assign(new EventEmitter(), {
    browser: () => browser,
    async close() { context.emit("close"); },
  });
  const launcher = {
    async launch() { ephemeral++; return browser; },
    async launchPersistentContext(path: string, options: Record<string, unknown>) {
      persistent++; launchedPath = path; launchedOptions = options; return context;
    },
  };
  return { directory, context, browser, launcher, counts: () => ({ persistent, ephemeral, newContexts }),
    launched: () => ({ path: launchedPath, options: launchedOptions }),
    close: () => rmSync(directory, { recursive: true, force: true }) };
}

test("native mode launches the directory-backed context and claims that exact context once", async () => {
  const f = fixture();
  try {
    const options = { viewport: null, permissions: ["geolocation"], proxy: { server: "http://example.test:8080" } };
    const browser = await launchProfileBrowser(f.launcher, { headless: false, proxy: options.proxy }, options, { mode: "native", directory: f.directory });
    assert.equal(f.launched().path, join(f.directory, "browser-data"));
    assert.deepEqual(f.launched().options.permissions, ["geolocation"]);
    assert.equal(await claimProfileContext(browser, options), f.context);
    await assert.rejects(claimProfileContext(browser, options), /already claimed/);
    assert.deepEqual(f.counts(), { persistent: 1, ephemeral: 0, newContexts: 0 });
  } finally { f.close(); }
});

test("native mode rejects a changed session proxy without leaking its credentials", async () => {
  const f = fixture();
  try {
    const browser = await launchProfileBrowser(f.launcher, { proxy: { server: "http://one" } }, {}, { mode: "native", directory: f.directory });
    await assert.rejects(claimProfileContext(browser, { proxy: { server: "http://two", password: "secret" } }), error => {
      assert.match(String(error), /options disagree: proxy/); assert.doesNotMatch(String(error), /secret/); return true;
    });
    assert.equal(f.counts().newContexts, 0);
  } finally { f.close(); }
});

test("a native context closed before session admission is not recreated", async () => {
  const f = fixture();
  try {
    const browser = await launchProfileBrowser(f.launcher, {}, {}, { mode: "native", directory: f.directory });
    await f.context.close(); await assert.rejects(claimProfileContext(browser, {}), /closed/);
    assert.equal(f.counts().newContexts, 0);
  } finally { f.close(); }
});

test("switching an existing checkpoint profile to native refuses without changing its data", async () => {
  const f = fixture();
  try {
    const path = join(f.directory, "storage", "hash", "storage_state.json");
    mkdirSync(join(f.directory, "storage", "hash"), { recursive: true }); writeFileSync(path, '{"cookies":[]}');
    await assert.rejects(launchProfileBrowser(f.launcher, {}, {}, { mode: "native", directory: f.directory }), /explicit migration/);
    assert.equal(readFileSync(path, "utf8"), '{"cookies":[]}');
    assert.deepEqual(f.counts(), { persistent: 0, ephemeral: 0, newContexts: 0 });
  } finally { f.close(); }
});

test("native mode detects checkpoints written by the installed upstream persistence code", async () => {
  const f = fixture();
  try {
    const upstream = dirname(createRequire(import.meta.url).resolve("@askjo/camofox-browser/package.json"));
    const { persistStorageState } = await import(pathToFileURL(join(upstream, "lib/persistence.js")).href);
    const result = await persistStorageState({ profileDir: join(f.directory, "storage"), userId: "profile-01",
      storageState: { cookies: [], origins: [{ origin: "https://example.com", localStorage: [{ name: "profile", value: "saved" }] }] } });
    assert.equal(result.persisted, true);
    const before = readFileSync(result.storageStatePath, "utf8");
    await assert.rejects(launchProfileBrowser(f.launcher, {}, {}, { mode: "native", directory: f.directory }), /explicit migration/);
    assert.equal(readFileSync(result.storageStatePath, "utf8"), before);
    assert.equal(existsSync(join(f.directory, "browser-data")), false);
    assert.deepEqual(f.counts(), { persistent: 0, ephemeral: 0, newContexts: 0 });
  } finally { f.close(); }
});

test("existing checkpoint mode retains the upstream launch path", async () => {
  const f = fixture();
  try {
    const browser = await launchProfileBrowser(f.launcher, {}, {}, { mode: "checkpoint", directory: f.directory });
    assert.equal(browser, f.browser); assert.deepEqual(f.counts(), { persistent: 0, ephemeral: 1, newContexts: 0 });
  } finally { f.close(); }
});

test("a native profile cannot silently fall back to old checkpoints", async () => {
  const f = fixture();
  try {
    await launchProfileBrowser(f.launcher, {}, {}, { mode: "native", directory: f.directory });
    await assert.rejects(launchProfileBrowser(f.launcher, {}, {}, { mode: "checkpoint", directory: f.directory }), /stale checkpoints/);
    assert.equal(f.counts().ephemeral, 0);
  } finally { f.close(); }
});

test("native browser data prevents checkpoint fallback even when its marker is missing", async () => {
  const f = fixture();
  try {
    const directory = join(f.directory, "browser-data");
    mkdirSync(directory); writeFileSync(join(directory, "cookies.sqlite"), "saved login");
    await assert.rejects(launchProfileBrowser(f.launcher, {}, {}, { mode: "checkpoint", directory: f.directory }), /stale checkpoints/);
    assert.equal(readFileSync(join(directory, "cookies.sqlite"), "utf8"), "saved login");
    assert.equal(f.counts().ephemeral, 0);
  } finally { f.close(); }
});

test("an interrupted native launch cannot permit checkpoint fallback", async () => {
  const f = fixture();
  try {
    const launcher = { ...f.launcher, async launchPersistentContext(directory: string) {
      writeFileSync(join(directory, "cookies.sqlite"), "partial profile"); throw Error("Launch interrupted");
    } };
    await assert.rejects(launchProfileBrowser(launcher, {}, {}, { mode: "native", directory: f.directory }), /Launch interrupted/);
    await assert.rejects(launchProfileBrowser(f.launcher, {}, {}, { mode: "checkpoint", directory: f.directory }), /stale checkpoints/);
    assert.equal(f.counts().ephemeral, 0);
  } finally { f.close(); }
});

test("a marked native profile refuses to replace a missing browser-data directory", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.directory, "native-profile.json"), '{"version":1}');
    await assert.rejects(launchProfileBrowser(f.launcher, {}, {}, { mode: "native", directory: f.directory }), /Native browser data is missing/);
    assert.deepEqual(f.counts(), { persistent: 0, ephemeral: 0, newContexts: 0 });
  } finally { f.close(); }
});
