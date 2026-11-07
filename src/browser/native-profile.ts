import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { validateFingerprint, validateRuntimeObservation } from "./fingerprint-validation.ts";
import type { applyFingerprint } from "./fingerprint.ts";
import type { StartupWindowObservation } from "./profile-windows.ts";

type Options = Record<string, unknown>;
type Browser = object;
type NavigationRequest = { isNavigationRequest(): boolean };
export type ProfilePage = {
  url(): string;
  isClosed(): boolean;
  on(event: "close" | "framenavigated", listener: () => void): unknown;
  on(event: "request", listener: (request: NavigationRequest) => void): unknown;
  off(event: "close" | "framenavigated", listener: () => void): unknown;
  off(event: "request", listener: (request: NavigationRequest) => void): unknown;
  evaluate<T>(callback: () => T): Promise<T>;
  evaluate<T, A>(callback: (argument: A) => T, argument: A): Promise<T>;
};
export type ProfileBrowserContext = {
  browser(): Browser | null;
  close(): Promise<void>;
  on(event: "close", listener: () => void): unknown;
  on(event: "page", listener: (page: ProfilePage) => void): unknown;
  pages(): ProfilePage[];
  newPage(): Promise<ProfilePage>;
};
type Page = ProfilePage;
type Context = ProfileBrowserContext;
type Launcher = {
  launchPersistentContext(directory: string, options: Options): Promise<Context>;
};
type Storage = { directory: string };
type ProfileContext = {
  context: Context; options: Options; claimed: boolean; closed: boolean; takeInitialPage(): Page | undefined;
  initialPage(): Page | undefined;
  startupProtected: boolean; releaseStartup?: () => void;
};
const contexts = new WeakMap<Browser, ProfileContext>();

function trackInitialPage(context: Context): { take(): Page | undefined; peek(): Page | undefined } {
  const pages = context.pages();
  // Capture only the sole launch page. Never select a later user tab.
  const first = pages.length === 1 ? pages[0] : undefined;
  let initial = first && !first.isClosed() && first.url() === "about:blank" ? first : undefined;
  const navigating = (request: NavigationRequest) => { if (request.isNavigationRequest()) take(); };
  const take = () => {
    const page = initial;
    initial = undefined;
    page?.off("framenavigated", take);
    page?.off("close", take);
    page?.off("request", navigating);
    return page;
  };
  initial?.on("framenavigated", take);
  initial?.on("close", take);
  initial?.on("request", navigating);
  return { take, peek: () => initial };
}

function runtimeStorage(): Storage {
  return { directory: process.env.STELZ_PROFILE_DIR || "" };
}

export async function launchProfileBrowser(
  firefox: Launcher, options: Options, contextOptions: Options, storage = runtimeStorage(),
): Promise<Browser> {
  if (!isAbsolute(storage.directory)) throw Error("An absolute profile directory is required");
  const marker = join(storage.directory, "native-profile.json");
  const directory = join(storage.directory, "browser-data");
  if (existsSync(marker) && !existsSync(directory)) throw Error("Native browser data is missing; restore the original browser-data directory before starting this profile");
  if ("storageState" in contextOptions) throw Error("Native profiles must not restore a storage checkpoint on launch");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Context options (permissions, locale, timezone, viewport) must apply at launch,
  // not to a new incognito context after the native profile has already opened.
  const effective = { ...options, ...contextOptions };
  const context = await firefox.launchPersistentContext(directory, effective);
  try {
    const browser = context.browser();
    if (!browser) throw Error("Persistent context has no browser; refusing an ephemeral substitute");
    const initial = trackInitialPage(context);
    const record: ProfileContext = { context, options: effective, claimed: false, closed: false,
      takeInitialPage: initial.take, initialPage: initial.peek, startupProtected: false };
    context.on("close", () => { record.closed = true; record.takeInitialPage(); record.releaseStartup?.(); });
    contexts.set(browser, record);
    if (!existsSync(marker)) writeFileSync(marker, JSON.stringify({ version: 1 }), { flag: "wx", mode: 0o600 });
    return browser;
  } catch (error) { await context.close().catch(() => {}); throw error; }
}

export async function claimProfileContext(browser: Browser, options: Options): Promise<Context> {
  const record = contexts.get(browser);
  if (!record) throw Error("Original persistent context is unavailable");
  if (record.claimed || record.closed) throw Error("Persistent context was already claimed or closed; explicit restart required");
  for (const [key, value] of Object.entries(options)) {
    if (key === "storageState" || !isDeepStrictEqual(record.options[key], value)) {
      // Do not include values: a mismatching option can contain proxy credentials.
      throw Error(`Persistent context launch/session options disagree: ${key}`);
    }
  }
  record.claimed = true;
  return record.context;
}

function originalContext(context: Context): ProfileContext {
  const browser = context.browser();
  const record = browser && contexts.get(browser);
  if (!record || record.context !== context) throw Error("Original persistent context is unavailable");
  if (!record.claimed || record.closed) throw Error("Persistent context is not claimed or is closed; explicit restart required");
  return record;
}

/** Hold canonical upstream leases from session publication until its first tab is registered. */
export function protectProfileStartup<Session extends { context: Context }, Lease>(session: Session, api: {
  acquirePageLease(session: Session): Lease;
  setLeasedPage(lease: Lease, page: Page): unknown;
  releasePageLease(session: Session, lease: Lease): void;
}): () => void {
  const record = originalContext(session.context);
  if (record.startupProtected) throw Error("Profile startup was already protected; explicit restart required");
  record.startupProtected = true;
  const leases: Lease[] = [];
  const release = () => {
    for (const lease of leases.splice(0)) api.releasePageLease(session, lease);
    record.releaseStartup = undefined;
  };
  record.releaseStartup = release;
  try {
    const pages = session.context.pages();
    // An empty context still needs a lease until canonical page creation finishes.
    for (const page of pages.length ? pages : [undefined]) {
      const lease = api.acquirePageLease(session);
      leases.push(lease);
      if (page) api.setLeasedPage(lease, page);
    }
  } catch (error) { release(); throw error; }
  return release;
}

export async function createProfilePage(context: Context): Promise<Page> {
  const record = originalContext(context);
  const initial = record.takeInitialPage();
  if (initial && !initial.isClosed() && initial.url() === "about:blank" && context.pages().includes(initial)) return initial;
  return context.newPage();
}

export type StartupPageGeometry = { innerWidth: number; innerHeight: number; outerWidth: number; outerHeight: number;
  devicePixelRatio: number; visualScale: number | null; fullscreen: boolean };

// Isolated calibration observed matching page and extension dimensions with
// this engine on macOS, in a normal headed window at zoom 1 and visual scale 1.
// Privileged APIs are not spoof-proof; full supervisor startup was not tested.
const GEOMETRY_ENGINE_SHA256 = "e468f25acba5085624da4d1ac809fd5679fa281ed2b0265f82efe63904900b33";
export function validateStartupGeometry(page: StartupPageGeometry, window: StartupWindowObservation,
  engineSha256: string, platform: NodeJS.Platform, now = Date.now()) {
  if (platform !== "darwin" || engineSha256 !== GEOMETRY_ENGINE_SHA256)
    throw Error("The engine or display platform has no supported startup geometry contract; custom engines require compatibility evidence.");
  if (window.state !== "normal" || page.fullscreen !== false) throw Error("The startup window mode is unknown or unsupported.");
  if (window.zoom !== 1 || page.visualScale !== 1) throw Error("The startup window zoom or viewport scale is unsupported.");
  if (!Number.isFinite(window.sampledAt) || !Number.isFinite(window.receivedAt) || window.sampledAt > window.receivedAt ||
      now < window.receivedAt || now - window.sampledAt > 5000)
    throw Error("The startup window observation is stale.");
  for (const value of [page.innerWidth, page.innerHeight, page.outerWidth, page.outerHeight, page.devicePixelRatio])
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw Error("Startup window geometry is incomplete.");
  if (window.outerHeight <= window.viewportHeight || window.outerWidth < window.viewportWidth)
    throw Error("The normal window frame and viewport geometry are inconsistent.");
  if (page.outerWidth !== window.outerWidth || page.outerHeight !== window.outerHeight ||
      page.innerWidth !== window.viewportWidth || page.innerHeight !== window.viewportHeight)
    throw Error("The page geometry differs from the privileged window and tab observation.");
}

async function restoreStartupTitle(page: Page, token: string, previous: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const restored = await Promise.race([page.evaluate(({ token, previous }) => {
      if (location.href !== "about:blank" || document.title !== token) return false;
      document.title = previous;
      return document.title === previous;
    }, { token, previous }), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(Error("Startup page title restoration timed out.")), 2000);
    })]);
    if (!restored) throw Error("The startup page changed before its title could be restored.");
  } finally { if (timer) clearTimeout(timer); }
}

// Observe the borrowed startup page without navigating it or creating a window.
export async function verifyProfileFingerprint(context: Context, prepared: ReturnType<typeof applyFingerprint>,
  observeWindow: (token: string) => Promise<StartupWindowObservation>, platform: NodeJS.Platform = process.platform) {
  const record = originalContext(context);
  if (record.options.headless !== false || record.options.viewport !== null)
    throw Error("The browser display mode is unknown; fingerprint admission is blocked.");
  const executable = record.options.executablePath;
  if (typeof executable !== "string" || !isAbsolute(executable) ||
      createHash("sha256").update(readFileSync(executable)).digest("hex") !== prepared.engineSha256)
    throw Error("The launched browser engine does not match the fingerprint pin.");
  const page = record.initialPage();
  if (!page || page.isClosed() || page.url() !== "about:blank" || !context.pages().includes(page))
    throw Error("An owned blank startup page is unavailable; existing pages were preserved.");
  const previousTitle = await page.evaluate(() => document.title);
  if (typeof previousTitle !== "string") throw Error("The startup page title is unavailable.");
  const token = `stelz-startup:${randomUUID()}`;
  try {
    await page.evaluate((value: string) => {
      if (location.href !== "about:blank") throw Error("Startup page navigated.");
      document.title = value;
    }, token);
    const nativeWindow = await observeWindow(token);
    if (nativeWindow.instanceId !== prepared.owner.browserInstanceId) throw Error("Startup window evidence belongs to another browser instance.");
    const observed = await page.evaluate(() => {
      const gl = (kind: "webgl" | "webgl2") => {
        const canvas = document.createElement("canvas");
        const context = kind === "webgl" ? canvas.getContext("webgl") : canvas.getContext("webgl2");
        if (!context) return { available: false };
        try {
          const debug = context.getExtension("WEBGL_debug_renderer_info");
          return { available: true, vendor: debug ? context.getParameter(debug.UNMASKED_VENDOR_WEBGL) : undefined,
            renderer: debug ? context.getParameter(debug.UNMASKED_RENDERER_WEBGL) : undefined,
            version: context.getParameter(context.VERSION), extensions: context.getSupportedExtensions(),
            maxTextureSize: context.getParameter(context.MAX_TEXTURE_SIZE),
            maxRenderbufferSize: context.getParameter(context.MAX_RENDERBUFFER_SIZE),
            maxVertexAttribs: context.getParameter(context.MAX_VERTEX_ATTRIBS) };
        } finally { context.getExtension("WEBGL_lose_context")?.loseContext(); }
      };
      return { identity: {
        "navigator.userAgent": navigator.userAgent, "navigator.platform": navigator.platform,
        "navigator.oscpu": (navigator as Navigator & { oscpu?: string }).oscpu,
        "navigator.hardwareConcurrency": navigator.hardwareConcurrency,
        "navigator.deviceMemory": (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
        "screen.width": screen.width, "screen.height": screen.height, "screen.availWidth": screen.availWidth,
        "screen.availHeight": screen.availHeight, "screen.colorDepth": screen.colorDepth, "screen.pixelDepth": screen.pixelDepth,
        "window.innerWidth": window.innerWidth, "window.innerHeight": window.innerHeight,
        "window.outerWidth": window.outerWidth, "window.outerHeight": window.outerHeight,
        "window.devicePixelRatio": window.devicePixelRatio,
      }, geometry: { visualScale: window.visualViewport?.scale ?? null, fullscreen: document.fullscreenElement !== null },
        webgl: gl("webgl"), webgl2: gl("webgl2") };
    });
    if (record.closed || record.context !== context || page.isClosed() || page.url() !== "about:blank")
      throw Error("The startup page changed during fingerprint verification.");
    const identity: Record<string, unknown> = { ...observed.identity };
    for (const key of ["navigator.userAgent", "navigator.platform"])
      if (typeof identity[key] !== "string" || !identity[key]) throw Error(`Runtime identity evidence is missing: ${key}.`);
    for (const key of ["navigator.hardwareConcurrency", "screen.width", "screen.height", "screen.availWidth", "screen.availHeight",
      "screen.colorDepth", "screen.pixelDepth"]) {
      const value = identity[key];
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw Error(`Runtime geometry evidence is missing: ${key}.`);
    }
    if ((identity["screen.availWidth"] as number) > (identity["screen.width"] as number) ||
        (identity["screen.availHeight"] as number) > (identity["screen.height"] as number) ||
        identity["screen.colorDepth"] !== identity["screen.pixelDepth"]) throw Error("Runtime screen or window geometry is inconsistent.");
    validateStartupGeometry({ innerWidth: identity["window.innerWidth"] as number, innerHeight: identity["window.innerHeight"] as number,
      outerWidth: identity["window.outerWidth"] as number, outerHeight: identity["window.outerHeight"] as number,
      devicePixelRatio: identity["window.devicePixelRatio"] as number, ...observed.geometry }, nativeWindow, prepared.engineSha256, platform);
    for (const [prefix, gl] of [["webGl:", observed.webgl], ["webGl2:", observed.webgl2]] as const) {
      if (!gl.available) continue;
      for (const key of ["vendor", "renderer", "version"] as const) if (gl[key] !== undefined) identity[prefix + key] = gl[key];
      for (const key of ["maxTextureSize", "maxRenderbufferSize", "maxVertexAttribs"] as const)
        if (typeof gl[key] !== "number" || !Number.isFinite(gl[key]) || gl[key] <= 0) throw Error("WebGL capability evidence is unavailable.");
      const parameters = prepared.effective[prefix + "parameters"];
      if (parameters && typeof parameters === "object" && !Array.isArray(parameters)) {
        for (const [name, number, key] of [["MAX_TEXTURE_SIZE", "3379", "maxTextureSize"],
          ["MAX_RENDERBUFFER_SIZE", "34024", "maxRenderbufferSize"], ["MAX_VERTEX_ATTRIBS", "34921", "maxVertexAttribs"]] as const) {
          const expected = (parameters as Record<string, unknown>)[name] ?? (parameters as Record<string, unknown>)[number];
          if (expected !== undefined && !isDeepStrictEqual(expected, gl[key])) throw Error(`WebGL capability ${name} differs from the pin.`);
        }
      }
      const extensions = prepared.effective[prefix + "supportedExtensions"];
      if (Array.isArray(extensions) && (!Array.isArray(gl.extensions) ||
          !isDeepStrictEqual([...extensions].sort(), [...gl.extensions].sort()))) throw Error("WebGL extensions differ from the pin.");
    }
    const webglExpected = prepared.preferences["webgl.disabled"] !== true;
    if (observed.webgl.available !== webglExpected) throw Error("WebGL availability differs from the launch preferences.");
    const webgl2Expected = prepared.preferences["webgl.enable-webgl2"];
    if (typeof webgl2Expected === "boolean" && observed.webgl2.available !== webgl2Expected)
      throw Error("WebGL2 availability differs from the launch preferences.");
    const runtime = validateRuntimeObservation({ expectedIdentity: prepared.effective, observedIdentity: identity });
    const admission = validateFingerprint({ pin: prepared.pin, effectiveIdentity: prepared.effective,
      effectivePreferences: prepared.preferences, serialized: JSON.stringify(prepared.effective),
      serializedPreferences: JSON.parse(JSON.stringify(prepared.preferences)) },
      { expectedEngineSha256: prepared.engineSha256, admissionRequired: true, runtime });
    if (admission.admissionBlocked) throw Error(`Runtime fingerprint validation failed: ${admission.diagnostics.filter(d => d.severity === "error").map(d => d.code).join(", ")}`);
    return page;
  } finally { await restoreStartupTitle(page, token, previousTitle); }
}
