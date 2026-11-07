import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { setImmediate } from "node:timers/promises";
import { launchProfileBrowser, claimProfileContext, createProfilePage, protectProfileStartup } from "../../src/browser/native-profile.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const leaseApi = await import(new URL("../../node_modules/@askjo/camofox-browser/lib/page-lease.js", import.meta.url).href);

// Exercise the pending patch without changing the shared dependency installation.
function patchedServer() {
  let source = readFileSync(join(root, "node_modules/@askjo/camofox-browser/server.js"), "utf8");
  const patch = readFileSync(join(root, "patches/@askjo%2Fcamofox-browser@1.18.1.patch"), "utf8").split("diff --git a/server.js b/server.js\n")[1]!.split("\ndiff --git ")[0]!;
  for (const hunk of patch.split(/^@@[^\n]*\n/m).slice(1)) {
    const lines = hunk.split("\n");
    const before = lines.filter(line => /^[ -]/.test(line)).map(line => line.slice(1)).join("\n") + "\n";
    const after = lines.filter(line => /^[ +]/.test(line)).map(line => line.slice(1)).join("\n") + "\n";
    if (source.includes(after)) continue;
    assert.equal(source.split(before).length, 2, "The upstream patch preimage must occur once.");
    source = source.replace(before, after);
  }
  return source;
}

function fixture(initialUrls = ["about:blank"]) {
  const directory = mkdtempSync(join(tmpdir(), "stelz-native-"));
  let persistent = 0, ephemeral = 0, newContexts = 0, newPages = 0, launchedPath = "", launchedOptions: Record<string, unknown> = {};
  function page(url: string) {
    let closed = false;
    const value = Object.assign(new EventEmitter(), {
      url: () => url, isClosed: () => closed,
      navigate(next: string) { url = next; value.emit("framenavigated"); },
      async close() { closed = true; value.emit("close"); },
    });
    return value;
  }
  const pages = initialUrls.map(page);
  const browser = { async newContext() { newContexts++; return context; } };
  const context = Object.assign(new EventEmitter(), {
    browser: () => browser,
    async close() { context.emit("close"); },
    pages: () => pages.filter(value => !value.isClosed()),
    async newPage() { newPages++; const value = page("about:blank"); pages.push(value); return value; },
  });
  const launcher = {
    async launch() { ephemeral++; return browser; },
    async launchPersistentContext(path: string, options: Record<string, unknown>) {
      persistent++; launchedPath = path; launchedOptions = options; return context;
    },
  };
  return { directory, context, browser, launcher, pages, pageCreations: () => newPages,
    counts: () => ({ persistent, ephemeral, newContexts }),
    async start() {
      const launched = await launchProfileBrowser(launcher, {}, {}, { directory });
      return claimProfileContext(launched, {});
    },
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

test("the first canonical tab reuses the launch blank once, including concurrent calls", async () => {
  const f = fixture();
  try {
    const context = await f.start(), initial = f.pages[0]!;
    initial.emit("request", { isNavigationRequest: () => false });
    const [first, second] = await Promise.all([createProfilePage(context), createProfilePage(context)]);
    assert.equal(first, initial);
    assert.notEqual(second, initial);
    assert.equal(f.pageCreations(), 1);
    assert.equal(context.pages().length, 2);
    assert.equal(initial.url(), "about:blank");
    assert.equal(initial.listenerCount("framenavigated"), 0);
    assert.equal(initial.listenerCount("close"), 0);
    assert.equal(initial.listenerCount("request"), 0);
    const third = await createProfilePage(context);
    assert.notEqual(third, initial);
    assert.notEqual(third, second);
    assert.equal(f.pageCreations(), 2);
  } finally { f.close(); }
});

for (const urls of [[], ["https://example.test/"], ["about:blank", "https://example.test/"], ["about:blank", "about:blank"]]) {
  test(`existing launch pages are preserved: ${JSON.stringify(urls)}`, async () => {
    const f = fixture(urls);
    try {
      const context = await f.start(), existing = [...f.pages];
      const created = await createProfilePage(context);
      assert.ok(existing.every(page => page !== created));
      assert.deepEqual(existing.map(page => page.url()), urls);
      assert.ok(existing.every(page => !page.isClosed()));
      assert.equal(f.pageCreations(), 1);
    } finally { f.close(); }
  });
}

for (const change of ["navigation started", "navigated", "returned to blank", "closed", "removed"] as const) {
  test(`changed launch pages and user tabs are not reclaimed: ${change}`, async () => {
    const f = fixture();
    try {
      const browser = await launchProfileBrowser(f.launcher, {}, {}, { directory: f.directory });
      const initial = f.pages[0]!, userBlank = await f.context.newPage();
      if (change === "navigation started") initial.emit("request", { isNavigationRequest: () => true });
      if (change === "navigated" || change === "returned to blank") initial.navigate("https://example.test/");
      if (change === "returned to blank") initial.navigate("about:blank");
      if (change === "closed") await initial.close();
      if (change === "removed") f.pages.shift();
      const context = await claimProfileContext(browser, {});
      const created = await createProfilePage(context);
      assert.notEqual(created, initial);
      assert.notEqual(created, userBlank);
      assert.equal(f.pageCreations(), 2);
      assert.equal(initial.listenerCount("framenavigated"), 0);
      assert.equal(initial.listenerCount("close"), 0);
      assert.equal(initial.listenerCount("request"), 0);
      assert.equal(userBlank.isClosed(), false);
      assert.equal(userBlank.url(), "about:blank");
    } finally { f.close(); }
  });
}

test("a later user blank is not adopted when no blank existed at launch", async () => {
  const f = fixture([]);
  try {
    const context = await f.start();
    const userBlank = await context.newPage();
    assert.notEqual(await createProfilePage(context), userBlank);
    assert.equal(f.pageCreations(), 2);
  } finally { f.close(); }
});

test("native page creation rejects unclaimed, foreign, and closed contexts without losing the launch blank", async () => {
  const f = fixture(), foreign = fixture();
  try {
    const browser = await launchProfileBrowser(f.launcher, {}, {}, { directory: f.directory });
    await assert.rejects(createProfilePage(f.context), /not claimed/);
    await assert.rejects(createProfilePage(foreign.context), /Original persistent context is unavailable/);
    const substitute = Object.assign(new EventEmitter(), {
      browser: () => browser, close: async () => {}, pages: () => [], newPage: f.context.newPage,
    });
    await assert.rejects(createProfilePage(substitute), /Original persistent context is unavailable/);
    const context = await claimProfileContext(browser, {});
    assert.equal(await createProfilePage(context), f.pages[0]);
    await f.context.close();
    await assert.rejects(createProfilePage(context), /closed/);
    assert.equal(f.pageCreations(), 0);
    assert.equal(foreign.pageCreations(), 0);
    assert.equal(f.counts().newContexts, 0);
  } finally { f.close(); foreign.close(); }
});

test("closing the native context before page creation discards the launch blank", async () => {
  const f = fixture();
  try {
    const context = await f.start(), initial = f.pages[0]!;
    await context.close();
    await assert.rejects(createProfilePage(context), /closed/);
    assert.equal(initial.listenerCount("framenavigated"), 0);
    assert.equal(initial.listenerCount("close"), 0);
    assert.equal(initial.listenerCount("request"), 0);
    assert.equal(f.pageCreations(), 0);
  } finally { f.close(); }
});

async function startupHarness() {
  const f = fixture(), context = await f.start();
  type TestPage = typeof f.pages[number];
  const session = { context, tabGroups: new Map<string, Map<string, { page: TestPage }>>(),
    pageLeases: new Set<unknown>(), releaseProfileStartup: undefined as (() => void) | undefined };
  const sessions = new Map<string, typeof session>();
  let initialized!: () => void, navigate!: () => void;
  const verification = new Promise<void>(resolve => { initialized = resolve; });
  const navigation = new Promise<void>(resolve => { navigate = resolve; });
  const deadlines: { ms: number; fire(): void }[] = [], reapers: (() => void)[] = [];
  let handler!: (req: any, res: any) => Promise<void>, sequence = 0, sessionClosures = 0, failRegistration = false;
  const globals = {
    ...leaseApi, process: { env: { STELZ_PROFILE_ID: "test" } }, sessions,
    app: { post(_path: string, callback: typeof handler) { handler = callback; } },
    normalizeUserId: String, FLY_MACHINE_ID: "", MAX_TABS_PER_SESSION: 100, MAX_TABS_GLOBAL: 100,
    TAB_INACTIVITY_MS: 1e12, tabLocks: new Map(), tabsReapedTotal: { inc() {} }, sessionsExpiredTotal: { inc() {} },
    log() {}, refreshTabLockQueueDepth() {}, refreshActiveTabsGauge() {}, scheduleBrowserIdleShutdown() {},
    safePageClose: (page: TestPage) => page.close(),
    async closeSession() { sessionClosures++; await context.close(); },
    setInterval(callback: () => void) { reapers.push(callback); },
    async getSession() {
      if (!sessions.has("test")) {
        session.releaseProfileStartup = protectProfileStartup(session, leaseApi);
        sessions.set("test", session);
        await verification;
      }
      return session;
    },
    getTotalTabCount: () => context.pages().length,
    async createPageWithRecoveryForUser() {
      const lease = leaseApi.acquirePageLease(session);
      const page = leaseApi.setLeasedPage(lease, await createProfilePage(context));
      return { session, page, lease };
    },
    getTabGroup(_session: unknown, key: string) {
      if (!session.tabGroups.has(key)) session.tabGroups.set(key, new Map());
      return session.tabGroups.get(key)!;
    },
    fly: { makeTabId: () => String(++sequence) }, createTabState: (page: TestPage) => ({ page, visitedUrls: new Set() }),
    attachDownloadListener() {}, attachPopupHandler() { if (failRegistration) throw Error("registration interrupted"); },
    pluginEvents: { emit() {} },
    withTimeout(work: Promise<unknown>, ms: number, label: string) {
      return Promise.race([work, new Promise<never>((_resolve, reject) => {
        deadlines.push({ ms, fire: () => reject(Error(label + " timed out")) });
      })]);
    },
    tabCreateRequestTimeoutMs: () => 30_000,
    async destroyTimedOutTab(_session: unknown, id: string) {
      for (const group of session.tabGroups.values()) {
        const tab = group.get(id);
        if (tab) { await tab.page.close(); group.delete(id); }
      }
    },
    handleRouteError(error: Error & { statusCode?: number }, _req: unknown, res: any) {
      res.status(error.statusCode ?? 504).json({ error: error.message });
    },
    validateUrl() {}, navigatePage: () => navigation,
    withPageLoadDuration: (_label: string, work: () => Promise<void>) => work(),
    recordNavSuccess() {}, recordNavFailure: () => false, isProxyError: () => false,
  };
  const source = patchedServer();
  const route = source.slice(source.indexOf("let stelzStartupAdmitted = false;"), source.indexOf("// Navigate\n/**"));
  assert.ok(route.includes("tabCreateRequestTimeoutMs()"));
  runInNewContext(route, globals);
  runInNewContext(source.slice(source.indexOf("// Per-tab inactivity reaper"), source.indexOf("// Idle memory pressure restart")), globals);
  return { ...f, session, deadlines, initialized, reapers, sessionClosures: () => sessionClosures,
    failRegistration() { failRegistration = true; },
    async request(body: Record<string, unknown> = { userId: "test", sessionKey: "default", stelzStartup: true }) {
      let code = 200, payload: any;
      const res = { status(value: number) { code = value; return res; }, json(value: unknown) { payload = value; } };
      await handler({ body, headers: {}, reqId: "test" }, res);
      return { code, payload };
    },
    async dispose() { initialized(); navigate(); await context.close(); f.close(); },
  };
}

test("slow startup survives both upstream reapers and starts its tab deadline after verification", async () => {
  const h = await startupHarness();
  try {
    let finished = false;
    const pending = h.request().then(result => { finished = true; return result; });
    await setImmediate();
    // Fire the actual 60-second reapers while the startup hook is still pending.
    for (const reap of h.reapers) reap();
    await setImmediate();
    assert.equal(h.sessionClosures(), 0);
    assert.equal(h.pages[0]!.isClosed(), false);
    assert.equal(h.deadlines.length, 0, "The ordinary 30-second route deadline must not include startup verification.");
    assert.equal(finished, false);
    assert.ok(leaseApi.hasActivePageLeases(h.session));
    assert.ok(leaseApi.isPageLeased(h.session, h.pages[0]));
    h.initialized();
    const response = await pending;
    assert.equal(response.code, 200);
    assert.equal(response.payload.url, "about:blank");
    assert.equal(h.deadlines[0]!.ms, 30_000);
    assert.equal(h.session.pageLeases.size, 0);
    assert.equal(h.session.releaseProfileStartup, undefined);
    assert.equal(h.pageCreations(), 0);
    for (const reap of h.reapers) reap();
    assert.equal(h.sessionClosures(), 0);
    assert.equal(h.pages[0]!.isClosed(), false);
    assert.equal((await h.request()).code, 409);
    assert.equal(h.pageCreations(), 0);
  } finally { await h.dispose(); }
});

test("startup rejects foreign profiles and navigation payloads before allocating a session", async () => {
  const h = await startupHarness();
  try {
    for (const extra of [{ userId: "other" }, { sessionKey: "other" }, { url: "https://example.test/" }, { trace: true }, { stelzStartup: false }]) {
      assert.equal((await h.request({ userId: "test", sessionKey: "default", stelzStartup: true, ...extra })).code, 409);
    }
    assert.equal(h.session.pageLeases.size, 0);
    assert.equal(h.deadlines.length, 0);
    assert.equal(h.pageCreations(), 0);
    h.initialized();
    assert.equal((await h.request()).code, 200);
  } finally { await h.dispose(); }
});

test("startup cleanup preserves the borrowed page while normal tab deadlines still discard failed tabs", async () => {
  const failed = await startupHarness();
  try {
    failed.failRegistration(); failed.initialized();
    assert.equal((await failed.request()).code, 504);
    assert.equal(failed.pages[0]!.isClosed(), false);
    assert.equal(failed.session.tabGroups.get("default")!.size, 1);
  } finally { await failed.dispose(); }

  const h = await startupHarness();
  try {
    h.initialized(); assert.equal((await h.request()).code, 200);
    const normal = h.request({ userId: "test", sessionKey: "default", url: "https://example.test/" });
    await setImmediate();
    assert.equal(h.deadlines.length, 2);
    assert.equal(h.deadlines[1]!.ms, 30_000);
    h.deadlines[1]!.fire();
    assert.equal((await normal).code, 504);
    assert.equal(h.pages[0]!.isClosed(), false);
    assert.equal(h.pages[1]!.isClosed(), true);
    assert.equal(h.session.tabGroups.get("default")!.size, 1);
  } finally { await h.dispose(); }
});

test("startup leases reject foreign contexts, protect all launch pages, and release only their own leases on close", async () => {
  const f = fixture(["about:blank", "https://example.test/"]), foreign = fixture();
  try {
    const context = await f.start(), session = { context, pageLeases: new Set<unknown>() };
    assert.throws(() => protectProfileStartup({ context: foreign.context }, leaseApi), /Original persistent context/);
    const unrelated = leaseApi.acquirePageLease(session);
    const release = protectProfileStartup(session, leaseApi);
    assert.equal(session.pageLeases.size, 3);
    assert.ok(f.pages.every(page => leaseApi.isPageLeased(session, page)));
    assert.throws(() => protectProfileStartup(session, leaseApi), /already protected/);
    await context.close(); release();
    assert.deepEqual([...session.pageLeases], [unrelated]);
    assert.ok(f.pages.every(page => !page.isClosed()));
    assert.throws(() => protectProfileStartup(session, leaseApi), /closed/);
  } finally { f.close(); foreign.close(); }
});
