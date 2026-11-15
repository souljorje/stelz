// Compiled to Node ESM; loaded by Camofox's supported plugin hooks.
import { writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createControllerLease } from "../mcp/controller.ts";
import { type ControlIdentity, type OwnedControlRequest, type AcquireControlRequest } from "../mcp/control-protocol.ts";
import { applyFingerprint, validateFinalLaunch, type LaunchOptions } from "./fingerprint.ts";
import { initializedFingerprint, type FingerprintOwner } from "./fingerprint-transaction.ts";
import { verifyProfileFingerprint, type ProfileBrowserContext, type ProfilePage } from "./native-profile.ts";
import { createIpVerification, parseIpCheckInterval } from "./ip-verification.ts";
import { actionDeadline, browserTools as catalogTools, toolArguments, type Contracts, type ToolResult } from "./catalog.ts";
import { loadAriaHelpers, parseAria } from "./aria.ts";
import { createSnapshotTracker, type SnapshotRequest, type View } from "./snapshot-tracker.ts";
import { SelectorError } from "./snapshot-view.ts";
import { findCondition, resolveTarget, type Condition, type Target } from "./targets.ts";
import { readTab, TAB_STATE_CHANGED } from "./tab-state.ts";
import { assertScriptsAllowed } from "../profiles/allow-scripts.ts";
import { addProfileExtension, createProfileWindows } from "./profile-windows.ts";
import { activateProfileBrowser } from "./window-activation.ts";
import { profileTypingMode } from "../profiles/typing-mode.ts";
import { parseTypingMode } from "./typing.ts";
import { OBSERVE_LIMIT_MS, SERVICE_DEADLINE_MS, WAIT_POLL_MS, serviceDeadline, waitDuration } from "./deadlines.ts";
import { launchLocation, checkLaunchLocation, verifyLaunchLocation, saveLaunchLocation, type LocationPage } from "./location-launch.ts";
import { LocationError, locationFailure, evidenceMessage } from "./location.ts";
export { prepareProfileLaunch } from "./location-launch.ts";
export { typeIntoLocator } from "./typing.ts";
export { initializedFingerprint } from "./fingerprint-transaction.ts";
export { clickReachedPage, domClickRejected, uncertainClickError } from "./click-guard.ts";
export { ownPage, isOrphanPage } from "./page-ownership.ts";

type Page = ProfilePage;
type Context = ProfileBrowserContext;
type Events = {
  "browser:launching": { options: LaunchOptions };
  "browser:launched": { browser: { on(event: "disconnected", listener: () => void): unknown } };
  "browser:restart": unknown;
  "browser:closed": unknown;
  "session:creating": { userId: string; contextOptions: { proxy?: Record<string, unknown> } };
  "session:created": { userId: string; context: Context };
  "session:destroying": { userId: string };
  "server:shutdown": unknown;
};
type Response = { status(n: number): Response; json(value: unknown): void };
type Handler = (req: { body?: Record<string, unknown>; headers?: Record<string, string | string[] | undefined> }, res: Response, next?: () => void) => unknown;
type App = { get(path: string, ...handlers: Handler[]): void; post(path: string, ...handlers: Handler[]): void };
type PluginContext = {
  auth(): Handler;
  /** The sessions of Camofox. Only tab-state.ts reads it. */
  sessions: unknown;
  events: { on<K extends keyof Events>(name: K, fn: (payload: Events[K]) => unknown): void };
};
type Phase = "starting" | "ready" | "paused" | "verification_failed" | "blocked" | "stopping" | "stopped";
type ProfileState = {
  profileId: string;
  instanceId: string;
  phase: Phase;
  exitIp: string | null;
  expectedIp?: string | null;
  checkedAt?: string;
  verificationIntervalMs: number;
  verificationStatus: "unverified" | "verified" | "verification_failed";
  verificationRequired: boolean;
  fixedIpVerified?: boolean;
  fingerprintSha256?: string;
  engineSha256?: string;
  pinSha256?: string;
  startupPrepared?: boolean;
  error?: string | null;
  checkFailure?: string | null;
};


function isBrowserNetworkFailure(value: unknown) {
  let diagnostic: unknown;
  if (value instanceof Error) {
    diagnostic = value.message;
    const response = /^\d{3}:\s*([\s\S]*)$/.exec(value.message);
    if (response) {
      try { diagnostic = (JSON.parse(response[1]!) as { error?: unknown } | null)?.error; }
      catch { return false; }
    }
  } else if (value && typeof value === "object") {
    diagnostic = (value as { error?: unknown }).error;
  }
  if (typeof diagnostic !== "string") return false;
  // Inspect the diagnostic prefix, never page contents, URLs, or a Playwright call log.
  const firstLine = diagnostic.split(/\r?\n/, 1)[0]!.replace(/^(?:\w+\.)+\w+:\s*/, "");
  return /^(?:NS_ERROR_(?:PROXY_[A-Z_]+|UNKNOWN_PROXY_HOST|CONNECTION_REFUSED|NET_(?:RESET|INTERRUPT|TIMEOUT)|UNKNOWN_HOST|OFFLINE)|net::ERR_(?:PROXY_[A-Z_]+|TUNNEL_CONNECTION_FAILED|SOCKS_[A-Z_]+|CONNECTION_(?:RESET|REFUSED|CLOSED|ABORTED|TIMED_OUT)|NETWORK_CHANGED|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED)|proxy connection\b)/i.test(firstLine);
}

// Upstream answers an evaluate that passed its deadline with 504 and a JSON body. Match the code, not the message.
const EVALUATE_TIMEOUT = "The script reached its time limit. It may still run in the page. Read a snapshot to see the page state. Do not run the script again.";
function isEvaluateTimeout(value: unknown) {
  const body = value instanceof Error ? /^504:\s*([\s\S]*)$/.exec(value.message)?.[1] : undefined;
  try { return !!body && (JSON.parse(body) as { code?: unknown } | null)?.code === "evaluate_timeout"; }
  catch { return false; }
}

// The note of a call whose action succeeded and whose read of the page failed. A caller must not repeat the action.
const OBSERVATION_FAILED = "The action completed. Read tab_snapshot to see the page.";
// An operation that passed its time limit can still run in the browser, so the lifetime is blocked.
const TIME_LIMIT = "A service operation exceeded its time limit. Stop the profile before another browser action.";

/** A snapshot reply. `more` adds the structure and the screenshot. */
const snapshotResult = (view: View, more: Record<string, unknown> = {}): ToolResult => ({ kind: "snapshot", payload: { url: view.url, refsCount: view.refsCount,
  truncated: view.truncated, ...(view.nextOffset === undefined ? {} : { nextOffset: view.nextOffset }), viewId: view.viewId,
  ...(view.baseline ? { baseline: true } : {}), snapshot: view.text, ...more } });
// A refused action, such as a click that failed its role check, did not happen. It has nothing to observe.
const refused = (payload: unknown) => !!payload && typeof payload === "object" && (payload as { ok?: unknown }).ok === false;

// An embedded snapshot can be larger than a page window. Stelz drops it and sends the caller to tab_snapshot, which can shape it.
const READ_SNAPSHOT = "Read tab_snapshot for the current page.";
function withoutEmbeddedSnapshot(body: unknown, tool: string) {
  if (!body || typeof body !== "object" || !("snapshot" in body)) return body;
  const { snapshot: _dropped, ...rest } = body as Record<string, unknown>;
  // The upstream mismatch reply says "use the returned snapshot".
  return tool === "tab_click" && rest.code === "semantic_target_mismatch"
    ? { ...rest, recovery: "read_tab_snapshot", error: "The referenced element no longer matches the requested role or accessible name. No click was performed. Read tab_snapshot, then use a current ref.", hint: READ_SNAPSHOT }
    : { ...rest, hint: READ_SNAPSHOT };
}
// A failed extract replies with 409 or 422 and the same embedded snapshot.
function withoutEmbeddedSnapshotError(error: unknown) {
  const reply = error instanceof Error ? /^(409|422):\s*([\s\S]*)$/.exec(error.message) : null;
  if (!reply) return error;
  try { return Error(`${reply[1]}: ${JSON.stringify(withoutEmbeddedSnapshot(JSON.parse(reply[2]!), "tab_extract"))}`); }
  catch { return error; }
}

export async function register(app: App, ctx: PluginContext, options: {
  actionTimeoutMs?: number; observeTimeoutMs?: number; shutdown?: () => void; ipCheckIntervalMs?: number; now?: () => number;
  verifyFingerprint?: (context: Parameters<typeof verifyProfileFingerprint>[0], prepared: ReturnType<typeof applyFingerprint>) =>
    Promise<Awaited<ReturnType<typeof verifyProfileFingerprint>> | void>;
} = {}) {
  const id = process.env.STELZ_PROFILE_ID!;
  const stateDir = process.env.STELZ_PROFILE_DIR!;
  if (!id || !stateDir) throw Error("local-profile requires STELZ_PROFILE_ID and STELZ_PROFILE_DIR");
  const file = join(stateDir, "status.json");
  const proxied = !!process.env.PROXY_HOST;
  const location = launchLocation();
  const interval = parseIpCheckInterval(options.ipCheckIntervalMs === undefined
    ? process.env.STELZ_IP_CHECK_INTERVAL_MS : String(options.ipCheckIntervalMs));
  const now = options.now ?? (() => performance.now());
  let lastVerifiedAt: number | undefined;
  const expected = process.env.STELZ_EXPECTED_IP || "";
  const requiresCheck = proxied || !!expected;
  let state: ProfileState = { profileId: id, instanceId: randomUUID(), phase: "starting", exitIp: null,
    verificationIntervalMs: interval, verificationStatus: "unverified", verificationRequired: requiresCheck };
  const controller = createControllerLease();
  const upstream = await import(pathToFileURL(join(process.env.STELZ_UPSTREAM!, "mcp/lib/tool-contracts.mjs")).href) as Contracts;
  const browserTools = catalogTools(upstream.TOOL_DEFS);
  const ariaHelpers = await loadAriaHelpers(process.env.STELZ_UPSTREAM!);
  const snapshotTool = browserTools.get("tab_snapshot")!.entry.upstream;
  // What each controller saw of each tab. One browser lifetime owns it.
  const tracker = createSnapshotTracker(ariaHelpers);
  const ipVerification = createIpVerification(state.instanceId, expected);
  let context: Context | undefined;
  let stopping = false;
  let launchAdmitted = false;
  let sessionAdmitted = false;
  let invalidated = false;
  let pauseGeneration = 0;
  let restorePhase: "ready" | "paused" = "ready";
  const owner: FingerprintOwner = { profileId: id, attemptId: process.env.STELZ_START_ID || "",
    browserInstanceId: state.instanceId, configurationHash: process.env.STELZ_CONFIGURATION_HASH || "", serverPid: process.pid };
  if (!owner.attemptId || !owner.configurationHash || !process.env.STELZ_BOOTSTRAP_TOKEN) throw Error("The service startup reservation is missing.");
  let fingerprint: ReturnType<typeof applyFingerprint> | undefined;
  const windows = createProfileWindows({ id, instanceId: state.instanceId, directory: stateDir,
    port: Number(process.env.CAMOFOX_PORT), accessKey: process.env.CAMOFOX_ACCESS_KEY!, phase: () => state.phase,
    activate: () => activateProfileBrowser(process.env.STELZ_CAMOUFOX_EXECUTABLE!), verifyNetwork: requiresCheck });

  function persist(patch: Partial<ProfileState>) {
    state = { ...state, ...patch };
    writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }
  function invalidate(error: string) {
    invalidated = true;
    lastVerifiedAt = undefined;
    context = undefined;
    tracker.reset();
    if (!stopping) persist({ phase: "blocked", error });
  }
  const shutdown = options.shutdown ?? (() => process.kill(process.pid, "SIGTERM"));
  function browserClosed() {
    if (stopping) return;
    stopping = true;
    invalidated = true;
    context = undefined;
    tracker.reset();
    persist({ phase: "stopping", error: null, checkFailure: null });
    // Closing the visible browser ends this lifetime. Drain the controller before
    // asking upstream to perform its normal shutdown and save a clean receipt.
    void (async () => {
      await controller.releaseCurrent();
      await controller.drain();
      shutdown();
    })();
  }
  function assertAdmitted() {
    if (!fingerprint || !initializedFingerprint(stateDir, owner, fingerprint.pinSha256))
      throw Error("The profile startup transaction is not admitted.");
  }
  function assertUsable() {
    assertAdmitted();
    if (invalidated || stopping || state.phase !== "ready") {
      throw Error(state.phase === "verification_failed"
        ? "IP verification failed. Run stelz recheck before browser actions."
        : `Profile is ${state.phase}; browser actions are unavailable.`);
    }
  }
  function verificationIsFresh() {
    if (lastVerifiedAt === undefined || invalidated || stopping || !context) return false;
    const elapsed = now() - lastVerifiedAt;
    return elapsed >= 0 && elapsed < interval;
  }
  function snapshot() {
    return { ...state,
      verificationFresh: verificationIsFresh(), typingModeDefault: parseTypingMode(process.env.STELZ_TYPING_MODE) };
  }
  function assertIdentity(body: Record<string, unknown> | undefined): asserts body is Record<string, unknown> & ControlIdentity {
    if (body?.profileId !== id || body?.instanceId !== state.instanceId) {
      throw Error("Control request does not match this profile and service instance.");
    }
  }
  function ownedController(body: Record<string, unknown> | undefined): string {
    assertIdentity(body);
    if (typeof body.controllerId !== "string" || !body.controllerId) throw Error("Controller ID is invalid.");
    return (body as OwnedControlRequest).controllerId;
  }
  function optionalController(body: Record<string, unknown> | undefined): string | undefined {
    if (body && ["controllerId", "profileId", "instanceId"].some(key => Object.hasOwn(body, key))) return ownedController(body);
    return undefined;
  }
  function runControl<T>(controllerId: string | undefined, action: () => Promise<T>) {
    return controllerId === undefined ? controller.runExclusive(action) : controller.run(controllerId, action);
  }
  async function bounded<T>(action: () => Promise<T>, limit = SERVICE_DEADLINE_MS): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = action();
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.retain(work);
        invalidate(TIME_LIMIT);
        reject(Error(TIME_LIMIT));
      }, options.actionTimeoutMs ?? limit);
    });
    try {
      return await Promise.race([work, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // All checks and browser actions use the same queue. A deadline latches a
  // terminal block because a timed-out upstream operation may still be active.
  async function ensureVerified(explicit = false, startup = false, startupPage?: Page) {
    if (startup) {
      if (invalidated || stopping || state.phase !== "starting" || !fingerprint) throw Error("Startup verification is unavailable.");
    } else if (explicit) {
      assertAdmitted();
      if (invalidated || stopping || !["ready", "paused", "verification_failed"].includes(state.phase)) {
        throw Error(`Cannot recheck a ${state.phase} profile.`);
      }
    } else {
      assertUsable();
    }
    const original = context;
    if (!original) throw Error("Original browser context is unavailable; explicit restart required");
    if (!requiresCheck) return;
    if (!explicit && verificationIsFresh()) return;
    try {
      const ip = await ipVerification.check();
      if (location) {
        const page = (startupPage ?? original.pages()[0]) as unknown as LocationPage | undefined;
        if (!page || state.phase === "starting" && page.url() !== "about:blank") throw locationFailure("BROWSER_LOCATION_MISMATCH");
        const { observed, evidence } = await verifyLaunchLocation(location, ip, page);
        if (invalidated || stopping || context !== original) throw Error("Original browser context was lost during verification");
        // This verifies applied settings, not the physical location. The evidence states how credible the location is.
        saveLaunchLocation(location, { ...location.result, phase: "browser_verification", status: "ready", browserStarted: true,
          browser: "passed", observed, evidence, geolocation: "configured", checkedAt: new Date().toISOString(),
          message: `The browser uses the checked exit and the prepared timezone and language.${evidence ? ` ${evidenceMessage(evidence)}` : ""}` });
      }
      if (invalidated || stopping || context !== original) throw Error("Original browser context was lost during verification");
      const phase = state.phase === "verification_failed" && explicit ? restorePhase : state.phase;
      persist({ phase, exitIp: ip, expectedIp: expected || null, checkedAt: new Date().toISOString(),
        fixedIpVerified: proxied && !!expected, verificationStatus: "verified", error: null, checkFailure: null });
      lastVerifiedAt = now();
    } catch (error) {
      lastVerifiedAt = undefined;
      if (location) {
        const failure = locationFailure(error instanceof LocationError ? error.location.code as Parameters<typeof locationFailure>[0] : "BROWSER_IP_FAILED",
          { ...location.result, phase: "browser_verification", browserStarted: true, browser: "failed", geolocation: "configured" });
        // Keep what the failed check measured, including a rotated exit's own evidence.
        if (error instanceof LocationError && error.location.observed) failure.location.observed = error.location.observed;
        if (error instanceof LocationError && error.location.evidence) failure.location.evidence = error.location.evidence;
        saveLaunchLocation(location, failure.location);
        if (state.phase === "starting") {
          invalidated = true;
          stopping = true;
          context = undefined;
          persist({ phase: "blocked", error: failure.message, verificationStatus: "verification_failed" });
          await controller.releaseCurrent();
          await original.close().catch(() => {});
          shutdown();
          throw failure;
        }
      }
      if (!invalidated && !stopping && context === original) {
        if (state.phase !== "verification_failed") restorePhase = state.phase === "paused" ? "paused" : "ready";
        persist({ phase: "verification_failed", verificationStatus: "verification_failed", exitIp: null, fixedIpVerified: false,
          error: proxied
            ? "Proxy exit IP verification failed. Correct the network and run stelz recheck. Direct fallback is disabled."
            : "Expected exit IP verification failed. Correct the network or expected IP and run stelz recheck.",
          checkFailure: (error as Error).message.slice(0, 500) });
      }
      throw error;
    }
    if (!explicit && !startup) assertUsable();
  }

  // The snapshot route of Camofox keeps the full annotated page in the tab state. Read it in the same queued action, so no other action changes it.
  // The route also rebuilds the refs of the tab. A read that no controller receives still changes what a ref names, and the stale-ref guard sees that.
  async function fetchPage(tabId: string, includeScreenshot: boolean, baseUrl: string, config: Record<string, unknown>) {
    // Use the request of the upstream tool, and change only the query. The upstream request always asks for a screenshot.
    const built = upstream.buildRequest(snapshotTool, { tabId }, { userId: id, sessionKey: "default" });
    const route = new URL(built.path, "http://127.0.0.1");
    route.searchParams.set("includeScreenshot", String(includeScreenshot));
    const reply = await upstream.fetchSpec(baseUrl, { ...built, path: `${route.pathname}${route.search}` }, config) as { url?: unknown; refsCount?: unknown; totalChars?: unknown; structure?: unknown; screenshot?: unknown } | null;
    const tab = readTab(ctx.sessions, id, tabId), yaml = tab?.lastSnapshot;
    // The reply and the tab state describe the same snapshot, or Camofox changed.
    if (!tab || !reply || typeof reply.url !== "string" || typeof yaml !== "string" || reply.totalChars !== yaml.length || reply.refsCount !== tab.refs.size)
      throw Error(TAB_STATE_CHANGED);
    return { reply, tab, yaml, url: reply.url };
  }

  async function readSnapshot(controllerId: string, args: Record<string, unknown>, baseUrl: string, config: Record<string, unknown>) {
    const tabId = args.tabId as string;
    if (typeof args.offset === "number" && args.offset > 0) {
      const tab = readTab(ctx.sessions, id, tabId);
      if (!tab) throw Error("The tab no longer exists. Read tab_list.");
      return snapshotResult(tracker.page(controllerId, tabId, args.viewId as string, args.offset, args.maxChars as number | undefined, tab.refs));
    }
    const { reply, tab, yaml, url } = await fetchPage(tabId, args.includeScreenshot === true, baseUrl, config);
    const { scope, contains, diff, collapse, maxChars } = args as SnapshotRequest;
    const request: SnapshotRequest = { ...(scope ? { scope } : {}), ...(contains === undefined ? {} : { contains }), ...(diff === undefined ? {} : { diff }),
      ...(collapse === undefined ? {} : { collapse }), ...(maxChars === undefined ? {} : { maxChars }) };
    const view = tracker.read(controllerId, tabId, { yaml, url, refsCount: tab.refs.size, refs: tab.refs, request });
    return snapshotResult(view, { ...(args.includeStructure === true && reply.structure != null ? { structure: reply.structure } : {}),
      ...(reply.screenshot ? { screenshot: reply.screenshot } : {}) });
  }

  // The page after an action, as the diff that tab_snapshot with diff builds. This read is a view: the controller receives it.
  // The action has happened, so a failed read never fails the call. A client could repeat the action.
  // The read has its own time limit, apart from the service deadline of the action. A read that hangs ends as a failed read: the call succeeds with the note.
  // The upstream read can still run, so the work stays with the controller and the lifetime is blocked, as for any operation that passes its limit.
  async function observePage(controllerId: string, tabId: string, baseUrl: string, config: Record<string, unknown>): Promise<ToolResult["observation"]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = (async (): Promise<ToolResult["observation"]> => {
      try {
        const { tab, yaml, url } = await fetchPage(tabId, false, baseUrl, config);
        return snapshotResult(tracker.read(controllerId, tabId, { yaml, url, refsCount: tab.refs.size, refs: tab.refs, request: { diff: true } }));
      } catch (error) {
        await afterFailure(error).catch(() => {});
        return { error: OBSERVATION_FAILED };
      }
    })();
    const deadline = new Promise<{ error: string }>(resolve => {
      timer = setTimeout(() => {
        controller.retain(work);
        invalidate(TIME_LIMIT);
        resolve({ error: OBSERVATION_FAILED });
      }, options.observeTimeoutMs ?? OBSERVE_LIMIT_MS);
    });
    try {
      return await Promise.race([work, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Poll fresh snapshots until the element or the text is on the page. The polls are not views: the controller receives none of them.
  // A pause or a release waits for this action, so the loop ends when either begins. The result is not an error.
  async function waitFor(tabId: string, args: Record<string, unknown>, baseUrl: string, config: Record<string, unknown>): Promise<ToolResult> {
    const condition: Condition = args.target === undefined ? { contains: String(args.contains) } : { target: args.target as Target };
    const timeout = waitDuration(args), started = performance.now();
    const elapsed = () => performance.now() - started;
    const result = (found: boolean, more: Record<string, unknown>): ToolResult => ({ kind: "json", payload: { found, waitedMs: Math.round(elapsed()), ...more } });
    for (;;) {
      const matched = findCondition(parseAria((await fetchPage(tabId, false, baseUrl, config)).yaml), condition, ariaHelpers);
      if (matched !== undefined) return result(true, { matched });
      if (elapsed() >= timeout) return result(false, { reason: "timeout" });
      await new Promise(resolve => setTimeout(resolve, Math.min(WAIT_POLL_MS, timeout - elapsed())));
      const reason = controller.status()?.releasing ? "releasing" : state.phase === "paused" ? "paused" : undefined;
      if (reason) return result(false, { reason });
      assertUsable();
    }
  }

  async function recheckAfterNetworkFailure(value: unknown) {
    if (!requiresCheck || invalidated || stopping || !context || !isBrowserNetworkFailure(value)) return;
    lastVerifiedAt = undefined;
    persist({ verificationStatus: "unverified", exitIp: null, fixedIpVerified: false });
    await ensureVerified(true);
  }
  // What a failed browser call means for the lifetime. A network failure checks the exit again. A timeout can leave work in the browser, so it blocks the lifetime.
  async function afterFailure(error: unknown) {
    if (isBrowserNetworkFailure(error)) await recheckAfterNetworkFailure(error);
    else if (/timed out|timeout/i.test((error as Error).message)) invalidate("A browser action timed out. Stop the profile before another browser action.");
  }

  persist({});
  ctx.events.on("browser:launching", ({ options: launchOptions }) => {
    if (launchAdmitted || invalidated || stopping) {
      const error = "Replacement browser refused; explicit stop/start is required";
      invalidate(error);
      throw Error(error);
    }
    launchAdmitted = true;
    try {
      // Add the window extension first, so validation covers the complete launch config.
      windows.prepare(launchOptions.proxy);
      addProfileExtension(launchOptions, windows.extensionPath);
      fingerprint = applyFingerprint(launchOptions, stateDir, process.env.STELZ_CAMOUFOX_EXECUTABLE!, proxied, owner);
      if (location) {
        try { checkLaunchLocation(launchOptions, location); }
        catch {
          const failure = locationFailure("BROWSER_LOCATION_MISMATCH", location.result);
          saveLaunchLocation(location, failure.location);
          setTimeout(() => { if (!stopping) shutdown(); }, 20);
          throw failure;
        }
      }
      validateFinalLaunch(launchOptions, fingerprint);
      persist({ phase: "starting", fingerprintSha256: fingerprint.fingerprintSha256, engineSha256: fingerprint.engineSha256,
        pinSha256: fingerprint.pinSha256, startupPrepared: false });
    } catch (error) {
      invalidate((error as Error).message);
      setTimeout(() => { if (!stopping) shutdown(); }, 20);
      throw error;
    }
  });
  ctx.events.on("browser:launched", ({ browser }) => browser.on("disconnected", browserClosed));
  ctx.events.on("session:creating", ({ userId, contextOptions }) => {
    if (userId !== id) throw Error("This runtime belongs to a different profile");
    if (!launchAdmitted || sessionAdmitted || invalidated || stopping || state.phase !== "starting") {
      const error = "Replacement browser context refused; explicit stop/start is required";
      invalidate(error);
      throw Error(error);
    }
    sessionAdmitted = true;
    if (contextOptions.proxy) contextOptions.proxy.bypass = "127.0.0.1,localhost";
  });
  ctx.events.on("session:created", async ({ userId, context: created }) => {
    if (userId !== id || !sessionAdmitted || context || invalidated || stopping || state.phase !== "starting") {
      invalidate("Unexpected browser context refused; explicit stop/start is required");
      await created.close().catch(() => {});
      throw Error(String(state.error));
    }
    context = created;
    created.on("close", browserClosed);
    const watchPage = (page: Page) => page.on("close", () => {
      // Firefox on macOS can keep its process and context connected after the
      // last window closes. That browser still has no pages left to control.
      if (context === created && created.pages().length === 0) browserClosed();
    });
    for (const page of created.pages()) watchPage(page);
    created.on("page", watchPage);
    let verifyingNetwork = false;
    try {
      await controller.runExclusive(() => bounded(async () => {
        if (!fingerprint) throw Error("The staged fingerprint is unavailable.");
        const page = options.verifyFingerprint ? await options.verifyFingerprint(created, fingerprint)
          : await verifyProfileFingerprint(created, fingerprint, windows.observeStartup);
        if (invalidated || stopping || context !== created) throw Error("Original browser context was lost during verification.");
        verifyingNetwork = true;
        await ensureVerified(false, true, page || undefined);
        verifyingNetwork = false;
        if (invalidated || stopping || context !== created || state.phase !== "starting") throw Error("Startup ownership changed during verification.");
        persist({ startupPrepared: true });
      }));
    } catch (error) {
      if (location && verifyingNetwork && !stopping) {
        // A queue deadline can fire before ensureVerified settles. Close only
        // this initial context, and prevent its late result from granting control.
        invalidated = true;
        stopping = true;
        context = undefined;
        const failure = locationFailure("BROWSER_IP_FAILED", { ...location.result,
          phase: "browser_verification", browserStarted: true, browser: "failed" });
        saveLaunchLocation(location, failure.location);
        persist({ phase: "blocked", error: failure.message, verificationStatus: "verification_failed" });
        await created.close().catch(() => {});
        shutdown();
      }
      if (!stopping) {
        const message = invalidated && state.error ? state.error : (error as Error).message || "Original browser context initialization failed.";
        invalidated = true; stopping = true; context = undefined;
        persist({ phase: "blocked", error: message, startupPrepared: false });
        await created.close().catch(() => {});
        shutdown();
      }
      throw error;
    }
  });
  ctx.events.on("session:destroying", async ({ userId }) => {
    if (userId !== id) return;
    invalidate("Original browser context is being destroyed; explicit stop/start is required");
    await ipVerification.close().catch(() => {});
  });
  ctx.events.on("browser:restart", () => invalidate("Browser restart refused; explicit stop/start is required"));
  ctx.events.on("browser:closed", browserClosed);
  ctx.events.on("server:shutdown", () => {
    stopping = true;
    invalidated = true;
    context = undefined;
    tracker.reset();
    void ipVerification.close();
    persist({ phase: state.phase === "blocked" ? "blocked" : "stopped" });
  });

  app.get("/local-profile/status", ctx.auth(), (_req, res) => {
    const { available, reason } = windows.snapshot();
    res.json({ ...snapshot(), controller: controller.status(), windowControls: { available, reason } });
  });
  app.post("/local-profile/startup-ack", ctx.auth(), (req, res) => {
    try {
      if (req.headers?.["x-stelz-bootstrap"] !== process.env.STELZ_BOOTSTRAP_TOKEN ||
          req.body?.instanceId !== owner.attemptId || req.body?.browserInstanceId !== owner.browserInstanceId ||
          invalidated || stopping || !context || state.phase !== "starting" || !state.startupPrepared)
        throw Error("Startup acknowledgment does not match this browser instance.");
      assertAdmitted();
      persist({ phase: "ready" });
      res.json(snapshot());
    } catch (error) { res.status(409).json({ error: (error as Error).message }); }
  });
  app.get("/local-profile/windows", ctx.auth(), (_req, res) => res.json(windows.snapshot()));
  app.post("/local-profile/network-bridge", ctx.auth(), (req, res) => {
    try { res.json(ipVerification.exchange(req.body)); }
    catch { res.status(400).json({ error: "Invalid browser network response." }); }
  });
  app.post("/local-profile/window-bridge", ctx.auth(), (req, res) => {
    try { res.json(windows.exchange(req.body)); }
    catch { res.status(400).json({ error: "Invalid window inventory." }); }
  });
  app.post("/local-profile/window-show", ctx.auth(), async (req, res) => {
    try {
      assertAdmitted();
      if (!["ready", "paused", "verification_failed"].includes(state.phase)) throw Error(`Profile is ${state.phase}.`);
      await controller.runExclusive(() => windows.show(req.body));
      res.json({ shown: true });
    } catch (error) { res.status(409).json({ error: (error as Error).message }); }
  });
  app.post("/local-profile/acquire", ctx.auth(), (req, res) => {
    try {
      const body = req.body;
      assertIdentity(body);
      assertAdmitted();
      if (!["ready", "paused", "verification_failed"].includes(state.phase)) throw Error(`Profile is ${state.phase}.`);
      const lease = controller.acquire(body as AcquireControlRequest);
      // A new controller has seen nothing. A person or another controller changed the pages after the last one.
      tracker.reset();
      res.json({ ...snapshot(), ...lease });
    } catch (error) {
      res.status(409).json({ error: (error as Error).message });
    }
  });
  app.post("/local-profile/release", ctx.auth(), async (req, res) => {
    try {
      const controllerId = ownedController(req.body);
      const released = await controller.release(controllerId);
      tracker.release(controllerId);
      res.json({ ...released, profileId: id });
    } catch (error) {
      res.status(409).json({ error: (error as Error).message });
    }
  });
  app.post("/local-profile/handoff", ctx.auth(), async (_req, res) => {
    await controller.releaseCurrent();
    tracker.reset();
    res.json({ released: true, profileId: id });
  });
  app.post("/local-profile/tool", ctx.auth(), async (req, res) => {
    try {
      const controllerId = ownedController(req.body);
      const body = req.body || {};
      const name = String(body.name || "");
      const found = browserTools.get(name);
      if (!found) throw Error("Unknown browser tool.");
      let args = toolArguments(found.tool, body.args);
      const baseUrl = `http://127.0.0.1:${process.env.CAMOFOX_PORT}`;
      const config = { accessKey: process.env.CAMOFOX_ACCESS_KEY, apiKey: process.env.CAMOFOX_API_KEY, cookiesDir: process.env.CAMOFOX_COOKIES_DIR };
      // The tab to read after the action. It is set only when the action succeeded and the caller wants the page.
      let observed: string | undefined;
      const result = await controller.run(controllerId, async () => {
        // The service deadline covers the action alone. The read of the page after it has its own limit, so the deadline never fires during that read.
        const action = await bounded(async () => {
          // Read the switch on each call, inside the queue, so a change applies to a running browser.
          if (found.entry.policy === "scripts") assertScriptsAllowed(process.env.STELZ_HOME, id, name);
          await ensureVerified();
          if (name === "tab_type") {
            const { mode, ...input } = args;
            args = { ...input, typingMode: mode ?? profileTypingMode(process.env.STELZ_HOME, id) };
          }
          // A ref is a position. Refuse one that this controller did not see in a reply, or that now names another element. A selector is not checked.
          if (args.ref && typeof args.tabId === "string" && found.tool.inputSchema.properties && "ref" in found.tool.inputSchema.properties)
            tracker.check(controllerId, args.tabId, String(args.ref), readTab(ctx.sessions, id, args.tabId)?.refs);
          try {
            const tabId = args.tabId as string;
            if (name === "tab_snapshot") return await readSnapshot(controllerId, args, baseUrl, config);
            if (name === "tab_wait" && (args.target !== undefined || args.contains !== undefined)) return await waitFor(tabId, args, baseUrl, config);
            // Upstream does not know these two arguments.
            const { observe, target, ...request } = args;
            // A target becomes a ref in this queued action, from a fresh snapshot. No controller receives that snapshot,
            // so it changes no baseline, view, or shown ref. The ref needs no guard. Upstream checks nothing more: the ref and the page agree.
            if (target) request.ref = resolveTarget(parseAria((await fetchPage(tabId, false, baseUrl, config)).yaml), target as Target, ariaHelpers);
            const { spec, payload } = await upstream.runTool(found.entry.upstream, request, { userId: id, sessionKey: "default" }, baseUrl, config);
            await recheckAfterNetworkFailure(payload);
            if (name === "tab_close") tracker.dropTab(controllerId, tabId);
            // Return the raw payload. Only the MCP server formats it.
            const done: ToolResult = { kind: spec?.responseKind ?? "json", payload: name === "tab_click" ? withoutEmbeddedSnapshot(payload, name) : payload };
            if (found.tool.inputSchema.properties && "observe" in found.tool.inputSchema.properties && observe !== "none" && !refused(payload)) observed = tabId;
            return done;
          } catch (error) {
            // A selector that matches no safe element is the caller's mistake. The name in its message can contain "timeout".
            if (error instanceof SelectorError) throw error;
            if (name === "tab_evaluate" && isEvaluateTimeout(error)) {
              // Upstream kept the tab and reported the timeout itself, so the browser lifetime stays usable.
              throw Error(EVALUATE_TIMEOUT);
            }
            await afterFailure(error);
            throw name === "tab_extract" ? withoutEmbeddedSnapshotError(error) : error;
          }
        }, serviceDeadline(actionDeadline(name, args)));
        return observed === undefined ? action : { ...action, observation: await observePage(controllerId, observed, baseUrl, config) };
      });
      res.json(result);
    } catch (error) {
      res.status(409).json({ error: (error as Error).message });
    }
  });
  app.post("/local-profile/stop", ctx.auth(), async (req, res) => {
    if (req.body?.instanceId !== undefined && req.body.instanceId !== owner.attemptId) {
      res.status(409).json({ error: "Stop request does not match this service instance." });
      return;
    }
    if (stopping) { res.json({ stopping: true }); return; }
    stopping = true;
    persist({ phase: "stopping" });
    // Explicit stop may terminate an uncertain browser operation. Keep the
    // controller closed to admission while shutdown ends the browser lifetime.
    void controller.releaseCurrent();
    res.json({ stopping: true });
    void (async () => { await controller.drain(); setTimeout(shutdown, 20); })();
  });
  app.post("/local-profile/check", ctx.auth(), async (req, res) => {
    try {
      assertAdmitted();
      const controllerId = optionalController(req.body);
      await runControl(controllerId, () => bounded(() => ensureVerified(true)));
      res.json(snapshot());
    } catch (error) {
      res.status(409).json({ error: (error as Error).message });
    }
  });
  app.post("/local-profile/pause", ctx.auth(), async (req, res) => {
    try {
      assertAdmitted();
      const controllerId = optionalController(req.body);
      if (controllerId !== undefined) controller.assertOwner(controllerId);
      if (state.phase !== "ready" && state.phase !== "paused") throw Error(`Cannot pause ${state.phase} profile`);
      pauseGeneration++;
      persist({ phase: "paused" });
      // Admit a barrier after changing phase so release also waits for this pause.
      await runControl(controllerId, async () => {});
      if (state.phase !== "paused") throw Error(`Cannot acknowledge human takeover of a ${state.phase} profile. Stop it before further work.`);
      res.json(snapshot());
    } catch (error) {
      res.status(409).json({ error: (error as Error).message });
    }
  });
  app.post("/local-profile/resume", ctx.auth(), async (req, res) => {
    try {
      assertAdmitted();
      const controllerId = optionalController(req.body);
      const generation = pauseGeneration;
      await runControl(controllerId, () => bounded(async () => {
        if (state.phase !== "paused") throw Error(`Cannot resume ${state.phase} profile`);
        // A person used the window during the pause, so no controller can rely on what it saw before.
        tracker.reset();
        await ensureVerified(true);
        if (generation !== pauseGeneration) throw Error("A newer pause superseded this resume.");
        if (state.phase === "paused") persist({ phase: "ready" });
      }));
      res.json(snapshot());
    } catch (error) {
      res.status(409).json({ error: (error as Error).message });
    }
  });
}

export { launchProfileBrowser, claimProfileContext, protectProfileStartup } from "./native-profile.ts";
