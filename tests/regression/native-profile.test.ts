import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchProfileBrowser, claimProfileContext } from "../../src/browser/native-profile.ts";

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
    const browser = await launchProfileBrowser(f.launcher, { headless: false, proxy: options.proxy }, options, { directory: f.directory });
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
    const browser = await launchProfileBrowser(f.launcher, { proxy: { server: "http://one" } }, {}, { directory: f.directory });
    await assert.rejects(claimProfileContext(browser, { proxy: { server: "http://two", password: "secret" } }), error => {
      assert.match(String(error), /options disagree: proxy/); assert.doesNotMatch(String(error), /secret/); return true;
    });
    assert.equal(f.counts().newContexts, 0);
  } finally { f.close(); }
});

test("a native context closed before session admission is not recreated", async () => {
  const f = fixture();
  try {
    const browser = await launchProfileBrowser(f.launcher, {}, {}, { directory: f.directory });
    await f.context.close(); await assert.rejects(claimProfileContext(browser, {}), /closed/);
    assert.equal(f.counts().newContexts, 0);
  } finally { f.close(); }
});

test("a marked native profile refuses to replace a missing browser-data directory", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.directory, "native-profile.json"), '{"version":1}');
    await assert.rejects(launchProfileBrowser(f.launcher, {}, {}, { directory: f.directory }), /Native browser data is missing/);
    assert.deepEqual(f.counts(), { persistent: 0, ephemeral: 0, newContexts: 0 });
  } finally { f.close(); }
});
