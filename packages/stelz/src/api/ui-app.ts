import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { ROOT } from "../profiles/config.ts";
import { runLifecycle } from "../runtime/operations.ts";
import { createUiModel, redactUiText } from "./ui-model.ts";
import { UI_ACTIONS, type UiAction, type UiProfileCreate, type UiModel, type UiNetworkUpdate } from "./contracts.ts";
import { createWindowModel, type WindowModel } from "./window-model.ts";
import type { ShowProfileWindow } from "../api/contracts.ts";

type Asset = { body: string | Uint8Array<ArrayBuffer>; type: string };
export type UiSessionState = {
  bootstrapToken: string | null;
  session: string;
  pending: Map<string, UiAction | "save" | "delete" | "show">;
  activeMutations: number;
  ended: boolean;
};
export type UiAppOptions = {
  assetsDir?: string;
  assets?: Record<string, Asset>;
  sessionState?: UiSessionState;
  model?: UiModel;
  windows?: WindowModel;
  lifecycle?: (action: UiAction, id: string) => Promise<unknown>;
  onShutdown?: () => void;
};

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".woff2": "font/woff2", ".woff": "font/woff",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
};
const headers = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
};

export class UiHttpError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

function equalSecret(a: string, b: string) {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}

function loadAssets(root: string): Record<string, Asset> {
  if (!existsSync(join(root, "index.html"))) throw Error("UI assets are missing. Run bun run build before stelz ui.");
  const assets: Record<string, Asset> = {};
  function visit(folder: string, prefix = "") {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw Error("UI assets must not contain symbolic links.");
      const name = `${prefix}/${entry.name}`, path = join(folder, entry.name);
      if (entry.isDirectory()) visit(path, name);
      else if (entry.isFile() && contentTypes[extname(entry.name)]) {
        assets[name] = { body: readFileSync(path), type: contentTypes[extname(entry.name)]! };
      }
    }
  }
  visit(root);
  assets["/"] = assets["/index.html"]!;
  return assets;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
    throw new UiHttpError("Send application/json.", 415);
  }
  const limit = 16_384;
  if (Number(request.headers.get("content-length")) > limit) throw new UiHttpError("The request is too large.", 413);
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = request.body?.getReader();
  if (!reader) throw new UiHttpError("A JSON object is required.");
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new UiHttpError("The request is too large.", 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new UiHttpError("The request must contain valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UiHttpError("A JSON object is required.");
  return value as Record<string, unknown>;
}

export function createUiSessionState(): UiSessionState {
  return { bootstrapToken: randomBytes(32).toString("hex"), session: randomBytes(32).toString("hex"), pending: new Map(), activeMutations: 0, ended: false };
}

type UiEnvironment = { Bindings: { origin: string } };
type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 415 | 500;
const errorStatuses = new Set<number>([400, 401, 403, 404, 409, 413, 415]);
const profilePath = "/api/profiles/:id{[a-z][a-z0-9-]{0,63}}";
const notFound = (c: Context<UiEnvironment>) => c.json({ error: "Not found." }, 404);
const methodNotAllowed = (c: Context<UiEnvironment>, allow: string) => c.json({ error: "Method not allowed." }, 405, { Allow: allow });
const cookieName = (c: Context<UiEnvironment>) => "stelz_ui_" + new URL(c.env.origin).port;

function errorResponse(c: Context<UiEnvironment>, error: unknown) {
  const value = error as { status?: unknown; message?: unknown } | null;
  const status = typeof value?.status === "number" && errorStatuses.has(value.status) ? value.status as ErrorStatus : 500;
  return c.json({ error: redactUiText(typeof value?.message === "string" ? value.message : "The request failed.") }, status);
}

export function createUiApp(options: UiAppOptions = {}) {
  const model = options.model ?? createUiModel();
  const windows = options.windows ?? createWindowModel();
  const lifecycle = options.lifecycle ?? runLifecycle;
  const assets = options.assets ?? loadAssets(options.assetsDir ?? join(ROOT, "dist", "ui"));
  const state = options.sessionState ?? createUiSessionState(), pending = state.pending;
  // Keep the exact URL paths used by the asset map and profile ID validation.
  const app = new Hono<UiEnvironment>({ getPath: request => new URL(request.url).pathname });

  async function exclusive<T>(id: string, action: UiAction | "save" | "delete" | "show", run: () => Promise<T>) {
    if (pending.has(id)) throw new UiHttpError("An operation is already active for this profile. Wait for its result.", 409);
    pending.set(id, action);
    try { return await run(); }
    finally { pending.delete(id); }
  }

  app.onError((error, c) => errorResponse(c, error));
  app.use("*", async (c, next) => {
    for (const [name, value] of Object.entries(headers)) c.header(name, value);
    try {
      if (c.req.header("host") !== new URL(c.env.origin).host) throw new UiHttpError("The request host is not allowed.", 403);
      await next();
    } catch (error) { return errorResponse(c, error); }
  });
  app.use("/api/*", async (c, next) => {
    if (!c.req.path.startsWith("/api/")) return next();
    const suppliedOrigin = c.req.header("origin");
    if (suppliedOrigin && suppliedOrigin !== c.env.origin) throw new UiHttpError("The request origin is not allowed.", 403);
    if (!["GET", "HEAD"].includes(c.req.method) && suppliedOrigin !== c.env.origin)
      throw new UiHttpError("A same-origin request is required.", 403);
    if (state.ended) throw new UiHttpError("The UI session has ended. Run stelz ui to start again.", 401);
    if (c.req.path !== "/api/session") {
      const cookie = getCookie(c, cookieName(c));
      if (!cookie || cookie.length > 128 || !equalSecret(cookie, state.session))
        throw new UiHttpError("Open the launch URL printed by stelz ui.", 401);
    }
    const mutation = !["GET", "HEAD"].includes(c.req.method) && !["/api/session", "/api/shutdown"].includes(c.req.path);
    if (mutation) state.activeMutations++;
    try { await next(); }
    finally { if (mutation) state.activeMutations--; }
  });

  app.post("/api/session", async c => {
    const body = await readJson(c.req.raw);
    if (Object.keys(body).some(key => key !== "token") || typeof body.token !== "string" || body.token.length > 128 || !state.bootstrapToken || !equalSecret(body.token, state.bootstrapToken))
      throw new UiHttpError("Open the launch URL printed by stelz ui.", 401);
    state.bootstrapToken = null;
    setCookie(c, cookieName(c), state.session, { httpOnly: true, sameSite: "Strict", path: "/" });
    return c.json({ authenticated: true });
  });
  app.all("/api/session", c => methodNotAllowed(c, "POST"));

  app.post("/api/shutdown", async c => {
    const body = await readJson(c.req.raw);
    if (Object.keys(body).length) throw new UiHttpError("UI shutdown takes no arguments.");
    if (state.activeMutations || pending.size) throw new UiHttpError("Wait for the current UI operation before turning off the UI.", 409);
    state.ended = true;
    state.bootstrapToken = null;
    deleteCookie(c, cookieName(c), { httpOnly: true, sameSite: "Strict", path: "/" });
    options.onShutdown?.();
    return c.json({ stopped: true });
  });
  app.all("/api/shutdown", c => methodNotAllowed(c, "POST"));

  app.get("/api/state", async c => {
    if (c.req.method !== "GET") return notFound(c);
    const snapshot = await model.snapshot();
    return c.json({ ...snapshot, profiles: snapshot.profiles.map(profile => ({ ...profile, ...(pending.has(profile.id) ? { pendingAction: pending.get(profile.id) } : {}) })) });
  });
  app.get("/api/diagnostics", async c => c.req.method === "GET" ? c.json(await model.diagnostics()) : notFound(c));
  app.post("/api/profiles", async c => {
    const body = await readJson(c.req.raw);
    return c.json({ profile: await model.createProfile(body as UiProfileCreate) }, 201);
  });

  app.get(profilePath, async c => {
    if (c.req.method !== "GET") return methodNotAllowed(c, "GET, DELETE");
    const id = c.req.param("id"), detail = await model.detail(id);
    return c.json({ ...detail, profile: { ...detail.profile, ...(pending.has(id) ? { pendingAction: pending.get(id) } : {}) } });
  });
  app.delete(profilePath, async c => {
    const body = await readJson(c.req.raw), id = c.req.param("id");
    if (Object.keys(body).length !== 1 || typeof body.revision !== "string" || !/^[a-f\d]{64}$/.test(body.revision))
      throw new UiHttpError("Supply the current profile revision.");
    await exclusive(id, "delete", () => model.deleteProfile(id, body.revision as string));
    return c.json({ deleted: true });
  });
  app.all(profilePath, c => methodNotAllowed(c, "GET, DELETE"));

  app.post(`${profilePath}/actions`, async c => {
    const body = await readJson(c.req.raw), id = c.req.param("id");
    if (Object.keys(body).some(key => key !== "action") || !UI_ACTIONS.includes(body.action as UiAction)) throw new UiHttpError("Select a supported lifecycle action.");
    const profile = await exclusive(id, body.action as UiAction, async () => {
      const before = await model.snapshot();
      if (!before.profiles.some(profile => profile.id === id)) throw new UiHttpError("Unknown profile.", 404);
      try { await lifecycle(body.action as UiAction, id); }
      catch (error) { throw new UiHttpError(redactUiText((error as Error).message), 409); }
      return (await model.snapshot()).profiles.find(profile => profile.id === id);
    });
    return c.json({ profile });
  });
  app.all(`${profilePath}/actions`, c => methodNotAllowed(c, "POST"));
  app.put(`${profilePath}/network`, async c => {
    const body = await readJson(c.req.raw), id = c.req.param("id");
    return c.json({ profile: await exclusive(id, "save", () => model.updateNetwork(id, body as UiNetworkUpdate)) });
  });
  app.all(`${profilePath}/network`, c => methodNotAllowed(c, "PUT"));
  app.get(`${profilePath}/windows`, async c => {
    if (c.req.method !== "GET") return methodNotAllowed(c, "GET");
    const id = c.req.param("id");
    if (!(await model.snapshot()).profiles.some(profile => profile.id === id)) throw new UiHttpError("Unknown profile.", 404);
    return c.json(await windows.list(id));
  });
  app.all(`${profilePath}/windows`, c => methodNotAllowed(c, "GET"));
  app.post(`${profilePath}/window`, async c => {
    const body = await readJson(c.req.raw), id = c.req.param("id");
    if (Object.keys(body).some(key => !["instanceId", "windowId", "tabId"].includes(key)) || typeof body.instanceId !== "string"
      || (body.windowId !== undefined && (!Number.isSafeInteger(body.windowId) || (body.windowId as number) < 0))
      || (body.tabId !== undefined && (!Number.isSafeInteger(body.tabId) || (body.tabId as number) < 0))) throw new UiHttpError("Select a current browser window.");
    await exclusive(id, "show", async () => {
      const profile = (await model.snapshot()).profiles.find(profile => profile.id === id);
      if (!profile) throw new UiHttpError("Unknown profile.", 404);
      if (body.instanceId !== profile.instanceId) throw new UiHttpError("The browser restarted. Refresh the profile before selecting its window.", 409);
      try { await windows.show(id, body as ShowProfileWindow); }
      catch (error) { throw new UiHttpError(redactUiText((error as Error).message), 409); }
    });
    return c.json({ shown: true });
  });
  app.all(`${profilePath}/window`, c => methodNotAllowed(c, "POST"));

  app.all("*", c => {
    if (c.req.path.startsWith("/api/")) return notFound(c);
    if (!["GET", "HEAD"].includes(c.req.method)) return methodNotAllowed(c, "GET, HEAD");
    const asset = Object.hasOwn(assets, c.req.path) ? assets[c.req.path] : undefined;
    if (!asset) return notFound(c);
    return c.newResponse(c.req.method === "HEAD" ? null : asset.body, 200, { "Content-Type": asset.type });
  });
  return app;
}
