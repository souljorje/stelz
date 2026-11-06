// Compiled to Node ESM; loaded by Camofox's supported plugin hooks.
import { writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createControllerLease } from "../mcp/controller.ts";
import { CONTROL_PROTOCOL_VERSION, type ControlIdentity, type OwnedControlRequest, type AcquireControlRequest } from "../mcp/control-protocol.ts";
import { applyFingerprint, type LaunchOptions } from "./fingerprint.ts";
import { createIpVerification, parseIpCheckInterval, type Probe } from "./ip-verification.ts";
import { allowedBrowserTools, browserToolArguments } from "../mcp/tool-policy.ts";
import type { Contracts } from "./upstream.ts";
import { addProfileExtension, createProfileWindows } from "./profile-windows.ts";
import { activateProfileBrowser } from "./window-activation.ts";
import { profileTypingMode } from "../profiles/typing-mode.ts";
import { parseTypingMode } from "./typing.ts";
export { typeIntoLocator } from "./typing.ts";

type Page = { on(event: "close", listener: () => void): unknown };
type Context = {
  close(): Promise<void>;
  pages(): Page[];
  on(event: "close", listener: () => void): unknown;
  on(event: "page", listener: (page: Page) => void): unknown;
};
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
type Handler = (req: { body?: Record<string, unknown> }, res: Response, next?: () => void) => unknown;
type App = { get(path: string, ...handlers: Handler[]): void; post(path: string, ...handlers: Handler[]): void };
type PluginContext = {
  auth(): Handler;
  sessions: Map<string, unknown>;
  createLeasedPage(session: unknown): Promise<{ page: Probe; lease: unknown }>;
  closeLeasedPage(session: unknown, page: Probe, lease: unknown): Promise<void>;
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
  error?: string | null;
  checkFailure?: string | null;
};

const ACTION_TIMEOUT_MS = 60_000;

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

export async function register(app: App, ctx: PluginContext, options: {
  actionTimeoutMs?: number; shutdown?: () => void; ipCheckIntervalMs?: number; now?: () => number;
} = {}) {
  const id = process.env.STELZ_PROFILE_ID!;
  const stateDir = process.env.STELZ_PROFILE_DIR!;
  if (!id || !stateDir) throw Error("local-profile requires STELZ_PROFILE_ID and STELZ_PROFILE_DIR");
  const file = join(stateDir, "status.json");
  const proxied = !!process.env.PROXY_HOST;
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
  const browserTools = new Map(allowedBrowserTools(upstream.TOOL_DEFS).map(tool => [tool.name, tool]));
  const ipVerification = createIpVerification(ctx, id, expected);
  const timeout = options.actionTimeoutMs ?? ACTION_TIMEOUT_MS;
  let context: Context | undefined;
  let stopping = false;
  let launchAdmitted = false;
  let sessionAdmitted = false;
  let invalidated = false;
  let pauseGeneration = 0;
  let restorePhase: "ready" | "paused" = "ready";
  const windows = createProfileWindows({ id, instanceId: state.instanceId, directory: stateDir,
    port: Number(process.env.CAMOFOX_PORT), accessKey: process.env.CAMOFOX_ACCESS_KEY!, phase: () => state.phase,
    activate: () => activateProfileBrowser(process.env.CAMOUFOX_EXECUTABLE!) });

  function persist(patch: Partial<ProfileState>) {
    state = { ...state, ...patch };
    writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }
  function invalidate(error: string) {
    invalidated = true;
    lastVerifiedAt = undefined;
    context = undefined;
    if (!stopping) persist({ phase: "blocked", error });
  }
  const shutdown = options.shutdown ?? (() => process.kill(process.pid, "SIGTERM"));
  function browserClosed() {
    if (stopping) return;
    stopping = true;
    invalidated = true;
    context = undefined;
    persist({ phase: "stopping", error: null, checkFailure: null });
    // Closing the visible browser ends this lifetime. Drain the controller before
    // asking upstream to perform its normal shutdown and save a clean receipt.
    void (async () => {
      await controller.releaseCurrent();
      await controller.drain();
      shutdown();
    })();
  }
  function assertUsable() {
    if (invalidated || stopping || (state.phase !== "starting" && state.phase !== "ready")) {
      throw Error(state.phase === "verification_failed"
        ? "IP verification failed. Run stelz recheck before browser actions."
        : `Profile is ${state.phase}; browser actions are unavailable.`);
    }
  }
  function verificationFailed() {
    return state.phase === "verification_failed";
  }
  function verificationIsFresh() {
    if (lastVerifiedAt === undefined || invalidated || stopping || !context) return false;
    const elapsed = now() - lastVerifiedAt;
    return elapsed >= 0 && elapsed < interval;
  }
  function snapshot() {
    return { ...state, controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
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
  async function bounded<T>(action: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = action();
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.retain(work);
        invalidate("A service operation exceeded its time limit. Stop the profile before another browser action.");
        reject(Error("A service operation exceeded its time limit. Stop the profile before another browser action."));
      }, timeout);
    });
    try {
      return await Promise.race([work, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // All checks and browser actions use the same queue. A deadline latches a
  // terminal block because a timed-out upstream operation may still be active.
  async function ensureVerified(explicit = false) {
    if (explicit) {
      if (invalidated || stopping || !["starting", "ready", "paused", "verification_failed"].includes(state.phase)) {
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
      if (invalidated || stopping || context !== original) throw Error("Original browser context was lost during verification");
      const phase = state.phase === "verification_failed" && explicit ? restorePhase : state.phase;
      persist({ phase, exitIp: ip, expectedIp: expected || null, checkedAt: new Date().toISOString(),
        fixedIpVerified: proxied && !!expected, verificationStatus: "verified", error: null, checkFailure: null });
      lastVerifiedAt = now();
    } catch (error) {
      lastVerifiedAt = undefined;
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
    if (!explicit) assertUsable();
  }

  async function recheckAfterNetworkFailure(value: unknown) {
    if (!requiresCheck || invalidated || stopping || !context || !isBrowserNetworkFailure(value)) return;
    lastVerifiedAt = undefined;
    persist({ verificationStatus: "unverified", exitIp: null, fixedIpVerified: false });
    await ensureVerified(true);
  }

  persist({});
  ctx.events.on("browser:launching", ({ options: launchOptions }) => {
    if (launchAdmitted || invalidated || stopping) {
      const error = "Replacement browser refused; explicit stop/start is required";
      invalidate(error);
      throw Error(error);
    }
    launchAdmitted = true;
    const hashes = applyFingerprint(launchOptions, stateDir, process.env.CAMOUFOX_EXECUTABLE!, proxied);
    addProfileExtension(launchOptions, windows.extensionPath);
    persist({ phase: "starting", ...hashes });
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
    try {
      await controller.runExclusive(() => bounded(() => ensureVerified()));
      if (state.phase === "starting") persist({ phase: "ready" });
    } catch (error) {
      if (verificationFailed()) return;
      if (!invalidated) invalidate("Original browser context initialization failed; explicit stop/start is required");
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
    persist({ phase: "stopped" });
  });

  app.get("/local-profile/status", ctx.auth(), (_req, res) => {
    const { available, reason } = windows.snapshot();
    res.json({ ...snapshot(), controller: controller.status(), windowControls: { available, reason } });
  });
  app.get("/local-profile/windows", ctx.auth(), (_req, res) => res.json(windows.snapshot()));
  app.post("/local-profile/window-bridge", ctx.auth(), (req, res) => {
    try { res.json(windows.exchange(req.body)); }
    catch { res.status(400).json({ error: "Invalid window inventory." }); }
  });
  app.post("/local-profile/window-show", ctx.auth(), async (req, res) => {
    try {
      await controller.runExclusive(() => windows.show(req.body));
      res.json({ shown: true });
    } catch (error) { res.status(409).json({ error: (error as Error).message }); }
  });
  app.post("/local-profile/acquire", ctx.auth(), (req, res) => {
    try {
      const body = req.body;
      assertIdentity(body);
      if (!["ready", "paused", "verification_failed"].includes(state.phase)) throw Error(`Profile is ${state.phase}.`);
      const lease = controller.acquire(body as AcquireControlRequest);
      res.json({ ...snapshot(), ...lease });
    } catch (error) {
      res.status(409).json({ error: (error as Error).message });
    }
  });
  app.post("/local-profile/release", ctx.auth(), async (req, res) => {
    try {
      const controllerId = ownedController(req.body);
      res.json({ ...await controller.release(controllerId), profileId: id });
    } catch (error) {
      res.status(409).json({ error: (error as Error).message });
    }
  });
  app.post("/local-profile/handoff", ctx.auth(), async (_req, res) => {
    await controller.releaseCurrent();
    res.json({ released: true, profileId: id });
  });
  app.post("/local-profile/tool", ctx.auth(), async (req, res) => {
    try {
      const controllerId = ownedController(req.body);
      const body = req.body || {};
      const name = String(body.name || "");
      const tool = browserTools.get(name);
      if (!tool) throw Error("Unknown browser tool.");
      let args = browserToolArguments(tool, body.args);
      const result = await controller.run(controllerId, () => bounded(async () => {
        await ensureVerified();
        if (name === "camofox_type") {
          const { mode, typingMode: _internal, ...input } = args;
          args = { ...input, typingMode: mode ?? profileTypingMode(process.env.STELZ_HOME, id) };
        }
        try {
          const { spec, payload } = await upstream.runTool(name, args,
            { userId: id, sessionKey: "default" }, `http://127.0.0.1:${process.env.CAMOFOX_PORT}`,
            { accessKey: process.env.CAMOFOX_ACCESS_KEY, apiKey: process.env.CAMOFOX_API_KEY, cookiesDir: process.env.CAMOFOX_COOKIES_DIR });
          await recheckAfterNetworkFailure(payload);
          return { content: upstream.adaptResponse(spec, payload) };
        } catch (error) {
          if (isBrowserNetworkFailure(error)) {
            await recheckAfterNetworkFailure(error);
          } else if (/timed out|timeout/i.test((error as Error).message)) {
            invalidate("A browser action timed out. Stop the profile before another browser action.");
          }
          throw error;
        }
      }));
      res.json(result);
    } catch (error) {
      res.status(409).json({ error: (error as Error).message });
    }
  });
  app.post("/local-profile/stop", ctx.auth(), async (_req, res) => {
    stopping = true;
    persist({ phase: "stopping" });
    // Explicit stop may terminate an uncertain browser operation. Keep the
    // controller closed to admission while shutdown ends the browser lifetime.
    void controller.releaseCurrent();
    await controller.drain();
    res.json({ stopping: true });
    setTimeout(shutdown, 20);
  });
  app.post("/local-profile/check", ctx.auth(), async (req, res) => {
    try {
      const controllerId = optionalController(req.body);
      await runControl(controllerId, () => bounded(() => ensureVerified(true)));
      res.json(snapshot());
    } catch (error) {
      res.status(409).json({ error: (error as Error).message });
    }
  });
  app.post("/local-profile/pause", ctx.auth(), async (req, res) => {
    try {
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
      const controllerId = optionalController(req.body);
      const generation = pauseGeneration;
      await runControl(controllerId, () => bounded(async () => {
        if (state.phase !== "paused") throw Error(`Cannot resume ${state.phase} profile`);
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

export { launchProfileBrowser, claimProfileContext } from "./native-profile.ts";
