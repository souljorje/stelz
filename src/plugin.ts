// Compiled to Node ESM; loaded by Camofox's supported plugin hooks.
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";
import { ControllerLease } from "./controller.ts";
import type { Contracts } from "./upstream.ts";

type Context = {
  newPage(): Promise<Probe>;
  close(): Promise<void>;
};
type Probe = { goto(url: string, options: object): Promise<unknown>; evaluate<T>(fn: () => Promise<T>): Promise<T>; close(): Promise<void> };
type LaunchOptions = { env?: Record<string, string>; firefoxUserPrefs?: Record<string, unknown>; proxy?: Record<string, unknown> };
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
const runtimeKey = (k: string) => /^(geolocation:|locale:|webrtc:|timezone$)/.test(k);
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

export async function register(app: App, ctx: PluginContext) {
  const id = process.env.STELZ_PROFILE_ID!, stateDir = process.env.STELZ_PROFILE_DIR!;
  if (!id || !stateDir) throw Error("local-profile requires STELZ_PROFILE_ID and STELZ_PROFILE_DIR");
  const file = join(stateDir, "status.json");
  let state: Record<string, unknown> = { identityId: id, instanceId: randomUUID(), mode: process.env.STELZ_MODE, phase: "starting", exitIp: null };
  const controller = new ControllerLease();
  const upstream = await import(pathToFileURL(join(process.env.STELZ_UPSTREAM!, "mcp/lib/tool-contracts.mjs")).href) as Contracts;
  const browserTools = new Set(upstream.TOOL_DEFS.filter(t => !["camofox_evaluate", "camofox_import_cookies"].includes(t.name)).map(t => t.name));
  let context: Context | undefined, probe: Probe | undefined, stopping = false;
  let probeLease: unknown, probeSession: unknown;
  let checking: Promise<void> | undefined;
  function persist(patch: Record<string, unknown>) {
    state = { ...state, ...patch };
    writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }
  persist({});
  const expected = process.env.STELZ_EXPECTED_IP || "";
  if (expected && !isIP(expected)) throw Error("Expected exit IP must be an IPv4 or IPv6 address");

  ctx.events.on("browser:launching", ({ options }) => {
    const env = options.env || {};
    const chunks = Object.entries(env).filter(([k]) => /^CAMOU_CONFIG_[1-9]\d*$/.test(k)).sort(([a], [b]) => Number(a.split("_").at(-1)) - Number(b.split("_").at(-1)));
    if (!chunks.length || chunks.some(([k], i) => k !== `CAMOU_CONFIG_${i + 1}`)) throw Error("Missing/incomplete generated fingerprint");
    const generated = JSON.parse(chunks.map(([, v]) => v).join("")) as Record<string, unknown>;
    const path = join(stateDir, "fingerprint.json");
    const binary = process.env.CAMOUFOX_EXECUTABLE!;
    const engineSha256 = createHash("sha256").update(readFileSync(binary)).digest("hex");
    type Pin = { version: number; engineSha256: string; config: Record<string, unknown>; preferences: Record<string, unknown> };
    let pin: Pin;
    if (existsSync(path)) {
      pin = JSON.parse(readFileSync(path, "utf8"));
      if (pin.version !== 1 || pin.engineSha256 !== engineSha256 || !pin.config?.["navigator.userAgent"] || !pin.preferences) throw Error("Fingerprint pin is corrupt or browser binary changed; explicit migration required");
    } else {
      if (!generated["navigator.userAgent"]) throw Error("Generated fingerprint has no user agent");
      pin = { version: 1, engineSha256, config: generated, preferences: options.firefoxUserPrefs || {} };
      writeFileSync(path, JSON.stringify(pin, null, 2), { mode: 0o600, flag: "wx" });
    }
    // Replay the complete generated device. Only upstream-derived location follows the network.
    const effective = { ...pin.config };
    for (const k of Object.keys(effective)) if (runtimeKey(k)) delete effective[k];
    for (const [k, v] of Object.entries(generated)) if (runtimeKey(k)) effective[k] = v;
    for (const [k] of chunks) delete env[k];
    const serialized = JSON.stringify(effective);
    for (let offset = 0; offset < serialized.length; offset += 32767) env[`CAMOU_CONFIG_${offset / 32767 + 1}`] = serialized.slice(offset, offset + 32767);
    options.env = env;
    options.firefoxUserPrefs = { ...pin.preferences, ...Object.fromEntries(Object.entries(options.firefoxUserPrefs || {}).filter(([k]) => k.startsWith("network."))) };
    if (options.proxy) options.proxy.bypass = "127.0.0.1,localhost";
    const machine = Object.fromEntries(Object.entries(pin.config).filter(([k]) => !runtimeKey(k)));
    persist({ phase: "starting", fingerprintSha256: hash(machine), engineSha256 });
  });
  ctx.events.on("session:creating", ({ userId, contextOptions }) => {
    if (userId !== id) throw Error("This runtime belongs to a different profile");
    if (state.phase === "blocked" || state.phase === "paused") throw Error(`Profile is ${state.phase}`);
    if (contextOptions.proxy) contextOptions.proxy.bypass = "127.0.0.1,localhost";
  });
  async function checkIP() {
    if (!context) throw Error("Original browser context is unavailable; explicit restart required");
    try {
      if (!probe) {
        probeSession = ctx.sessions.get(id);
        if (!probeSession) throw Error("Profile session is unavailable");
        const leased = await ctx.createLeasedPage(probeSession);
        probe = leased.page; probeLease = leased.lease;
        await probe.goto("https://api.ipify.org?format=json", { waitUntil: "domcontentloaded", timeout: 20000 });
      }
      // Browser-side fetch in one reserved tab avoids changing focus before every click.
      const value = await probe.evaluate(async () => {
        const response = await fetch(`https://api.ipify.org?format=json&_=${Date.now()}`, { cache: "no-store", signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw Error("IP check failed");
        return response.json() as Promise<{ ip: string }>;
      });
      if (!isIP(value.ip)) throw Error("IP check did not return an IP address");
      if (expected && value.ip !== expected) throw Error("Browser exit IP does not match configured expected IP");
      persist({ exitIp: value.ip, expectedIp: expected || null, checkedAt: new Date().toISOString(), fixedIpVerified: state.mode === "proxy" && !!expected });
    } catch (e) {
      persist({ phase: "blocked", error: "Browser exit IP check failed or mismatched; no direct fallback. Stop and explicitly restart after correcting configuration.", checkFailure: (e as Error).message.slice(0, 500) });
      throw Error(String(state.error));
    }
  }
  async function verify() {
    if (["blocked", "paused", "stopped"].includes(String(state.phase))) throw Error(`Profile is ${state.phase}`);
    if (!checking) checking = checkIP().finally(() => { checking = undefined; });
    await checking;
  }
  ctx.events.on("session:created", async ({ userId, context: created }) => {
    if (userId !== id) throw Error("Profile mismatch");
    context = created;
    try { await verify(); persist({ phase: "ready" }); }
    catch (e) { await created.close().catch(() => {}); context = undefined; throw e; }
  });
  ctx.events.on("session:destroying", async ({ userId }) => {
    if (userId === id && probe) {
      await ctx.closeLeasedPage(probeSession, probe, probeLease).catch(() => {});
      probe = undefined; probeLease = undefined; probeSession = undefined;
    }
  });
  ctx.events.on("browser:restart", () => { context = undefined; probe = undefined; persist({ phase: "blocked", error: "Browser restarted; explicit stop/start is required before continuing" }); });
  ctx.events.on("browser:closed", () => { context = undefined; probe = undefined; persist({ phase: stopping ? "stopped" : "blocked" }); });
  ctx.events.on("server:shutdown", () => { stopping = true; persist({ phase: "stopped" }); });
  app.get("/local-profile/status", ctx.auth(), (_req, res) => res.json({ ...state, controller: controller.status() }));
  app.post("/local-profile/acquire", ctx.auth(), (req, res) => {
    try {
      if (!["ready", "paused"].includes(String(state.phase))) throw Error(`Identity is ${state.phase}.`);
      const body = req.body || {};
      const lease = controller.acquire({ id: String(body.id || ""), pid: Number(body.pid), label: String(body.label || "MCP client") });
      res.json({ ...state, ...lease });
    } catch (e) { res.status(409).json({ error: (e as Error).message }); }
  });
  app.post("/local-profile/release", ctx.auth(), async (req, res) => {
    try { res.json({ ...await controller.release(String(req.body?.controllerId || "")), identityId: id }); }
    catch (e) { res.status(409).json({ error: (e as Error).message }); }
  });
  app.post("/local-profile/handoff", ctx.auth(), async (_req, res) => {
    await controller.releaseCurrent(); res.json({ released: true, identityId: id });
  });
  app.post("/local-profile/tool", ctx.auth(), async (req, res) => {
    try {
      const body = req.body || {}, name = String(body.name || "");
      if (!browserTools.has(name)) throw Error("Unknown browser tool.");
      const result = await controller.run(String(body.controllerId || ""), async () => {
        await verify();
        try {
          const { spec, payload } = await upstream.runTool(name, (body.args || {}) as Record<string, unknown>, { userId: id, sessionKey: "default" }, `http://127.0.0.1:${process.env.CAMOFOX_PORT}`, { accessKey: process.env.CAMOFOX_ACCESS_KEY, apiKey: process.env.CAMOFOX_API_KEY, cookiesDir: process.env.CAMOFOX_COOKIES_DIR });
          return { content: upstream.adaptResponse(spec, payload) };
        } catch (e) {
          if (/timed out|timeout/i.test((e as Error).message)) persist({ phase: "blocked", error: "A browser action exceeded its time limit. Stop the identity before another controller acts." });
          throw e;
        }
      });
      res.json(result);
    } catch (e) { res.status(409).json({ error: (e as Error).message }); }
  });
  app.post("/local-profile/stop", ctx.auth(), async (_req, res) => {
    persist({ phase: "stopping" });
    await controller.releaseCurrent();
    res.json({ stopping: true });
    setTimeout(() => process.kill(process.pid, "SIGTERM"), 20);
  });
  app.post("/local-profile/check", ctx.auth(), async (_req, res) => {
    try { await verify(); res.json(state); } catch (e) { res.status(409).json({ error: (e as Error).message }); }
  });
  app.post("/local-profile/pause", ctx.auth(), async (req, res) => {
    if (req.body?.controllerId && controller.status()?.id !== req.body.controllerId) return res.status(409).json({ error: "This connection does not control the identity." });
    if (state.phase !== "ready") return res.status(409).json({ error: `Cannot pause ${state.phase} profile` });
    persist({ phase: "paused" }); await controller.drain(); res.json(state);
  });
  app.post("/local-profile/resume", ctx.auth(), async (req, res) => {
    if (req.body?.controllerId && controller.status()?.id !== req.body.controllerId) return res.status(409).json({ error: "This connection does not control the identity." });
    if (state.phase !== "paused") return res.status(409).json({ error: `Cannot resume ${state.phase} profile` });
    persist({ phase: "ready" });
    try { await verify(); res.json(state); } catch (e) { res.status(409).json({ error: (e as Error).message }); }
  });
}
