import { lstatSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { profileAppearance, type ProfileWindow, type ProfileWindows, type ShowProfileWindow } from "./profile-appearance.ts";
import { profileExtensionMain, type ProfileExtensionConfig } from "./profile-extension.ts";
import { profileIpProbeMain } from "./ip-probe.ts";
import type { LaunchOptions } from "./fingerprint.ts";

const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const phases = new Set(["ready", "paused", "verification_failed"]);
export type StartupWindowObservation = { instanceId: string; windowId: number; tabId: number; state: string;
  outerWidth: number; outerHeight: number; viewportWidth: number; viewportHeight: number; zoom: number; sampledAt: number; receivedAt: number };

export function prepareProfileExtension(directory: string, config: ProfileExtensionConfig) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) throw Error("The profile add-on directory is unsafe.");
  const { verifyNetwork, proxyAuth, ...windowConfig } = config;
  const files = {
    "manifest.json": JSON.stringify({ manifest_version: 2, name: "stelz · " + config.id, version: "1.0.0",
      description: "Labels and locates this profile's browser windows.",
      browser_specific_settings: { gecko: { id: "profile-windows@stelz.local" } },
      permissions: ["tabs", "theme", "http://127.0.0.1/*", ...(verifyNetwork ? ["https://api.ipify.org/*", "https://www.cloudflare.com/*",
        ...(proxyAuth ? ["webRequest", "webRequestBlocking"] : [])] : [])],
      background: { scripts: ["background.js"], persistent: true },
      browser_action: { default_title: "stelz · " + config.id, default_icon: "profile.svg", default_popup: "profile.html", default_area: "navbar" },
    }, null, 2),
    "background.js": "(" + profileExtensionMain.toString() + ")(" + JSON.stringify(windowConfig) + ");\n" + (verifyNetwork
      ? "(" + profileIpProbeMain.toString() + ")(" + JSON.stringify({ instanceId: config.instanceId, accessKey: config.accessKey,
        endpoint: config.endpoint.replace(/\/window-bridge$/, "/network-bridge"), proxyAuth }) + ");\n" : ""),
    "profile.svg": '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="' + config.color + '"/><path d="M8 10h16M8 16h12M8 22h8" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round"/></svg>',
    "profile.html": '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>stelz profile</title><style>body{font:14px system-ui;margin:18px;width:260px;color-scheme:light dark;color:CanvasText;background:Canvas}h1{font-size:17px;overflow-wrap:anywhere;margin:0 0 10px}h1:before{content:"";display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:8px;background:' + config.color + '}p{line-height:1.5;margin:0}</style><h1>' + config.id + '</h1><p>All browser windows with this color and title prefix belong to this profile.</p></html>',
  };
  for (const [name, text] of Object.entries(files)) {
    const temporary = join(directory, name + "." + randomUUID() + ".tmp");
    writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
    renameSync(temporary, join(directory, name));
  }
}

export function addProfileExtension(options: LaunchOptions, directory: string) {
  const env = options.env ?? {};
  const keys = Object.keys(env).filter(key => /^CAMOU_CONFIG_[1-9]\d*$/.test(key)).sort((a, b) => Number(a.split("_").at(-1)) - Number(b.split("_").at(-1)));
  if (!keys.length || keys.some((key, index) => key !== "CAMOU_CONFIG_" + (index + 1))) throw Error("Missing browser launch configuration.");
  const config = JSON.parse(keys.map(key => env[key]).join("")) as Record<string, unknown>;
  if (config.addons !== undefined && (!Array.isArray(config.addons) || config.addons.some(path => typeof path !== "string"))) throw Error("Invalid browser add-on configuration.");
  config.addons = [...new Set([...(config.addons as string[] | undefined ?? []), directory])];
  const serialized = JSON.stringify(config);
  for (const key of keys) delete env[key];
  for (let offset = 0; offset < serialized.length; offset += 32767) env["CAMOU_CONFIG_" + (offset / 32767 + 1)] = serialized.slice(offset, offset + 32767);
  options.env = env;
}

export function createProfileWindows(options: {
  id: string; instanceId: string; directory: string; port: number; accessKey: string;
  phase: () => string; now?: () => number; timeoutMs?: number; activate?: () => Promise<void>; verifyNetwork?: boolean;
}) {
  const { id, instanceId } = options;
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw Error("Invalid window profile.");
  const now = options.now ?? Date.now;
  const appearance = profileAppearance(id);
  const extensionPath = join(options.directory, "window-addon");
  function prepare(proxy?: LaunchOptions["proxy"]) {
    const endpoint = proxy && typeof proxy.server === "string" ? new URL(proxy.server) : undefined;
    const proxyAuth = options.verifyNetwork && endpoint && ["http:", "https:"].includes(endpoint.protocol)
      && (proxy?.username || proxy?.password) ? {
        host: endpoint.hostname.replace(/^\[|\]$/g, "").toLowerCase(), port: Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80)),
        username: String(proxy.username ?? ""), password: String(proxy.password ?? ""),
      } : undefined;
    prepareProfileExtension(extensionPath, { id, instanceId, endpoint: "http://127.0.0.1:" + options.port + "/local-profile/window-bridge",
      accessKey: options.accessKey, verifyNetwork: options.verifyNetwork, proxyAuth, ...appearance });
  }
  prepare();
  let windows: ProfileWindow[] = [], updatedAt: number | undefined, error: string | null = null;
  let startup: { token: string; startedAt: number; deadline: number; resolve(value: StartupWindowObservation): void; reject(error: Error): void } | undefined;
  let selecting = false;
  let pending: { id: string; windowId: number; tabId?: number; delivered: boolean; resolve(): void; reject(error: Error): void } | undefined;
  function observeStartup(token: string, timeoutMs = 8000): Promise<StartupWindowObservation> {
    if (options.phase() !== "starting" || startup || !/^stelz-startup:[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(token))
      throw Error("Startup window observation is unavailable.");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { startup = undefined; reject(Error("Fresh startup window evidence is unavailable.")); }, timeoutMs);
      const startedAt = now();
      startup = { token, startedAt, deadline: startedAt + timeoutMs, resolve: value => { clearTimeout(timer); startup = undefined; resolve(value); },
        reject: error => { clearTimeout(timer); startup = undefined; reject(error); } };
    });
  }
  function snapshot(): ProfileWindows {
    const running = phases.has(options.phase());
    const recent = updatedAt !== undefined && now() - updatedAt < 5_000;
    const available = recent && running && windows.length > 0;
    return { profileId: id, instanceId, available,
      reason: available ? error : !running ? "Window controls are unavailable while this browser needs attention."
        : updatedAt === undefined ? "Waiting for the browser window connection."
        : !recent ? "The browser window connection is unavailable. Refresh and try again."
        : error || "This profile has no browser windows.",
      updatedAt: updatedAt === undefined ? null : new Date(updatedAt).toISOString(), windows: available ? windows : [] };
  }
  function exchange(value: unknown) {
    if (!record(value) || value.instanceId !== instanceId || !Array.isArray(value.windows) || value.windows.length > 100) throw Error("Invalid window inventory.");
    let count = 0;
    const fresh = value.windows.map((window): ProfileWindow => {
      if (!record(window) || !integer(window.id) || !Array.isArray(window.tabs) || typeof window.focused !== "boolean" || typeof window.state !== "string"
        || typeof window.title !== "string" || window.title.length > 16_384) throw Error("Invalid browser window.");
      const tabs = window.tabs.map(tab => {
        if (++count > 100 || !record(tab) || !integer(tab.id) || typeof tab.title !== "string" || tab.title.length > 16_384
          || typeof tab.url !== "string" || tab.url.length > 16_384 || typeof tab.active !== "boolean") throw Error("Invalid browser page.");
        return { id: tab.id, title: options.phase() === "starting" && tab.title === startup?.token ? "" : tab.title,
          url: tab.url, active: tab.active };
      });
      return { id: window.id, title: options.phase() === "starting" && startup && window.title.includes(startup.token) ? "" : window.title,
        focused: window.focused, state: window.state, tabs };
    });
    if (new Set(fresh.map(window => window.id)).size !== fresh.length || new Set(fresh.flatMap(window => window.tabs.map(tab => tab.id))).size !== count) throw Error("Duplicate browser window or page.");
    const receivedAt = now();
    windows = fresh; updatedAt = receivedAt;
    if (startup) {
      const pendingStartup = startup, matches: Array<{ window: Record<string, unknown>; tab: Record<string, unknown> }> = [];
      for (const window of value.windows) if (record(window) && Array.isArray(window.tabs))
        for (const tab of window.tabs) if (record(tab) && tab.title === pendingStartup.token) matches.push({ window, tab });
      if (matches.length > 1) pendingStartup.reject(Error("Startup page association is ambiguous."));
      else if (matches.length === 1) {
        const { window, tab } = matches[0]!;
        const positive = (number: unknown): number is number => typeof number === "number" && Number.isFinite(number) && number > 0;
        if (options.phase() !== "starting" || receivedAt < pendingStartup.startedAt || receivedAt > pendingStartup.deadline ||
            typeof value.sampledAt !== "number" || !Number.isFinite(value.sampledAt) || value.sampledAt > receivedAt ||
            receivedAt - value.sampledAt > 2000 || value.sampledAt < pendingStartup.startedAt - 2000 ||
            tab.url !== "about:blank" || tab.active !== true || !integer(window.id) || !integer(tab.id) || typeof window.state !== "string" ||
            !positive(window.width) || !positive(window.height) || !positive(tab.width) || !positive(tab.height) || !positive(tab.zoom))
          pendingStartup.reject(Error("Startup window geometry evidence is incomplete or stale."));
        else pendingStartup.resolve({ instanceId, windowId: window.id, tabId: tab.id, state: window.state,
          outerWidth: window.width, outerHeight: window.height, viewportWidth: tab.width, viewportHeight: tab.height,
          zoom: tab.zoom, sampledAt: value.sampledAt, receivedAt });
      }
    }
    error = typeof value.error === "string" ? value.error.slice(0, 300) : null;
    if (record(value.acknowledgement) && pending?.delivered && value.acknowledgement.id === pending.id) {
      if (value.acknowledgement.error) pending.reject(Error(typeof value.acknowledgement.error === "string"
        ? value.acknowledgement.error.slice(0, 300) : "The browser could not show this window. Refresh the window list."));
      else pending.resolve();
      pending = undefined;
    }
    if (!pending || pending.delivered || !phases.has(options.phase())) return {};
    pending.delivered = true;
    return { command: { id: pending.id, windowId: pending.windowId, ...(pending.tabId === undefined ? {} : { tabId: pending.tabId }) } };
  }
  async function show(value: unknown) {
    if (!record(value) || Object.keys(value).some(key => !["instanceId", "windowId", "tabId"].includes(key)) || value.instanceId !== instanceId
      || (value.windowId !== undefined && !integer(value.windowId)) || (value.tabId !== undefined && !integer(value.tabId))) throw Error("Refresh the profile before selecting its window.");
    if (!snapshot().available) throw Error(snapshot().reason!);
    if (pending || selecting) throw Error("A window selection is already pending.");
    const tabId = typeof value.tabId === "number" ? value.tabId : undefined;
    const window = value.windowId === undefined ? windows.find(window => window.focused) ?? windows[0] : windows.find(window => window.id === value.windowId);
    if (!window || (value.tabId !== undefined && !window.tabs.some(tab => tab.id === value.tabId))) throw Error("This window or page is no longer available. Refresh the window list.");
    selecting = true;
    try {
      if (options.activate) await options.activate();
      if (!snapshot().available) throw Error("The browser is no longer available. Refresh the profile.");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { pending = undefined; reject(Error("The browser did not confirm the window selection. Refresh and try again.")); }, options.timeoutMs ?? 4_000);
        pending = { id: randomUUID(), windowId: window.id, ...(tabId === undefined ? {} : { tabId }), delivered: false,
          resolve: () => { clearTimeout(timer); resolve(); }, reject: error => { clearTimeout(timer); reject(error); } };
      });
    } finally { selecting = false; }
  }
  return { extensionPath, prepare, snapshot, exchange, show, observeStartup };
}
