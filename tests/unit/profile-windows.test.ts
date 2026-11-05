import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { profileAppearance } from "../../src/api/contracts.ts";
import { addProfileExtension, createProfileWindows } from "../../src/browser/profile-windows.ts";
import { createUiApp, createUiSessionState } from "../../src/api/ui-server.ts";
import type { UiModel, UiSnapshot } from "../../src/api/contracts.ts";
import { profileBrowserPid } from "../../src/browser/window-activation.ts";

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
function fixture(timeoutMs = 100) {
  const directory = mkdtempSync(join(tmpdir(), "stelz-windows-")); folders.push(directory);
  let now = 10_000, phase = "ready";
  const bridge = createProfileWindows({ id: "profile-02", instanceId: "lifetime-a", directory,
    port: 9378, accessKey: "private-test-key", phase: () => phase, now: () => now, timeoutMs });
  const inventory = { instanceId: "lifetime-a", windows: [
    { id: 2, title: "[profile-02] Two", focused: false, state: "minimized", tabs: [{ id: 20, title: "Two", url: "https://two.test/", active: true }] },
    { id: 1, title: "[profile-02] One", focused: true, state: "normal", tabs: [{ id: 10, title: "One", url: "https://one.test/", active: true }] },
  ] };
  return { ...bridge, directory, inventory, advance(ms: number) { now += ms; }, phase(value: string) { phase = value; } };
}

test("profile presentation is stable, readable, and distinct for the default pair", () => {
  expect(profileAppearance("profile-02")).toEqual(profileAppearance("profile-02"));
  expect(profileAppearance("profile-02").titlePrefix).toBe("[profile-02] ");
  expect(profileAppearance("profile-02").badge).toBe("02");
  expect(profileAppearance("profile-01").color).not.toBe(profileAppearance("profile-02").color);
  expect(profileAppearance("personal-work").badge).toBe("PW");
});

test("application activation selects only the exact browser child of this profile's service", () => {
  const rows = " 201 100 /Applications/Camoufox.app/browser\n 202 101 /Applications/Camoufox.app/browser\n 203 100 /another/browser\n";
  expect(profileBrowserPid(rows, 100, "/Applications/Camoufox.app/browser")).toBe(201);
  expect(() => profileBrowserPid(rows, 102, "/Applications/Camoufox.app/browser")).toThrow("verified");
  expect(() => profileBrowserPid(rows + "204 100 /Applications/Camoufox.app/browser\n", 100, "/Applications/Camoufox.app/browser")).toThrow("verified");
});

test("runtime add-on preserves current launch configuration and never changes saved preferences", () => {
  const config = { addons: ["/existing/addon"], "canvas:seed": 42, text: "x".repeat(40_000) };
  const serialized = JSON.stringify(config);
  const options = { env: { CAMOU_CONFIG_1: serialized.slice(0, 32767), CAMOU_CONFIG_2: serialized.slice(32767), KEEP: "yes" },
    firefoxUserPrefs: { "media.peerconnection.enabled": false } };
  addProfileExtension(options, "/profile/addon"); addProfileExtension(options, "/profile/addon");
  const chunks = Object.entries(options.env).filter(([key]) => key.startsWith("CAMOU_CONFIG_")).sort(([a], [b]) => a.localeCompare(b));
  expect(JSON.parse(chunks.map(([, value]) => value).join(""))).toEqual({ ...config, addons: ["/existing/addon", "/profile/addon"] });
  expect(chunks.every(([, value]) => value.length <= 32767)).toBe(true);
  expect(options.firefoxUserPrefs).toEqual({ "media.peerconnection.enabled": false });
  expect(options.env.KEEP).toBe("yes");
  expect(() => addProfileExtension({ env: { CAMOU_CONFIG_2: "{}" } }, "/addon")).toThrow("Missing");
});

test("generated extension keeps its service key private and refuses a symlink destination", () => {
  const f = fixture();
  expect(statSync(f.extensionPath).mode & 0o777).toBe(0o700);
  expect(statSync(join(f.extensionPath, "background.js")).mode & 0o777).toBe(0o600);
  const manifest = JSON.parse(readFileSync(join(f.extensionPath, "manifest.json"), "utf8"));
  expect(manifest.permissions).toEqual(["tabs", "theme", "http://127.0.0.1/*"]);
  expect(manifest.web_accessible_resources).toBeUndefined();
  expect(readFileSync(join(f.extensionPath, "profile.html"), "utf8")).not.toContain("private-test-key");
  rmSync(f.extensionPath, { recursive: true }); symlinkSync(tmpdir(), f.extensionPath);
  expect(() => createProfileWindows({ id: "profile-02", instanceId: "other", directory: f.directory,
    port: 9378, accessKey: "key", phase: () => "ready" })).toThrow("unsafe");
});

test("window selection is delivered once, requires acknowledgement, and rejects stale or foreign pages", async () => {
  const f = fixture(); f.exchange(f.inventory);
  const selection = f.show({ instanceId: "lifetime-a", windowId: 2, tabId: 20 });
  const command = f.exchange(f.inventory).command!;
  expect(command).toMatchObject({ windowId: 2, tabId: 20 });
  expect(f.exchange(f.inventory)).toEqual({});
  await expect(f.show({ instanceId: "lifetime-a" })).rejects.toThrow("already pending");
  f.exchange({ ...f.inventory, acknowledgement: { id: command.id, error: null } });
  await selection;
  const focused = f.show({ instanceId: "lifetime-a" });
  const next = f.exchange(f.inventory).command!;
  expect(next.windowId).toBe(1);
  f.exchange({ ...f.inventory, acknowledgement: { id: next.id, error: null } }); await focused;
  await expect(f.show({ instanceId: "older", windowId: 2 })).rejects.toThrow("Refresh");
  await expect(f.show({ instanceId: "lifetime-a", windowId: 2, tabId: 10 })).rejects.toThrow("no longer available");
  expect(() => f.exchange({ ...f.inventory, instanceId: "other-profile" })).toThrow("Invalid");
});

test("stale inventory, browser loss, focus failure, and missing acknowledgements fail without replay", async () => {
  const f = fixture(15); f.exchange(f.inventory);
  f.advance(5_000); expect(f.snapshot().available).toBe(false); expect(f.snapshot().windows).toEqual([]);
  await expect(f.show({ instanceId: "lifetime-a" })).rejects.toThrow("unavailable");
  f.exchange(f.inventory); f.phase("blocked");
  await expect(f.show({ instanceId: "lifetime-a" })).rejects.toThrow("unavailable");
  f.phase("paused");
  const failed = f.show({ instanceId: "lifetime-a" });
  const command = f.exchange(f.inventory).command!;
  f.exchange({ ...f.inventory, acknowledgement: { id: command.id, error: "closed" } });
  await expect(failed).rejects.toThrow("closed");
  const timedOut = f.show({ instanceId: "lifetime-a" }); f.exchange(f.inventory);
  await expect(timedOut).rejects.toThrow("did not confirm");
  expect(f.exchange(f.inventory)).toEqual({});
  expect(() => f.exchange({ ...f.inventory, windows: [...f.inventory.windows, f.inventory.windows[0]] })).toThrow("Duplicate");
});

test("the generated background script labels every window and restores a selected minimized page", async () => {
  const f = fixture();
  const updates: unknown[] = [], settings: unknown[] = [], posts: Record<string, any>[] = [], events = new Map<string, (...args: any[]) => unknown>();
  const native = structuredClone(f.inventory.windows);
  let acceptFocus = true;
  let tick: (() => Promise<void>) | undefined;
  const browser = {
    windows: { getAll: async () => structuredClone(native), get: async (id: number) => structuredClone(native.find(window => window.id === id)),
      getLastFocused: async () => native[1], update: async (id: number, value: { focused?: boolean; state?: string }) => {
        updates.push([id, value]);
        if (value.focused && acceptFocus) for (const window of native) window.focused = window.id === id;
        if (value.state) native.find(window => window.id === id)!.state = value.state;
      },
      onCreated: { addListener: (fn: (...args: any[]) => unknown) => events.set("created", fn) },
      onFocusChanged: { addListener: (fn: (...args: any[]) => unknown) => events.set("focus", fn) } },
    tabs: { update: async (id: number, value: unknown) => { updates.push(["tab", id, value]); } },
    theme: { update: async (value: unknown) => { settings.push(value); } },
    browserAction: Object.fromEntries(["setTitle", "setBadgeText", "setBadgeBackgroundColor", "setBadgeTextColor"].map(name => [name, async (value: unknown) => { settings.push([name, value]); }])),
  };
  let command: unknown = { id: "focus-once", windowId: 2, tabId: 20 };
  runInNewContext(readFileSync(join(f.extensionPath, "background.js"), "utf8"), {
    browser, AbortSignal, TextEncoder, setTimeout: (fn: () => Promise<void>, delay: number) => {
      if (delay === 50) return setTimeout(fn, 0);
      tick = fn;
    },
    fetch: async (url: string, options: RequestInit) => {
      expect(url).toBe("http://127.0.0.1:9378/local-profile/window-bridge");
      expect(options.redirect).toBe("error");
      expect((options.headers as Record<string, string>).Authorization).toBe("Bearer private-test-key");
      posts.push(JSON.parse(String(options.body))); const current = command; command = undefined;
      return { ok: true, json: async () => ({ command: current }) };
    },
  });
  for (let n = 0; n < 30 && !tick; n++) await Bun.sleep(1);
  expect(tick).toBeDefined();
  expect(updates).toContainEqual([2, { titlePreface: "[profile-02] " }]);
  expect(updates).toContainEqual([1, { titlePreface: "[profile-02] " }]);
  expect(updates.slice(-3)).toEqual([["tab", 20, { active: true }], [2, { state: "normal" }], [2, { focused: true }]]);
  expect(settings).toContainEqual(["setBadgeText", { text: "02" }]);
  expect(settings).toContainEqual({ colors: { frame: profileAppearance("profile-02").color, frame_inactive: profileAppearance("profile-02").color, tab_background_text: "#ffffff" } });
  expect(posts[0]!.windows[0].id).toBe(1);
  await tick!(); expect(posts[1]!.acknowledgement).toEqual({ id: "focus-once", error: null });
  native.push({ id: 3, title: "New window", focused: false, state: "normal", tabs: [] });
  events.get("created")!(native[2]); await tick!();
  expect(updates).toContainEqual([3, { titlePreface: "[profile-02] " }]);
  acceptFocus = false; for (const window of native) window.focused = false;
  command = { id: "os-denied", windowId: 1 };
  await tick!(); await tick!();
  expect(posts.at(-1)!.acknowledgement.error).toContain("foreground");
  const longSecret = "sensitive-password".repeat(40), longUrl = `https://private-user:${longSecret}@example.test/`;
  native[0]!.title = "Title " + longSecret;
  native[0]!.tabs[0]!.title = "Page " + longSecret;
  native[0]!.tabs[0]!.url = longUrl;
  await tick!();
  const sent = posts.at(-1)!.windows.find((window: { id: number }) => window.id === native[0]!.id);
  expect(sent.title).toBe("Title " + longSecret);
  expect(sent.tabs[0].title).toBe("Page " + longSecret);
  expect(sent.tabs[0].url).toBe(longUrl);
  f.exchange(posts.at(-1));
  expect(f.snapshot().windows.find(window => window.id === native[0]!.id)!.tabs[0]!.url).toBe(longUrl);
  native.splice(0, native.length, ...Array.from({ length: 100 }, (_, index) => ({ id: index + 1, focused: false, state: "normal",
    title: "長いタイトル".repeat(100), tabs: [{ id: index + 1, title: "長いタイトル".repeat(100), url: "https://example.com/" + "長いパス".repeat(200), active: true }] })));
  await tick!();
  expect(new TextEncoder().encode(JSON.stringify(posts.at(-1))).length).toBeLessThanOrEqual(90_000);
  expect(posts.at(-1)!.error).toContain("shortened");
});

test("UI window routes require a same-origin session, current lifetime, and exclusive operation", async () => {
  const state = createUiSessionState();
  const snapshot = { profiles: [{ id: "profile-02", instanceId: "lifetime-a", phase: "ready" }] } as UiSnapshot;
  const model = { snapshot: async () => snapshot } as UiModel;
  const calls: unknown[] = [];
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const app = createUiApp({ model, assets: {}, sessionState: state, windows: {
    async list(id) { calls.push(["list", id]); return { profileId: id, instanceId: "lifetime-a", available: true, reason: null, updatedAt: null, windows: [] }; },
    async show(id, selection) { calls.push(["show", id, selection]); await wait; },
  } });
  const origin = "http://127.0.0.1:9380", path = "/api/profiles/profile-02/window";
  const auth = { Host: "127.0.0.1:9380", Origin: origin, "Content-Type": "application/json", Cookie: "stelz_ui_9380=" + state.session };
  const request = (url: string, method = "GET", body?: unknown, headers: Record<string, string> = auth) => app.fetch(new Request(origin + url,
    { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), { origin });
  expect((await request(path + "s", "GET", undefined, { Host: auth.Host })).status).toBe(401);
  expect((await request(path, "POST", { instanceId: "lifetime-a" }, { ...auth, Origin: "https://elsewhere.test" })).status).toBe(403);
  expect((await request(path, "POST", { instanceId: "older" })).status).toBe(409);
  expect((await request(path, "POST", { instanceId: "lifetime-a", windowId: "2" })).status).toBe(400);
  expect((await request(path, "GET")).status).toBe(405);
  expect((await request(path + "s", "HEAD")).status).toBe(405);
  expect(calls).toEqual([]);
  expect((await request(path + "s")).status).toBe(200);
  const show = request(path, "POST", { instanceId: "lifetime-a", windowId: 2 });
  for (let n = 0; n < 20 && calls.length < 2; n++) await Bun.sleep(1);
  expect((await request(path, "POST", { instanceId: "lifetime-a" })).status).toBe(409);
  release(); expect((await show).status).toBe(200);
  expect(calls).toEqual([["list", "profile-02"], ["show", "profile-02", { instanceId: "lifetime-a", windowId: 2 }]]);
});
