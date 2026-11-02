// Compiled to Node ESM; loaded by Camofox's supported plugin hooks.
import { writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createControllerLease } from "./controller.ts";
import { applyFingerprint, type LaunchOptions } from "./fingerprint.ts";
import { createIpVerification, type Probe } from "./ip-verification.ts";
import { allowedBrowserTools } from "./tool-policy.ts";
import type { Contracts } from "./upstream.ts";

type Context = {
  close(): Promise<void>;
  on(event: "close", listener: () => void): unknown;
};
type Events = {
  "browser:launching": { options: LaunchOptions };
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
  identityId: string;
  instanceId: string;
  mode: "direct" | "proxy";
  phase: Phase;
  exitIp: string | null;
  expectedIp?: string | null;
  checkedAt?: string;
  fixedIpVerified?: boolean;
  fingerprintSha256?: string;
  engineSha256?: string;
  error?: string | null;
  checkFailure?: string | null;
};

const ACTION_TIMEOUT_MS = 60_000;

export async function register(app: App, ctx: PluginContext, options: { actionTimeoutMs?: number } = {}) {
  const id = process.env.STELZ_PROFILE_ID!;
  const stateDir = process.env.STELZ_PROFILE_DIR!;
  if (!id || !stateDir) throw Error("local-profile requires STELZ_PROFILE_ID and STELZ_PROFILE_DIR");
  const file = join(stateDir, "status.json");
  const mode = process.env.STELZ_MODE === "proxy" ? "proxy" : "direct";
  let state: ProfileState = { identityId: id, instanceId: randomUUID(), mode, phase: "starting", exitIp: null };
  const controller = createControllerLease();
  const upstream = await import(pathToFileURL(join(process.env.STELZ_UPSTREAM!, "mcp/lib/tool-contracts.mjs")).href) as Contracts;
  const browserTools = new Set(allowedBrowserTools(upstream.TOOL_DEFS).map(tool => tool.name));
  const expected = process.env.STELZ_EXPECTED_IP || "";
  const ipVerification = createIpVerification(ctx, id, expected);
  const requiresCheck = mode === "proxy" || !!expected;
  const timeout = options.actionTimeoutMs ?? ACTION_TIMEOUT_MS;
  let context: Context | undefined;
  let stopping = false;
  let launchAdmitted = false;
  let sessionAdmitted = false;
  let invalidated = false;
  let restorePhase: "ready" | "paused" = "ready";

  function persist(patch: Partial<ProfileState>) {
    state = { ...state, ...patch };
    writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }
  function invalidate(error: string) {
    invalidated = true;
    context = undefined;
    if (!stopping) persist({ phase: "blocked", error });
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
  async function bounded<T>(action: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        invalidate("A service operation exceeded its time limit. Stop the identity before another browser action.");
        reject(Error("A service operation exceeded its time limit. Stop the identity before another browser action."));
      }, timeout);
    });
    try {
      return await Promise.race([action(), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // All checks and browser actions use the same queue. A deadline latches a
  // terminal block because a timed-out upstream operation may still be active.
  async function verify(explicit = false) {
    if (explicit) {
      if (invalidated || stopping || !["starting", "ready", "paused", "verification_failed"].includes(state.phase)) {
        throw Error(`Cannot recheck a ${state.phase} identity.`);
      }
    } else {
      assertUsable();
    }
    const original = context;
    if (!original) throw Error("Original browser context is unavailable; explicit restart required");
    if (!requiresCheck) return;
    try {
      const ip = await ipVerification.check();
      if (invalidated || stopping || context !== original) throw Error("Original browser context was lost during verification");
      const phase = state.phase === "verification_failed" && explicit ? restorePhase : state.phase;
      persist({ phase, exitIp: ip, expectedIp: expected || null, checkedAt: new Date().toISOString(),
        fixedIpVerified: mode === "proxy" && !!expected, error: null, checkFailure: null });
    } catch (error) {
      if (!invalidated && !stopping && context === original) {
        if (state.phase !== "verification_failed") restorePhase = state.phase === "paused" ? "paused" : "ready";
        persist({ phase: "verification_failed", exitIp: null, fixedIpVerified: false,
          error: "Browser exit IP verification failed. Correct the network and run stelz recheck. Direct fallback is disabled.",
          checkFailure: (error as Error).message.slice(0, 500) });
      }
      throw error;
    }
    if (!explicit) assertUsable();
  }

  persist({});
  ctx.events.on("browser:launching", ({ options: launchOptions }) => {
    if (launchAdmitted || invalidated || stopping) {
      invalidate("Replacement browser refused; explicit stop/start is required");
      throw Error(String(state.error));
    }
    launchAdmitted = true;
    const hashes = applyFingerprint(launchOptions, stateDir, process.env.CAMOUFOX_EXECUTABLE!, mode === "proxy");
    persist({ phase: "starting", ...hashes });
  });
  ctx.events.on("session:creating", ({ userId, contextOptions }) => {
    if (userId !== id) throw Error("This runtime belongs to a different profile");
    if (!launchAdmitted || sessionAdmitted || invalidated || stopping || state.phase !== "starting") {
      invalidate("Replacement browser context refused; explicit stop/start is required");
      throw Error(String(state.error));
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
    created.on("close", () => invalidate("Original browser context closed; explicit stop/start is required"));
    try {
      await controller.runExclusive(() => bounded(() => verify()));
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
  ctx.events.on("browser:closed", () => invalidate("Original browser closed; explicit stop/start is required"));
  ctx.events.on("server:shutdown", () => {
    stopping = true;
    invalidated = true;
    context = undefined;
    persist({ phase: "stopped" });
  });

  app.get("/local-profile/status", ctx.auth(), (_req, res) => res.json({ ...state, controller: controller.status() }));
  app.post("/local-profile/acquire", ctx.auth(), (req, res) => {
    try {
      if (!["ready", "paused", "verification_failed"].includes(state.phase)) throw Error(`Identity is ${state.phase}.`);
      const body = req.body || {};
      const lease = controller.acquire({ id: String(body.id || ""), pid: Number(body.pid), label: String(body.label || "MCP client") });
      res.json({ ...state, ...lease });
    } catch (error) {
      res.status(409).json({ error: (error as Error).message });
    }
  });
  app.post("/local-profile/release", ctx.auth(), async (req, res) => {
    try {
      res.json({ ...await controller.release(String(req.body?.controllerId || "")), identityId: id });
    } catch (error) {
      res.status(409).json({ error: (error as Error).message });
    }
  });
  app.post("/local-profile/handoff", ctx.auth(), async (_req, res) => {
    await controller.releaseCurrent();
    res.json({ released: true, identityId: id });
  });
  app.post("/local-profile/tool", ctx.auth(), async (req, res) => {
    try {
      const body = req.body || {};
      const name = String(body.name || "");
      if (!browserTools.has(name)) throw Error("Unknown browser tool.");
      const result = await controller.run(String(body.controllerId || ""), () => bounded(async () => {
        await verify();
        try {
          const { spec, payload } = await upstream.runTool(name, (body.args || {}) as Record<string, unknown>,
            { userId: id, sessionKey: "default" }, `http://127.0.0.1:${process.env.CAMOFOX_PORT}`,
            { accessKey: process.env.CAMOFOX_ACCESS_KEY, apiKey: process.env.CAMOFOX_API_KEY, cookiesDir: process.env.CAMOFOX_COOKIES_DIR });
          return { content: upstream.adaptResponse(spec, payload) };
        } catch (error) {
          if (/timed out|timeout/i.test((error as Error).message)) {
            invalidate("A browser action timed out. Stop the identity before another browser action.");
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
    await controller.releaseCurrent();
    await controller.drain();
    res.json({ stopping: true });
    setTimeout(() => process.kill(process.pid, "SIGTERM"), 20);
  });
  app.post("/local-profile/check", ctx.auth(), async (req, res) => {
    try {
      if (req.body?.controllerId && controller.status()?.id !== req.body.controllerId) throw Error("This connection does not control the identity.");
      await controller.runExclusive(() => bounded(() => verify(true)));
      res.json(state);
    } catch (error) {
      res.status(409).json({ error: (error as Error).message });
    }
  });
  app.post("/local-profile/pause", ctx.auth(), async (req, res) => {
    if (req.body?.controllerId && controller.status()?.id !== req.body.controllerId) return res.status(409).json({ error: "This connection does not control the identity." });
    if (state.phase !== "ready") return res.status(409).json({ error: `Cannot pause ${state.phase} profile` });
    persist({ phase: "paused" });
    await controller.drain();
    res.json(state);
  });
  app.post("/local-profile/resume", ctx.auth(), async (req, res) => {
    try {
      if (req.body?.controllerId && controller.status()?.id !== req.body.controllerId) throw Error("This connection does not control the identity.");
      await controller.runExclusive(() => bounded(async () => {
        if (state.phase !== "paused") throw Error(`Cannot resume ${state.phase} profile`);
        await verify(true);
        if (state.phase === "paused") persist({ phase: "ready" });
      }));
      res.json(state);
    } catch (error) {
      res.status(409).json({ error: (error as Error).message });
    }
  });
}

export { launchIdentityBrowser, claimIdentityContext } from "./native-profile.ts";
