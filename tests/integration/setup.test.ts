import { afterAll, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(import.meta.dir, "../.."), temporary: string[] = [];
const realNode = Bun.which("node")!;
afterAll(() => { for (const path of temporary) rmSync(path, { recursive: true, force: true }); });

function file(path: string, value: string) {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, value);
}
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "stelz-setup-test-")); temporary.push(base);
  const project = join(base, "project"), home = join(base, "home"), browser = join(base, "browser");
  mkdirSync(project); mkdirSync(home);
  cpSync(join(root, "src"), join(project, "src"), { recursive: true });
  file(join(project, "src/setup-driver.ts"), `import { setup } from "./browser/setup.ts";
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import { start } from "./runtime/runtime.ts";
if (process.argv[2] === "setup") console.log(JSON.stringify(await setup({ yes: true, prepareModel: async stage => {
  if(process.env.SETUP_TEST_MODEL_FAIL) {
    mkdirSync(join(stage,'fpgen'));writeFileSync(join(stage,'fpgen/values.dat'),'incomplete model');
    throw Error('Fingerprint model preparation failed');
  }
  return 'reused';
}, prepareGeoip: async stage => {
  if(process.env.SETUP_TEST_GEOIP_FAIL) {
    mkdirSync(join(stage,'geoip'));writeFileSync(join(stage,'geoip/GeoLite2-City.mmdb'),'incomplete download');
    throw Error('Location-data integrity check failed');
  }
  return { datasets: {}, status: {} };
} })));
else if (process.argv[2] === "setup-unconfirmed") await setup({ confirm: async downloads => { console.log(JSON.stringify(downloads)); return false; } });
else await start(process.argv[3]!);
`);
  file(join(project, "package.json"), JSON.stringify({ type: "module", version: "0.2.0", dependencies: { "@askjo/camofox-browser": "1.18.1", "@modelcontextprotocol/sdk": "1.30.0", "better-sqlite3": "13.0.1", camoufox: "0.5.8", impit: "0.14.8" } }));
  file(join(project, "dist/plugin.js"), "export function register() {}\nexport function launchProfileBrowser() {}\nexport function claimProfileContext() {}\nexport function createProfilePage() {}\nexport function protectProfileStartup() {}\nexport function prepareProfileLaunch() {}\nexport function typeIntoLocator() {}\n");
  const upstream = join(project, "node_modules/@askjo/camofox-browser");
  file(join(upstream, "package.json"), JSON.stringify({ name: "@askjo/camofox-browser", version: "1.18.1", type: "module", dependencies: { camoufox: "0.5.8", "playwright-core": "1.62.1" } }));
  file(join(upstream, "server.js"), `import { Camoufox, launchOptions, VirtualDisplay } from 'camoufox';
import {
  isTimeoutError,
} from './lib/browser-errors.js';
import { clickReachedPage, domClickRejected, uncertainClickError } from './lib/stelz-click-guard.js';
import { isOrphanPage, ownPage } from './lib/stelz-page-ownership.js';
async function safePageClose(page) {
  if (!page || page.isClosed()) return;
  ownPage(page);
  await page.close();
}
function createTabState(page) {
  ownPage(page);
  return { page };
}
function reapOrphans(session, contextPages, registered, isPageLeased) {
  for (const page of contextPages) {
      // stelz: a page that a person or a website opened is not an orphan.
      if (isOrphanPage(page, registered, isPageLeased(session, page))) {
        page.close();
      }
  }
}
async function recoverForceClickFailure(dispatchDomClick, dispatchMouseSequence, log) {
        try {
          await dispatchDomClick();
        } catch (domErr) {
          // stelz: a DOM click can reach the page before it fails. Then the mouse sequence would repeat it.
          if (!domClickRejected(domErr)) throw uncertainClickError(domErr);
          log('warn', 'DOM click fallback failed, trying mouse sequence', { error: domErr.message });
          await dispatchMouseSequence();
        }
}
async function clickRoute(click, log, remainingBudget, onGoogleSerp) {
        const inputTimeout = () => Math.max(1, remainingBudget());
        if (onGoogleSerp) {
          try {
            await click({ timeout: inputTimeout(), force: true });
          } catch (forceErr) {
            if (clickReachedPage(forceErr)) throw uncertainClickError(forceErr);
            log('warn', 'google force click failed, trying DOM click fallback');
          }
          return;
        }
        try {
          await click({ timeout: 3000, trial: true });
        } catch (err) {
          // A trial sends no input, although Playwright still logs "performing click action" for it.
          if (isTimeoutError(err)) {
            log('warn', 'click intercepted, retrying with force');
            try {
              await click({ timeout: inputTimeout(), force: true });
            } catch (forceErr) {
              if (clickReachedPage(forceErr)) throw uncertainClickError(forceErr);
            }
          } else {
            log('warn', 'click timeout, retrying with force');
            try {
              await click({ timeout: inputTimeout(), force: true });
            } catch (forceErr) {
              if (clickReachedPage(forceErr)) throw uncertainClickError(forceErr);
            }
          }
          return;
        }
        // stelz: a failure after input started is uncertain. Never repeat it.
        try {
          await click({ timeout: inputTimeout() });
        } catch (err) {
          if (clickReachedPage(err)) throw uncertainClickError(err);
          throw err;
        }
}
const externalCamoufox = null; // stelz: the plugin passes the executable to the official launcher.
class DefaultVirtualDisplay extends VirtualDisplay { constructor() { super(false, DEFAULT_VIRTUAL_DISPLAY_RESOLUTION); } }
async function fillLocator(locator, text, typingMode) {
  await (await import('./plugins/local-profile/index.js')).typeIntoLocator(locator, text, typingMode);
}
async function withTabLock(tabId, operation, timeoutMs) {
    // Stelz owns the deadline for typing. Keep its tab lock until input settles.
    return await (timeoutMs === null ? operation() : withTimeout(operation(), timeoutMs, 'action'));
}
async function scrollRoute(tabState, isVertical, delta) {
      await tabState.page.bringToFront();
      await tabState.page.mouse.wheel(isVertical ? 0 : delta, isVertical ? delta : 0);
}
const options = { os: hostOS,
        window: [1200, 800],
        screen: { minWidth: 1280, minHeight: 900, maxWidth: 1920, maxHeight: 1200 },
        humanize: true, proxy: launchProxy,
        block_webrtc: !!launchProxy,
        geoip: !!launchProxy, };
async function prepare() {
  const prepared = await (await import('./plugins/local-profile/index.js')).prepareProfileLaunch(baseOptions, async options => options);
}
async function launch() {
  candidateBrowser = await (await import('./plugins/local-profile/index.js')).launchProfileBrowser(firefox, options, { viewport: null, ...contextIdentityOptions({ hasProxy: !!proxyPool, directIdentity: CONFIG.directIdentity }) });
  const context = await (await import('./plugins/local-profile/index.js')).claimProfileContext(b, contextOptions);
      created.releaseProfileStartup = (await import('./plugins/local-profile/index.js')).protectProfileStartup(created, { acquirePageLease, setLeasedPage, releasePageLease });
      sessions.set(key, created);
      await pluginEvents.emitAsync('session:created', { userId: key, context });
}
let stelzStartupAdmitted = false;
app.post('/tabs', async (req, res) => {
  let createdTabId = null;
  let abandoned = false;
  let profileStartup = false;
  const discardCreatedTab = async () => {
    if (!createdTabId || profileStartup) return;
  };
    if (req.body.stelzStartup !== undefined) {
      if (req.body.stelzStartup !== true || stelzStartupAdmitted || sessions.has(normalizeUserId(userId)) ||
          userId !== process.env.STELZ_PROFILE_ID || sessionKey !== 'default' ||
          Object.keys(req.body).some(key => !['userId', 'sessionKey', 'stelzStartup'].includes(key))) {
        throw Object.assign(new Error('Invalid or repeated profile startup request'), { statusCode: 409 });
      }
      stelzStartupAdmitted = profileStartup = true;
      // Startup verification has its own service deadline. Normal /tabs calls keep theirs.
      // The supervisor waits for browser prewarm before this one-time initialization.
      await getSession(userId);
    }

    // Session overflow redirect (Fly.io only)
      createdTabId = tabId;
      session.releaseProfileStartup?.();
      delete session.releaseProfileStartup;
      releasePageLease(session, lease);
});
async function typeRoute(req, locator, tabState, selector, text, mode) {
  try {
    const { userId, ref, selector, text, typingMode, mode = 'fill', delay = 30, submit = false, pressEnter = false } = req.body;
    await withTabLock(tabId, async () => {
      if (mode === 'fill') {
        if (locator) {
          await fillLocator(locator, text, typingMode);
        } else {
          await fillLocator(tabState.page.locator(selector), text, typingMode);
        }
      }
      if (shouldSubmit) await tabState.page.keyboard.press('Enter');
    }, typingMode === undefined ? HANDLER_TIMEOUT_MS : null);
  } catch (err) {
    if (req.body.typingMode !== undefined && /timed out|timeout/i.test(err.message || '')) {
      return res.status(409).json({
        error: 'Typing timeout. Input may be incomplete. Stop and start the profile before another browser action.',
        code: 'typing_timeout',
        retryable: false,
      });
    }
    if (err.message?.includes('timed out') || err.message?.includes('not an <input>')) {
      throw err;
    }
  }
}
`);
  file(join(upstream, "LICENSE"), "fixture license");
  file(join(upstream, "lib/stelz-page-ownership.js"), "const owned = new WeakSet();\nexport function ownPage(page) { owned.add(page); return page; }\nexport function isOrphanPage(page, registered, leased) {\n  return owned.has(page) && !registered.has(page) && !leased;\n}\n");
  file(join(upstream, "lib/browser-errors.js"), "export function isTimeoutError() { return false; }\n");
  file(join(upstream, "lib/stelz-click-guard.js"), "export function clickReachedPage(error) { return String(error?.message || '').includes('performing click action'); }\nexport function domClickRejected() { return false; }\nexport function uncertainClickError(cause) { return Object.assign(Error('uncertain'), { cause }); }\n");
  file(join(upstream, "lib/browser-identity.js"), "function contextIdentityOptions(hasProxy) { if (hasProxy) return {}; // Stelz never grants location access to arbitrary sites.\n}\n");
  file(join(upstream, "lib/new-page-recovery.js"), `async function createPageWithSessionRecovery(session) {
  try {
    const page = setLeasedPage(lease, await withTimeout((await import('../plugins/local-profile/index.js')).createProfilePage(session.context), timeoutMs, 'new page'));
    return { session, page, lease };
  } catch (err) {
    const page = setLeasedPage(lease, await withTimeout((await import('../plugins/local-profile/index.js')).createProfilePage(session.context), timeoutMs, 'new page retry'));
    return { session, page, lease };
  }
}
`);
  file(join(upstream, "mcp/server.mjs"), "export {};\n");
  file(join(upstream, "mcp/lib/tool-contracts.mjs"), "export const TOOL_DEFS = [];\nexport function runTool() {}\nexport function adaptResponse() {}\n");
  file(join(upstream, "plugins/persistence/index.js"), "export async function register(app, ctx, pluginConfig = {}) {\n  return; // Native Firefox profile owns storage.\n}\n");
  const camoufox = join(project, "node_modules/camoufox");
  file(join(camoufox, "package.json"), JSON.stringify({ name: "camoufox", version: "0.5.8", type: "module" }));
  file(join(camoufox, "dist/index.js"), "export {};\n");
  file(join(camoufox, "dist/coherence.js"), "export function validate() { return []; }\n");
  file(join(camoufox, "dist/fpgen/index.js"), 'export function isModelInstalled() { return false; }\nexport const MODEL_PIN = { repo: "scrapfly/fingerprint-generator", tag: "model-2/2026", size: 1564571 };\n');
  file(join(camoufox, "dist/data-files/browser-pin.json"), JSON.stringify({ version: "156.0.1", build: "beta.36" }));
  for (const [name, version] of [["playwright-core", "1.62.1"], ["@modelcontextprotocol/sdk", "1.30.0"], ["better-sqlite3", "13.0.1"], ["impit", "0.14.8"]]) {
    file(join(project, "node_modules", name!, "package.json"), JSON.stringify({ name, version }));
  }
  file(browser, "browser executable fixture");
  file(join(base, "application.ini"), "[App]\nVersion=156.0.1-beta.36\n");
  file(join(base, "version.json"), JSON.stringify({ version: "browser-fixture" }));
  const bin = join(base, "bin"), wrapper = join(bin, "node");
  file(wrapper, `#!${process.execPath}
import { existsSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--check" && args[1]?.endsWith("/plugins/local-profile/index.js")) {
  if (process.env.SETUP_TEST_GATE) {
    writeFileSync(process.env.SETUP_TEST_GATE, String(process.pid));
    while (!existsSync(process.env.SETUP_TEST_RELEASE)) await Bun.sleep(10);
  }
  if (process.env.SETUP_TEST_FAIL) { console.error("forced validation failure"); process.exit(1); }
}
const child = Bun.spawn([process.env.SETUP_TEST_REAL_NODE, ...args], { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
process.exit(await child.exited);
`);
  chmodSync(wrapper, 0o755);
  return { base, project, home, browser, upstream, bin, gate: join(base, "gate"), release: join(base, "release") };
}
type Fixture = ReturnType<typeof fixture>;
function installedRuntime(f: Fixture) {
  file(join(f.home, "runtime/camofox-1.18.1/server.js"), "old server");
  file(join(f.home, "runtime/versions.json"), JSON.stringify({ old: "successful manifest" }));
}
function launch(f: Fixture, command = "setup", extra: Record<string, string> = {}) {
  return Bun.spawn([process.execPath, "--no-env-file", join(f.project, "src/setup-driver.ts"), ...command.split(" ")], {
    cwd: f.project, env: { ...process.env, STELZ_HOME: f.home, CAMOUFOX_EXECUTABLE: f.browser, PATH: `${f.bin}:${process.env.PATH}`, SETUP_TEST_REAL_NODE: realNode, ...extra }, stdout: "pipe", stderr: "pipe",
  });
}
async function finish(child: ReturnType<typeof launch>) {
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}
async function until(predicate: () => boolean, description: string) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (predicate()) return; await Bun.sleep(10); }
  throw Error(`Timed out waiting for ${description}`);
}
function oldRuntime(f: Fixture) {
  expect(readFileSync(join(f.home, "runtime/camofox-1.18.1/server.js"), "utf8")).toBe("old server");
  expect(JSON.parse(readFileSync(join(f.home, "runtime/versions.json"), "utf8"))).toEqual({ old: "successful manifest" });
}
function releaseGate(f: Fixture) { file(f.release, "release"); }
function stopGate(f: Fixture) {
  releaseGate(f);
}
const gated = (f: Fixture) => ({ SETUP_TEST_GATE: f.gate, SETUP_TEST_RELEASE: f.release });
const generations = (f: Fixture) => join(f.home, "runtime-generations");
const current = (f: Fixture) => readlinkSync(join(f.home, "runtime")).replace(/^runtime-generations\//, "");
const stages = (f: Fixture) => existsSync(generations(f)) ? readdirSync(generations(f)).filter(name => name.startsWith(".stage-")) : [];
async function prepared(f: Fixture) {
  const result = await finish(launch(f));
  if (result.code) throw Error(result.stderr || result.stdout);
  return (JSON.parse(result.stdout.trim().split("\n").at(-1)!) as { runtime: { id: string; status: "reused" | "prepared" } }).runtime;
}
/** A recorded service. The live PID has no start stamp, so its ownership is unverified and it counts as running. */
function service(f: Fixture, id: string, extra: Record<string, unknown> = {}) {
  file(join(f.home, "profiles", id, "running.json"), JSON.stringify({ version: 2, pid: process.pid, instanceId: "live", configurationHash: "fixture", ...extra }));
}

test("activates a complete runtime generation, replacing the installed runtime, and reuses an unchanged one", async () => {
  const f = fixture(); installedRuntime(f);
  const runtimes = [];
  for (let i = 0; i < 2; i++) {
    runtimes.push(await prepared(f));
    const manifest = JSON.parse(readFileSync(join(f.home, "runtime/versions.json"), "utf8"));
    expect(manifest.upstreamVersion).toBe("1.18.1");
    expect(manifest.browserVersion).toEqual({ version: "browser-fixture" });
    expect(manifest.executableSha256).toHaveLength(64);
    const server = readFileSync(join(f.home, "runtime/camofox-1.18.1/server.js"), "utf8");
    expect(server).toContain("launchProfileBrowser");
    expect(server).toContain("block_webrtc: !!launchProxy");
    expect(server).toContain("typeIntoLocator(locator, text, typingMode)");
    const recovery = readFileSync(join(f.home, "runtime/camofox-1.18.1/lib/new-page-recovery.js"), "utf8");
    expect(recovery.split("createProfilePage(session.context)")).toHaveLength(3);
    expect(recovery).not.toContain("session.context.newPage()");
    expect(existsSync(join(f.home, "runtime/camofox-1.18.1/plugins/local-profile/index.js"))).toBe(true);
    for (const name of ["better-sqlite3", "impit"]) expect(existsSync(join(f.home, "runtime/camofox-1.18.1/node_modules", name, "package.json"))).toBe(true);
  }
  expect(runtimes.map(runtime => runtime.status)).toEqual(["prepared", "reused"]);
  expect(runtimes[1]!.id).toBe(runtimes[0]!.id);
  expect(runtimes[0]!.id).toMatch(/^[a-f0-9]{16}$/);
  expect(current(f)).toBe(runtimes[0]!.id);
  expect(readdirSync(generations(f))).toEqual([runtimes[0]!.id]);
}, 30000);

test("setup without consent lists its downloads and changes nothing", async () => {
  const f = fixture();
  const result = await finish(launch(f, "setup-unconfirmed"));
  expect(result.code).not.toBe(0);
  const downloads = JSON.parse(result.stdout.trim()) as { name: string; size: string; purpose: string; source: string }[];
  expect(downloads.map(item => item.name)).toEqual(["GeoIP AIO location data", "GeoLite2 City location data", "Fingerprint model"]);
  expect(downloads.map(item => item.source)).toEqual(["https://github.com/daijro/geoip-all-in-one/releases/latest",
    "https://github.com/P3TERX/GeoLite.mmdb/releases/latest", "https://github.com/scrapfly/fingerprint-generator/releases/tag/model-2/2026"]);
  expect(downloads.every(item => item.size && item.purpose)).toBe(true);
  expect(result.stderr).toContain("Run stelz setup --yes to allow them.");
  expect(existsSync(join(f.home, "runtime"))).toBe(false);
});

test("validation failure preserves the previous runtime and manifest", async () => {
  const f = fixture(); installedRuntime(f);
  const result = await finish(launch(f, "setup", { SETUP_TEST_FAIL: "1" }));
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("forced validation failure");
  oldRuntime(f);
  expect(stages(f)).toEqual([]);
});

test("a failed location download cannot replace active data or unrelated settings", async () => {
  const f = fixture(); installedRuntime(f);
  const files = { "runtime/geoip/GeoLite2-City.mmdb": "previous validated bytes", "runtime/geoip/manifest.json": '{"release":"previous"}',
    "profiles.json": '{"profiles":[]}', "secrets.env": "UNCHANGED=private-fixture\n" };
  for (const [name, value] of Object.entries(files)) file(join(f.home, name), value);
  const result = await finish(launch(f, "setup", { SETUP_TEST_GEOIP_FAIL: "1" }));
  expect(result.code).not.toBe(0); expect(result.stderr).toContain("Location-data integrity");
  oldRuntime(f);
  for (const [name, value] of Object.entries(files)) expect(readFileSync(join(f.home, name), "utf8")).toBe(value);
  expect(stages(f)).toEqual([]);
});

test("a failed model preparation preserves the active model and permits retry", async () => {
  const f = fixture(); installedRuntime(f);
  file(join(f.home, "runtime/fpgen/values.dat"), "previous prepared model");
  const result = await finish(launch(f, "setup", { SETUP_TEST_MODEL_FAIL: "1" }));
  expect(result.code).not.toBe(0); expect(result.stderr).toContain("Fingerprint model preparation failed");
  oldRuntime(f);
  expect(readFileSync(join(f.home, "runtime/fpgen/values.dat"), "utf8")).toBe("previous prepared model");
  expect(stages(f)).toEqual([]);
  expect((await finish(launch(f))).code).toBe(0);
});

test("setup rejects a missing, reverted, or duplicate native page patch in either creation attempt", async () => {
  for (const label of ["new page", "new page retry"]) for (const change of ["missing", "reverted", "duplicate"]) {
    const f = fixture(); installedRuntime(f);
    const path = join(f.upstream, "lib/new-page-recovery.js");
    const patched = `const page = setLeasedPage(lease, await withTimeout((await import('../plugins/local-profile/index.js')).createProfilePage(session.context), timeoutMs, '${label}'));`;
    const replacement = change === "missing" ? "" : change === "duplicate" ? `${patched}\n${patched}`
      : `const page = setLeasedPage(lease, await withTimeout(session.context.newPage(), timeoutMs, '${label}'));`;
    file(path, readFileSync(path, "utf8").replace(patched, replacement));
    const result = await finish(launch(f));
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("missing a required Stelz patch");
    expect(result.stderr).toContain("new-page-recovery.js");
    oldRuntime(f);
  }
}, 30000);

test("missing contract modules or required exports cannot replace the runtime", async () => {
  const contractExports = ["TOOL_DEFS", "runTool", "adaptResponse"];
  const pluginExports = ["register", "launchProfileBrowser", "claimProfileContext", "createProfilePage", "protectProfileStartup", "prepareProfileLaunch", "typeIntoLocator"];
  const cases = ["missing-contract", ...contractExports.map(name => `contract:${name}`), ...pluginExports.map(name => `plugin:${name}`)];
  for (const item of cases) {
    const f = fixture();
    installedRuntime(f);
    if (item === "missing-contract") rmSync(join(f.upstream, "mcp/lib/tool-contracts.mjs"));
    if (item.startsWith("contract:")) {
      const missing = item.slice("contract:".length);
      const code = contractExports.filter(name => name !== missing).map(name =>
        name === "TOOL_DEFS" ? "export const TOOL_DEFS = [];" : `export function ${name}() {}`,
      ).join("\n");
      file(join(f.upstream, "mcp/lib/tool-contracts.mjs"), code);
    }
    if (item.startsWith("plugin:")) {
      const missing = item.slice("plugin:".length);
      const code = pluginExports.filter(name => name !== missing).map(name => `export function ${name}() {}`).join("\n");
      file(join(f.project, "dist/plugin.js"), code);
    }
    const result = await finish(launch(f));
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/tool-contracts|Invalid Camofox tool contracts|Missing local-profile export/);
    oldRuntime(f);
  }
}, 30000);

test("interruption after staging leaves the previous generation active and permits retry", async () => {
  const f = fixture();
  const previous = (await prepared(f)).id;
  file(f.browser, "updated browser executable fixture");
  const child = launch(f, "setup", gated(f));
  try {
    await until(() => existsSync(f.gate), "staged validation");
    expect(stages(f)).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(generations(f), stages(f)[0]!, "versions.json"), "utf8")).upstreamVersion).toBe("1.18.1");
    child.kill("SIGKILL");
    await finish(child);
    stopGate(f);
    expect(current(f)).toBe(previous);
    const retried = await prepared(f);
    expect(retried.status).toBe("prepared");
    expect(retried.id).not.toBe(previous);
    expect(current(f)).toBe(retried.id);
    expect(readdirSync(generations(f))).toEqual([retried.id]);
  } finally { child.kill("SIGKILL"); stopGate(f); }
}, 30000);

test("interruption during old-runtime cleanup leaves the new runtime complete", async () => {
  const f = fixture(); installedRuntime(f);
  const bulk = join(f.home, "runtime/bulk"); mkdirSync(bulk);
  for (let i = 0; i < 8000; i++) writeFileSync(join(bulk, String(i)), "old");
  const child = launch(f, "setup", gated(f));
  try {
    await until(() => existsSync(f.gate), "staged validation");
    releaseGate(f);
    await until(() => !existsSync(join(f.home, "runtime/bulk")), "atomic activation");
    expect(child.exitCode).toBeNull();
    child.kill("SIGKILL"); await finish(child);
    const manifest = JSON.parse(readFileSync(join(f.home, "runtime/versions.json"), "utf8"));
    expect(manifest.upstreamVersion).toBe("1.18.1");
    expect(readFileSync(join(f.home, "runtime/camofox-1.18.1/server.js"), "utf8")).toContain("launchProfileBrowser");
    expect(existsSync(join(f.home, "runtime/camofox-1.18.1/plugins/local-profile/index.js"))).toBe(true);
  } finally { child.kill("SIGKILL"); stopGate(f); }
}, 30000);

test("setup serializes with another setup but does not block a real start operation", async () => {
  const f = fixture(); installedRuntime(f);
  const first = launch(f, "setup", gated(f));
  let second: ReturnType<typeof launch> | undefined;
  try {
    await until(() => existsSync(f.gate), "first setup");
    second = launch(f);
    // Staging does not hold the admission lock, so Start reaches its own checks.
    const start = await finish(launch(f, "start profile-02"));
    expect(start.code).not.toBe(0);
    expect(start.stderr).toContain("Unknown profile: profile-02");
    expect(second.exitCode).toBeNull();
    expect(stages(f)).toHaveLength(1);
    oldRuntime(f);
    releaseGate(f);
    expect((await finish(first)).code).toBe(0);
    const result = await finish(second);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout.trim().split("\n").at(-1)!).runtime.status).toBe("reused");
  } finally { first.kill("SIGKILL"); second?.kill("SIGKILL"); stopGate(f); }
}, 30000);

test("simultaneous first setups initialize and activate safely", async () => {
  const f = fixture();
  const first = launch(f);
  const second = launch(f);
  const results = await Promise.all([finish(first), finish(second)]);
  for (const result of results) {
    if (result.code) throw Error(result.stderr || result.stdout);
    expect(result.code).toBe(0);
  }
  expect(JSON.parse(readFileSync(join(f.home, "runtime/versions.json"), "utf8")).upstreamVersion).toBe("1.18.1");
}, 30000);

test("setup keeps the generations that running profiles use and removes the others", async () => {
  const f = fixture();
  const first = (await prepared(f)).id;
  service(f, "profile-02", { runtime: first });
  file(f.browser, "second browser executable fixture");
  const second = await prepared(f);
  expect(second.status).toBe("prepared");
  expect(second.id).not.toBe(first);
  expect(current(f)).toBe(second.id);
  expect(readdirSync(generations(f)).sort()).toEqual([first, second.id].sort());
  expect(readFileSync(join(generations(f), first, "camofox-1.18.1/server.js"), "utf8")).toContain("launchProfileBrowser");
  // The service has exited, so its generation is no longer referenced.
  service(f, "profile-02", { pid: 99999999, runtime: first });
  file(f.browser, "third browser executable fixture");
  const third = await prepared(f);
  expect(readdirSync(generations(f))).toEqual([third.id]);
  // A start reservation holds its generation before its supervisor runs.
  service(f, "profile-03", { pid: 0, serverState: "not-started", runtime: third.id });
  file(f.browser, "fourth browser executable fixture");
  const fourth = await prepared(f);
  expect(readdirSync(generations(f)).sort()).toEqual([third.id, fourth.id].sort());
  // A malformed record can hide a running service, so setup stops before it changes the current generation.
  file(join(f.home, "profiles", "profile-04", "running.json"), "{ malformed");
  file(f.browser, "fifth browser executable fixture");
  expect((await finish(launch(f))).code).not.toBe(0);
  expect(current(f)).toBe(fourth.id);
}, 30000);

test("an earlier plain runtime cannot be replaced after a profile starts during staging", async () => {
  const f = fixture(); installedRuntime(f);
  const child = launch(f, "setup", gated(f));
  try {
    await until(() => existsSync(f.gate), "staged validation");
    service(f, "profile-02");
    releaseGate(f);
    const result = await finish(child);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Stop running profiles from an earlier Stelz version before you run stelz setup.");
    expect(lstatSync(join(f.home, "runtime")).isDirectory()).toBe(true);
    oldRuntime(f);
  } finally { child.kill("SIGKILL"); stopGate(f); }
}, 30000);

test("a clean stopped record permits setup, but a matching marker cannot hide a live server", async () => {
  for (const live of [false, true]) {
    const f = fixture();
    installedRuntime(f);
    const base = join(f.home, "profiles/profile-02");
    file(join(base, "running.json"), JSON.stringify({ version: 2, pid: 99999999, serverPid: live ? process.pid : undefined, instanceId: "clean" }));
    file(join(base, "stopped.json"), JSON.stringify({ instanceId: "clean" }));
    const result = await finish(launch(f));
    if (live) {
      expect(result.code).not.toBe(0);
      oldRuntime(f);
    } else {
      if (result.code) throw Error(result.stderr || result.stdout);
      expect(result.code).toBe(0);
    }
  }
});

test("symlinks in runtime, lock, profile state, and setup sources cannot be followed", async () => {
  for (const kind of ["runtime", "lock", "hardlock", "profile", "source"] as const) {
    const f = fixture(), outside = join(f.base, "outside");
    file(outside, "untouched");
    if (kind === "runtime") symlinkSync(f.base, join(f.home, "runtime"));
    if (kind === "lock") { mkdirSync(join(f.home, "profiles")); symlinkSync(outside, join(f.home, "profiles/admission.lock")); }
    if (kind === "hardlock") { mkdirSync(join(f.home, "profiles")); linkSync(outside, join(f.home, "profiles/admission.lock")); }
    if (kind === "profile") { mkdirSync(join(f.home, "profiles/profile-01"), { recursive: true }); symlinkSync(outside, join(f.home, "profiles/profile-01/running.json")); }
    if (kind === "source") { installedRuntime(f); symlinkSync(outside, join(f.upstream, "lib/unsafe.js")); }
    const result = await finish(launch(f));
    expect(result.code).not.toBe(0);
    expect(readFileSync(outside, "utf8")).toBe("untouched");
    if (kind === "source") oldRuntime(f);
  }
});

test("unpatched dependencies are rejected without rewriting the installed package or old runtime", async () => {
  const f = fixture(); installedRuntime(f);
  const path = join(f.upstream, "server.js");
  const before = readFileSync(path, "utf8").replace(
    "await (await import('./plugins/local-profile/index.js')).typeIntoLocator(locator, text, typingMode);",
    "await locator.fill(text, { timeout: 10000 });");
  writeFileSync(path, before);
  const result = await finish(launch(f));
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("missing a required Stelz patch");
  expect(readFileSync(path, "utf8")).toBe(before);
  oldRuntime(f);
});
