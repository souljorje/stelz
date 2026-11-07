import type { ProfileWindow } from "./profile-appearance.ts";
import type { ProbeProxyAuth } from "./ip-probe.ts";

export type ProfileExtensionConfig = {
  id: string; instanceId: string; endpoint: string; accessKey: string;
  color: string; badge: string; titlePrefix: string;
  verifyNetwork?: boolean;
  proxyAuth?: ProbeProxyAuth;
};

// This function is serialized after TypeScript compilation. Keep its dependencies inside the function.
export function profileExtensionMain(config: ProfileExtensionConfig) {
  type Event = { addListener(callback: (...args: any[]) => unknown): void };
  type NativeTab = ProfileWindow["tabs"][number] & { width?: number; height?: number };
  type NativeWindow = Omit<ProfileWindow, "tabs"> & { type?: string; width?: number; height?: number; tabs?: NativeTab[] };
  const api = (globalThis as unknown as { browser: {
    windows: { getAll(options: object): Promise<NativeWindow[]>; get(id: number): Promise<NativeWindow>;
      update(id: number, options: object): Promise<unknown>; getLastFocused(): Promise<NativeWindow>; onCreated: Event; onFocusChanged: Event };
    tabs: { update(id: number, options: object): Promise<unknown>; getZoom(id: number): Promise<number> };
    theme: { update(options: object): Promise<unknown> };
    browserAction: { setBadgeText(options: object): Promise<void>; setBadgeBackgroundColor(options: object): Promise<void>;
      setBadgeTextColor(options: object): Promise<void>; setTitle(options: object): Promise<void> };
  } }).browser;
  const styled = new Set<number>();
  // Preserve whole values for service-side redaction. Truncating first can split a secret.
  const text = (value: unknown) => { const valueText = String(value ?? ""); return valueText.length <= 16_384 ? valueText : ""; };
  const failedTitles = new Set<number>();
  let configurationError: string | null = null;
  let lastFocused: number | undefined;
  api.windows.onFocusChanged.addListener((id: number) => { if (id >= 0) lastFocused = id; });
  void api.windows.getLastFocused().then(window => { lastFocused ??= window.id; }).catch(() => {});
  async function styleWindow(window: NativeWindow) {
    if (!Number.isInteger(window.id) || styled.has(window.id)) return;
    try {
      await api.windows.update(window.id, { titlePreface: config.titlePrefix });
      styled.add(window.id);
      failedTitles.delete(window.id);
    } catch { failedTitles.add(window.id); }
  }
  async function focus(command: { windowId: number; tabId?: number }) {
    const window = await api.windows.get(command.windowId);
    if (command.tabId !== undefined) {
      // Query the current window again with tabs before accepting a stale page selection.
      const current = (await api.windows.getAll({ populate: true, windowTypes: ["normal", "popup"] }))
        .find(item => item.id === command.windowId);
      if (!current?.tabs?.some(tab => tab.id === command.tabId)) throw Error("The page is no longer in this window.");
      await api.tabs.update(command.tabId, { active: true });
    }
    if (window.state === "minimized") await api.windows.update(command.windowId, { state: "normal" });
    await api.windows.update(command.windowId, { focused: true });
    for (let attempt = 0; attempt < 20; attempt++) {
      if ((await api.windows.get(command.windowId)).focused) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error("foreground");
  }
  async function configure() {
    await api.browserAction.setTitle({ title: "stelz · " + config.id });
    await api.browserAction.setBadgeText({ text: config.badge });
    await api.browserAction.setBadgeBackgroundColor({ color: config.color });
    await api.browserAction.setBadgeTextColor({ color: "#ffffff" });
    await api.theme.update({ colors: { frame: config.color, frame_inactive: config.color, tab_background_text: "#ffffff" } });
  }
  api.windows.onCreated.addListener((window: NativeWindow) => { void styleWindow(window); });
  let acknowledgement: { id: string; error: string | null } | undefined;
  async function tick() {
    try {
      const sampledAt = Date.now();
      let native = await api.windows.getAll({ populate: true, windowTypes: ["normal", "popup"] });
      const live = new Set(native.map(window => window.id));
      for (const id of styled) if (!live.has(id)) styled.delete(id);
      for (const id of failedTitles) if (!live.has(id)) failedTitles.delete(id);
      native.sort((a, b) => Number(b.id === lastFocused) - Number(a.id === lastFocused));
      await Promise.all(native.map(styleWindow));
      // Only the temporary startup title requests privileged zoom evidence.
      const zooms = new Map<number, number>();
      await Promise.all(native.flatMap(window => window.tabs ?? []).filter(tab =>
        typeof tab.title === "string" && tab.title.startsWith("stelz-startup:")).map(async tab => {
        try { zooms.set(tab.id, await api.tabs.getZoom(tab.id)); } catch { /* Missing zoom blocks startup admission. */ }
      }));
      if (zooms.size) {
        const confirmed = await api.windows.getAll({ populate: true, windowTypes: ["normal", "popup"] });
        const signature = (list: NativeWindow[], id: number) => {
          for (const window of list) for (const tab of window.tabs ?? []) if (tab.id === id)
            return JSON.stringify([window.id, window.state, window.width, window.height, tab.id, tab.title, tab.url, tab.active, tab.width, tab.height]);
        };
        await Promise.all([...zooms].map(async ([id, zoom]) => {
          try {
            const before = signature(native, id), after = signature(confirmed, id);
            if (!before || before !== after || await api.tabs.getZoom(id) !== zoom) zooms.delete(id);
          } catch { zooms.delete(id); }
        }));
        native = confirmed;
        native.sort((a, b) => Number(b.id === lastFocused) - Number(a.id === lastFocused));
      }
      let count = 0;
      const windows = native.slice(0, 100).map(window => ({
        id: window.id, title: text(window.title), focused: !!window.focused, state: window.state, width: window.width, height: window.height,
        tabs: (window.tabs ?? []).slice(0, Math.max(0, 100 - count)).map(tab => {
          count++;
          return { id: tab.id, title: text(tab.title), url: text(tab.url), active: !!tab.active,
            width: tab.width, height: tab.height, zoom: zooms.get(tab.id) };
        }),
      }));
      const payload = { instanceId: config.instanceId, sampledAt, windows, error: configurationError
        ?? (failedTitles.size ? "A browser window could not receive its profile title." : null), acknowledgement };
      let body = JSON.stringify(payload);
      while (new TextEncoder().encode(body).length > 90_000 && windows.length) {
        windows.pop();
        payload.error = "The window list is shortened because its contents exceed the service limit.";
        body = JSON.stringify(payload);
      }
      const response = await fetch(config.endpoint, { method: "POST", credentials: "omit", redirect: "error",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + config.accessKey },
        body,
        signal: AbortSignal.timeout(3_000) });
      if (!response.ok) throw Error("Window bridge is unavailable.");
      acknowledgement = undefined;
      const result = await response.json() as { command?: { id: string; windowId: number; tabId?: number } };
      if (result.command) {
        try { await focus(result.command); acknowledgement = { id: result.command.id, error: null }; }
        catch (error) { acknowledgement = { id: result.command.id, error: (error as Error).message === "foreground"
          ? "The desktop kept another application in the foreground. Select this profile's browser manually, then try Show window again."
          : "This window or page is no longer available. Refresh the window list." }; }
      }
    } catch { /* A stopped service must not affect the browser or website content. */ }
    // Publish the focus result before unrelated desktop input can change focus.
    setTimeout(tick, acknowledgement ? 0 : 750);
  }
  void configure().catch(() => { configurationError = "The browser could not apply all profile colors or badge settings."; });
  void tick();
}
