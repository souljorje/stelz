import { readFileSync } from "node:fs";
import { join } from "node:path";

function check(file: string, before: string, after: string) {
  const text = readFileSync(file, "utf8");
  const newCount = text.split(after).length - 1;
  if (newCount !== 1 || text.replace(after, "").includes(before)) {
    throw Error(`Prepared Camofox dependency is missing a required Stelz patch: ${file}. Install the published archive, or run bun install in the source workspace.`);
  }
}

export function assertLocationPatches(upstream: string) {
  check(join(upstream, "server.js"), "return await launchOptions({ ...baseOptions, geoip: false });",
    "const prepared = await (await import('./plugins/local-profile/index.js')).prepareProfileLaunch(baseOptions,");
  check(join(upstream, "lib/browser-identity.js"), "if (hasProxy) return { permissions: ['geolocation'] };",
    "if (hasProxy) return {}; // Stelz never grants location access to arbitrary sites.");
}

export function assertBundledPatches(upstream: string) {
  assertLocationPatches(upstream);
  check(join(upstream, "server.js"), "from 'camoufox-js'", "import { Camoufox, launchOptions, VirtualDisplay } from 'camoufox';");
  check(join(upstream, "server.js"), "const externalCamoufox = getExternalCamoufoxLaunch();",
    "const externalCamoufox = null; // stelz: the plugin passes the executable to the official launcher.");
  check(join(upstream, "server.js"), "get xvfb_args() {", "constructor() { super(false, DEFAULT_VIRTUAL_DISPLAY_RESOLUTION); }");
  check(join(upstream, "server.js"),
    "    return await withTimeout(operation(), timeoutMs, 'action');",
    "    // Stelz owns the deadline for typing. Keep its tab lock until input settles.\n    return await (timeoutMs === null ? operation() : withTimeout(operation(), timeoutMs, 'action'));");
  check(join(upstream, "server.js"),
    "      if (shouldSubmit) await tabState.page.keyboard.press('Enter');\n    });",
    "      if (shouldSubmit) await tabState.page.keyboard.press('Enter');\n    }, typingMode === undefined ? HANDLER_TIMEOUT_MS : null);");
  check(join(upstream, "server.js"),
    "    if (err.message?.includes('timed out') || err.message?.includes('not an <input>')) {",
    "    if (req.body.typingMode !== undefined && /timed out|timeout/i.test(err.message || '')) {\n      return res.status(409).json({\n        error: 'Typing timeout. Input may be incomplete. Stop and start the profile before another browser action.',\n        code: 'typing_timeout',\n        retryable: false,\n      });\n    }\n    if (err.message?.includes('timed out') || err.message?.includes('not an <input>')) {");
  check(join(upstream, "server.js"),
    "async function fillLocator(locator, text) {",
    "async function fillLocator(locator, text, typingMode) {");
  check(join(upstream, "server.js"),
    "await locator.fill(text, { timeout: 10000 });",
    "await (await import('./plugins/local-profile/index.js')).typeIntoLocator(locator, text, typingMode);");
  check(join(upstream, "server.js"),
    "const { userId, ref, selector, text, mode = 'fill', delay = 30, submit = false, pressEnter = false } = req.body;",
    "const { userId, ref, selector, text, typingMode, mode = 'fill', delay = 30, submit = false, pressEnter = false } = req.body;");
  check(join(upstream, "server.js"),
    "      if (mode === 'fill') {\n        if (locator) {\n          await fillLocator(locator, text);\n        } else {\n          await fillLocator(tabState.page.locator(selector), text);\n        }",
    "      if (mode === 'fill') {\n        if (locator) {\n          await fillLocator(locator, text, typingMode);\n        } else {\n          await fillLocator(tabState.page.locator(selector), text, typingMode);\n        }");
  check(join(upstream, "server.js"), "os: hostOS,\n        humanize: true,",
    "os: hostOS,\n        window: [1200, 800],\n        screen: { minWidth: 1280, minHeight: 900, maxWidth: 1920, maxHeight: 1200 },\n        humanize: true,");
  check(join(upstream, "server.js"), "proxy: launchProxy,\n        geoip: !!launchProxy,",
    "proxy: launchProxy,\n        block_webrtc: !!launchProxy,\n        geoip: !!launchProxy,");
  // contextIdentityOptions and directIdentity are upstream Camofox identifiers.
  check(join(upstream, "server.js"), "candidateBrowser = await firefox.launch(options);",
    "candidateBrowser = await (await import('./plugins/local-profile/index.js')).launchProfileBrowser(firefox, options, { viewport: null, ...contextIdentityOptions({ hasProxy: !!proxyPool, directIdentity: CONFIG.directIdentity }) });");
  check(join(upstream, "server.js"), "const context = await b.newContext(contextOptions);",
    "const context = await (await import('./plugins/local-profile/index.js')).claimProfileContext(b, contextOptions);");
  check(join(upstream, "server.js"), "      sessions.set(key, created);\n      await pluginEvents.emitAsync('session:created', { userId: key, context });",
    "      created.releaseProfileStartup = (await import('./plugins/local-profile/index.js')).protectProfileStartup(created, { acquirePageLease, setLeasedPage, releasePageLease });\n      sessions.set(key, created);\n      await pluginEvents.emitAsync('session:created', { userId: key, context });");
  check(join(upstream, "server.js"), "app.post('/tabs', async (req, res) => {",
    "let stelzStartupAdmitted = false;\napp.post('/tabs', async (req, res) => {");
  check(join(upstream, "server.js"), "  let abandoned = false;\n  const discardCreatedTab = async () => {\n    if (!createdTabId) return;",
    "  let abandoned = false;\n  let profileStartup = false;\n  const discardCreatedTab = async () => {\n    if (!createdTabId || profileStartup) return;");
  check(join(upstream, "server.js"), "    // Session overflow redirect (Fly.io only)", [
    "    if (req.body.stelzStartup !== undefined) {",
    "      if (req.body.stelzStartup !== true || stelzStartupAdmitted || sessions.has(normalizeUserId(userId)) ||",
    "          userId !== process.env.STELZ_PROFILE_ID || sessionKey !== 'default' ||",
    "          Object.keys(req.body).some(key => !['userId', 'sessionKey', 'stelzStartup'].includes(key))) {",
    "        throw Object.assign(new Error('Invalid or repeated profile startup request'), { statusCode: 409 });",
    "      }",
    "      stelzStartupAdmitted = profileStartup = true;",
    "      // Startup verification has its own service deadline. Normal /tabs calls keep theirs.",
    "      // The supervisor waits for browser prewarm before this one-time initialization.",
    "      await getSession(userId);",
    "    }", "",
    "    // Session overflow redirect (Fly.io only)",
  ].join("\n"));
  check(join(upstream, "server.js"), "      createdTabId = tabId;\n      releasePageLease(session, lease);",
    "      createdTabId = tabId;\n      session.releaseProfileStartup?.();\n      delete session.releaseProfileStartup;\n      releasePageLease(session, lease);");
  for (const label of ["new page", "new page retry"]) {
    check(join(upstream, "lib/new-page-recovery.js"),
      `const page = setLeasedPage(lease, await withTimeout(session.context.newPage(), timeoutMs, '${label}'));`,
      `const page = setLeasedPage(lease, await withTimeout((await import('../plugins/local-profile/index.js')).createProfilePage(session.context), timeoutMs, '${label}'));`);
  }
  check(join(upstream, "plugins/persistence/index.js"), "export async function register(app, ctx, pluginConfig = {}) {",
    "export async function register(app, ctx, pluginConfig = {}) {\n  return; // Native Firefox profile owns storage.");
}
