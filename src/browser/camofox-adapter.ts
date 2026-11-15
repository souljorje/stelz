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
}

// A fallback click runs only when the failed attempt sent no input. Otherwise one request could click twice.
// Input gets the remaining budget, because the browser confirms each mouse event before a click completes.
function assertClickPatches(upstream: string) {
  const server = join(upstream, "server.js"), guard = "if (clickReachedPage(forceErr)) throw uncertainClickError(forceErr);\n";
  const force = "            try {\n              await click({ timeout: inputTimeout(), force: true });\n            } catch (forceErr) {\n              " + guard;
  check(server, "        } catch (domErr) {\n          log('warn', 'DOM click fallback failed",
    "        } catch (domErr) {\n          // stelz: a DOM click can reach the page before it fails. Then the mouse sequence would repeat it.\n          if (!domClickRejected(domErr)) throw uncertainClickError(domErr);\n");
  check(server, "          await click({ timeout: 3000 });\n        } catch (err) {",
    "          await click({ timeout: 3000, trial: true });\n        } catch (err) {\n          // A trial sends no input, although Playwright still logs \"performing click action\" for it.\n");
  check(server, "await click({ timeout: 3000 });\n",
    "        // stelz: a failure after input started is uncertain. Never repeat it.\n        try {\n          await click({ timeout: inputTimeout() });\n" +
    "        } catch (err) {\n          if (clickReachedPage(err)) throw uncertainClickError(err);\n          throw err;\n        }\n");
  check(server, "          } catch (forceErr) {\n            log('warn', 'google force click failed",
    "          } catch (forceErr) {\n            " + guard + "            log('warn', 'google force click failed");
  check(server, "log('warn', 'click intercepted, retrying with force');\n            try {\n              await click({ timeout: 3000, force: true });",
    "log('warn', 'click intercepted, retrying with force');\n" + force);
  check(server, "remainingBudget())), force: true });", "log('warn', 'click timeout, retrying with force');\n" + force);
}

// The orphan page reaper closes only pages that Camofox owned. Pages that a person or a website opens stay open.
function assertReaperPatches(upstream: string) {
  const server = join(upstream, "server.js");
  check(server, "async function safePageClose(page) {\n  if (!page || page.isClosed()) return;\n  try {",
    "async function safePageClose(page) {\n  if (!page || page.isClosed()) return;\n  ownPage(page);\n");
  check(server, "function createTabState(page) {\n  const healthTracker", "function createTabState(page) {\n  ownPage(page);\n");
  check(server, "if (!registered.has(page) && !isPageLeased(session, page)) {",
    "      // stelz: a page that a person or a website opened is not an orphan.\n      if (isOrphanPage(page, registered, isPageLeased(session, page))) {");
}

// Camofox must not close a crashed tab or resize a popup by itself. The supervisor environment disables its memory restart.
// Only an explicit lifecycle command or a person changes the native browser and its windows.
function assertNativeWindowPatches(upstream: string) {
  const server = join(upstream, "server.js");
  check(server, "const reapAfterMs = tabState.crashed ? Math.min(60_000, TAB_INACTIVITY_MS) : TAB_INACTIVITY_MS;",
    "// stelz: TAB_INACTIVITY_MS alone governs reaping, also for a crashed tab.\n          const reapAfterMs = TAB_INACTIVITY_MS;");
  check(server, "    maybeResizeSmallPopup(popupPage);\n",
    "    // stelz: a popup keeps its native window size. Stelz never emulates a viewport.\n");
}

export function assertBundledPatches(upstream: string) {
  // The click guard and the page ownership checks come from the plugin.
  check(join(upstream, "server.js"), "} from './lib/browser-errors.js';\n\nconst CONFIG",
    "} from './lib/browser-errors.js';\nimport { clickReachedPage, domClickRejected, uncertainClickError, isOrphanPage, ownPage } from './plugins/local-profile/index.js';\n");
  assertLocationPatches(upstream);
  assertClickPatches(upstream);
  assertReaperPatches(upstream);
  assertNativeWindowPatches(upstream);
  // The health probe opens a visible window and can only end in a refused replacement browser.
  check(join(upstream, "server.js"), "setInterval(async () => {\n  if (!browser || healthState.isRecovering) return;",
    "setInterval(async () => {\n  // stelz: the probe context opens a visible window, and Stelz refuses a replacement browser.\n");
  check(join(upstream, "server.js"), "from 'camoufox-js'", "import { Camoufox, launchOptions, VirtualDisplay } from 'camoufox';");
  check(join(upstream, "server.js"), "get xvfb_args() {", "constructor() { super(false, DEFAULT_VIRTUAL_DISPLAY_RESOLUTION); }");
  check(join(upstream, "server.js"),
    "      const delta = (direction === 'up' || direction === 'left') ? -amount : amount;\n      await tabState.page.mouse.wheel(isVertical ? 0 : delta, isVertical ? delta : 0);",
    "      await tabState.page.bringToFront();\n" +
    "      // stelz: wheel input targets the pointer, which can still be over a fixed header.\n" +
    "      const viewport = await tabState.page.evaluate(() => ({ width: innerWidth, height: innerHeight }));\n" +
    "      await tabState.page.mouse.move(viewport.width / 2, viewport.height / 2);\n" +
    "      await tabState.page.mouse.wheel(isVertical ? 0 : delta, isVertical ? delta : 0);");
  // Upstream starts the operation once, before the deadline. Never call it a second time.
  check(join(upstream, "server.js"),
    "    return await withTimeout(operationPromise, timeoutMs, 'action');",
    "    // Stelz owns the deadline for typing. Keep its tab lock until input settles.\n    return await (timeoutMs === null ? operationPromise : withTimeout(operationPromise, timeoutMs, 'action'));");
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
}
