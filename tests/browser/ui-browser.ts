// UI acceptance uses the real HTTP/model boundary and deterministic lifecycle fixtures.
// Real browser-service acceptance remains test:integration and test:package.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import type { UiAction } from "../../packages/stelz/src/api/contracts.ts";

const root = resolve(import.meta.dir, "../.."), home = mkdtempSync(join(tmpdir(), "stelz-ui-browser-"));
process.env.STELZ_HOME = home;
const { processStart } = await import("../../packages/stelz/src/runtime/runtime.ts");
const { createUiServer } = await import("../../packages/stelz/src/api/ui-server.ts");
const reports = join(root, ".state/ui-browser");
mkdirSync(reports, { recursive: true });
const commands: string[] = [];
const windowSelections: { id: string; windowId?: number; tabId?: number }[] = [];
const unavailableWindows = new Set<string>();
const inventoryReads = new Map<string, number>();
const states = new Map<string, Record<string, unknown>>();
const services: ReturnType<typeof Bun.serve>[] = [];
const profiles: { id: string; port: number; mode: "proxy" | "direct"; storage: "native"; proxyEnv?: string; expectedIPEnv?: string }[] = [];
const born = processStart(process.pid)!;
const digest = createHash("sha256").update("ui-browser-fixture").digest("hex");

function writeState(id: string, state: Record<string, unknown>) {
  const folder = join(home, "profiles", id);
  writeFileSync(join(folder, "status.json"), JSON.stringify(state), { mode: 0o600 });
  const running = join(folder, "running.json");
  if (state.phase === "stopped") rmSync(running, { force: true });
  else writeFileSync(running, JSON.stringify({
    version: 2, pid: process.pid, serverPid: process.pid, supervisorStart: born, serverStart: born,
    serverState: "started", instanceId: state.instanceId, configurationHash: "fixture", port: profiles.find(p => p.id === id)!.port,
  }), { mode: 0o600 });
}

for (const [index, id] of ["profile-01", "profile-02"].entries()) {
  const folder = join(home, "profiles", id), key = randomUUID();
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const service = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.headers.get("authorization") !== `Bearer ${key}`) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (new URL(request.url).pathname === "/local-profile/status") return Response.json({ ...states.get(id),
      windowControls: { available: !unavailableWindows.has(id), reason: unavailableWindows.has(id) ? "The browser window connection is unavailable." : null } });
    if (new URL(request.url).pathname === "/local-profile/windows") {
      inventoryReads.set(id, (inventoryReads.get(id) ?? 0) + 1);
      if (unavailableWindows.has(id)) return Response.json({ profileId: id, instanceId: states.get(id)!.instanceId,
        available: false, reason: "The browser window connection is unavailable.", updatedAt: null, windows: [] });
      return Response.json({
      profileId: id, instanceId: states.get(id)!.instanceId, available: true, reason: null, updatedAt: new Date().toISOString(),
      windows: [{ id: 1, title: `[${id}] Example page`, focused: true, state: "normal", tabs: [
        { id: 10, title: "Example page", url: "https://example.com/", active: true },
      ] }, { id: 2, title: `[${id}] A page with a long title to check truncation and responsive layout`, focused: false, state: "minimized", tabs: [
        { id: 20, title: "A page with a long title to check truncation and responsive layout", url: "https://example.org/" + "long-page-address/".repeat(18), active: true },
      ] }],
      });
    }
    if (new URL(request.url).pathname === "/local-profile/window-show") {
      const selection = await request.json() as { instanceId: string; windowId?: number; tabId?: number };
      if (selection.instanceId !== states.get(id)!.instanceId) return Response.json({ error: "Stale window selection." }, { status: 409 });
      windowSelections.push({ id, windowId: selection.windowId, tabId: selection.tabId });
      return Response.json({ shown: true });
    }
    return Response.json({ error: "This fixture only serves observations." }, { status: 404 });
  } });
  services.push(service);
  profiles.push({ id, port: service.port!, mode: index === 0 ? "proxy" : "direct", storage: "native", ...(index === 0 ? { proxyEnv: "UI_FIXTURE_PROXY_URL", expectedIPEnv: "UI_FIXTURE_EXPECTED_IP" } : {}) });
  const state: Record<string, unknown> = { profileId: id, instanceId: randomUUID(), phase: index === 0 ? "ready" : "stopped", mode: profiles[index]!.mode,
    exitIp: index === 0 ? "203.0.113.8" : null, expectedIp: index === 0 ? "203.0.113.8" : null,
    checkedAt: index === 0 ? new Date().toISOString() : null, fixedIpVerified: index === 0,
    fingerprintSha256: digest, engineSha256: digest,
    controller: index === 0 ? { id: randomUUID(), pid: process.pid, label: "MCP client", activeActions: 0, releasing: false } : null };
  states.set(id, state);
  writeFileSync(join(folder, "access-key"), key, { mode: 0o600 });
  writeFileSync(join(folder, "fingerprint.json"), JSON.stringify({ version: 2, engineSha256: digest, config: {
    "navigator.platform": "MacIntel", "navigator.oscpu": "Intel Mac OS X 10.15", "navigator.hardwareConcurrency": 8,
    "screen.width": 1440, "screen.height": 900, "screen.colorDepth": 24,
    "webGl:vendor": "Apple", "webGl:renderer": "Apple M2",
  } }), { mode: 0o600 });
  writeFileSync(join(folder, "server.log"), "Browser service ready.\nProxy http://fixture-user:fixture-password@proxy.example:8080\n", { mode: 0o600 });
  writeFileSync(join(folder, "supervisor.log"), "Supervisor ready.\n", { mode: 0o600 });
  writeState(id, state);
}
writeFileSync(join(home, "profiles.json"), JSON.stringify({ profiles: profiles }), { mode: 0o600 });
writeFileSync(join(home, "secrets.env"), "UI_FIXTURE_PROXY_URL=http://fixture-user:fixture-password@proxy.example:8080\nUI_FIXTURE_EXPECTED_IP=203.0.113.8\n", { mode: 0o600 });
mkdirSync(join(home, "runtime"), { mode: 0o700 });
writeFileSync(join(home, "runtime/versions.json"), "{}", { mode: 0o600 });

const ui = createUiServer({ port: 0, async lifecycle(action: UiAction, id: string) {
  commands.push(`${action}:${id}`);
  const state = states.get(id)!;
  if (action === "start") state.phase = "ready";
  else if (action === "stop") { state.phase = "stopped"; state.controller = null; }
  else if (action === "pause") state.phase = "paused";
  else if (action === "resume") state.phase = "ready";
  else if (action === "release") state.controller = null;
  else { state.exitIp = "203.0.113.8"; state.checkedAt = new Date().toISOString(); state.fixedIpVerified = true; }
  writeState(id, state);
} });

function close() {
  ui.stop();
  for (const service of services) service.stop(true);
  rmSync(home, { recursive: true, force: true });
}

if (process.argv.includes("--serve")) {
  console.log(ui.launchUrl);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { close(); process.exit(0); });
} else {
  const executablePath = process.env.STELZ_UI_CHROME || (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : Bun.which("google-chrome") || Bun.which("chromium") || undefined);
  const browser = await chromium.launch({ executablePath, headless: true }).catch(error => { close(); throw error; });
  const browserContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  await browserContext.addInitScript(() => {
    const record = () => {
      if (!document.body) { requestAnimationFrame(record); return; }
      (window as unknown as { firstUiTheme?: string }).firstUiTheme = document.documentElement.dataset.theme;
    };
    requestAnimationFrame(record);
  });
  const page = await browserContext.newPage();
  const errors: string[] = [], external: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error" && !message.text().includes("401")) errors.push(message.text()); });
  await page.route("**/*", route => {
    if (route.request().url().startsWith(`${ui.url}/`)) return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  const expectTheme = async (theme: "light" | "dark") => {
    await page.waitForFunction(value => document.documentElement.dataset.theme === value && getComputedStyle(document.documentElement).colorScheme === value, theme);
  };
  const systemScheme = async (theme: "light" | "dark") => {
    await page.emulateMedia({ colorScheme: theme });
    await expectTheme(theme);
  };
  const captureScreen = async (name: string) => {
    for (const theme of ["light", "dark"] as const) {
      await systemScheme(theme);
      for (const [width, height, size] of [[1440, 900, "desktop"], [390, 844, "mobile"]] as const) {
        await page.setViewportSize({ width, height });
        await page.evaluate(() => scrollTo(0, 0));
        await page.screenshot({ path: join(reports, `${name}-${size}${theme === "dark" ? "-dark" : ""}.png`), fullPage: true });
        if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error(`The ${name} ${size} ${theme} view scrolls sideways.`);
      }
    }
    await systemScheme("light");
    await page.setViewportSize({ width: 1440, height: 900 });
  };
  try {
    await page.goto(ui.launchUrl);
    await page.getByRole("heading", { name: "Profiles", exact: true }).waitFor();
    await page.getByText("profile-02", { exact: true }).first().waitFor();
    await expectTheme("dark");
    if (await page.evaluate(() => (window as unknown as { firstUiTheme?: string }).firstUiTheme) !== "dark") throw Error("The system theme was not applied before the first page frame.");
    if (new URL(page.url()).hash) throw Error("The launch token remains in the browser URL.");
    if (commands.length) throw Error("Observing the UI dispatched a lifecycle action.");
    const cookie = (await page.context().cookies()).find(cookie => cookie.name.startsWith("stelz_ui_"));
    if (!cookie?.httpOnly || cookie.sameSite !== "Strict") throw Error("The browser session cookie is not HttpOnly and strict.");
    for (const theme of ["light", "dark"] as const) {
      await systemScheme(theme);
      for (const [width, height, name] of [[1440, 900, "desktop"], [768, 1024, "tablet"], [390, 844, "mobile"]] as const) {
      await page.setViewportSize({ width, height });
      if (name === "desktop") await page.locator(".profile-row").first().hover();
      await page.screenshot({ path: join(reports, `${name}${theme === "dark" ? "-dark" : ""}.png`), fullPage: true });
      await page.mouse.move(0, 0);
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error(`The ${name} UI scrolls sideways.`);
      const overlap = await page.evaluate(() => [...document.querySelectorAll("tr")].some(row => {
        const boxes = [...row.querySelectorAll("button")].map(button => button.getBoundingClientRect()).filter(box => box.width && box.height);
        return boxes.some((box, index) => boxes.slice(index + 1).some(other => Math.min(box.right, other.right) - Math.max(box.left, other.left) > 1 && Math.min(box.bottom, other.bottom) - Math.max(box.top, other.top) > 1));
      }));
      if (overlap) throw Error(`The ${name} table controls overlap.`);
      const controls = page.getByRole("row").filter({ has: page.getByRole("button", { name: "Inspect profile-01", exact: true }) });
      const show = await controls.getByRole("button", { name: "Show window for profile-01", exact: true }).boundingBox();
      const stop = await controls.getByRole("button", { name: "Stop profile-01", exact: true }).boundingBox();
      if (!show || !stop || Math.abs(show.y - stop.y) > 1) throw Error(`The ${name} profile actions are not on the same line.`);
      }
    }
    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    const navigation = page.getByRole("dialog", { name: "stelz · Local service", exact: true });
    await navigation.getByRole("button", { name: "Settings", exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
    if (await navigation.isVisible()) throw Error("Mobile navigation did not close after a keyboard selection.");
    if (await page.getByLabel("Theme", { exact: true }).inputValue() !== "system") throw Error("Theme preference does not default to System.");
    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    await navigation.getByRole("button", { name: "Profiles", exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 900 });
    const configFile = join(home, "profiles.json"), initialConfig = readFileSync(configFile, "utf8");
    const broken = JSON.parse(initialConfig);
    Object.assign(broken.profiles[1], { mode: "proxy", proxyEnv: "UI_FIXTURE_UNSET_PROXY" });
    writeFileSync(configFile, JSON.stringify(broken), { mode: 0o600 });
    await page.getByRole("button", { name: "Refresh service state", exact: true }).click();
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('button[aria-label="Start profile-02"]')?.disabled === true);
    await captureScreen("blocked-start");
    await page.getByRole("button", { name: "Start profile-02", exact: true }).locator("svg").click({ force: true });
    if (!await page.getByRole("heading", { name: "Profiles", exact: true }).isVisible() || commands.length) throw Error("Clicking a disabled row action navigated or dispatched a command.");
    await page.getByRole("row").filter({ has: page.getByRole("button", { name: "Inspect profile-02", exact: true }) }).locator(".profile-connection").click();
    await page.getByRole("heading", { name: "profile-02", exact: true }).waitFor();
    if (!await page.getByRole("button", { name: "Start profile-02", exact: true }).isDisabled()) throw Error("A blocked detail Start is not visible and disabled.");
    writeFileSync(configFile, initialConfig, { mode: 0o600 });
    await page.getByRole("button", { name: "All profiles", exact: true }).click();
    await page.getByRole("button", { name: "Refresh service state", exact: true }).click();
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('button[aria-label="Start profile-02"]')?.disabled === false);
    await page.getByRole("button", { name: "Stop profile-01", exact: true }).click();
    await page.getByRole("dialog", { name: "Stop profile-01?", exact: true }).waitFor();
    if (!await page.getByRole("heading", { name: "Profiles", exact: true }).isVisible()) throw Error("A row lifecycle action opened profile details.");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    if (commands.length) throw Error("Row navigation dispatched a lifecycle action.");
    await page.getByRole("button", { name: "Inspect profile-02", exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("heading", { name: "profile-02", exact: true }).waitFor();
    const stoppedActions = await page.getByRole("group", { name: "Browser lifecycle actions", exact: true }).getByRole("button").allTextContents();
    if (stoppedActions.join(",") !== "Start") throw Error("A stopped profile shows unavailable lifecycle actions.");
    const technical = page.locator("details").filter({ has: page.getByText("Technical details", { exact: true }) });
    await technical.locator("summary").click();
    await technical.getByText(`127.0.0.1:${profiles[1]!.port}`, { exact: true }).waitFor();
    await technical.locator("summary").click();
    const mcp = page.locator("details").filter({ has: page.getByText("Connect via MCP", { exact: true }) });
    await mcp.locator("summary").click();
    if (!(await mcp.getByLabel("Command", { exact: true }).innerText()).includes(home)) throw Error("The disclosed MCP command does not select this service home.");
    await mcp.locator("summary").click();
    await captureScreen("overview");
    await page.getByRole("tab", { name: "Network", exact: true }).click();
    await captureScreen("network");
    await page.getByLabel("Connection mode", { exact: true }).selectOption("proxy");
    await page.getByLabel(/^Proxy URL/).fill("http://new-user:new-password@proxy.example:8081");
    await page.locator(".network-form summary").click();
    await page.getByLabel(/^Expected exit IP/).fill("198.51.100.10");
    // A background observation must not overwrite an operator's unsaved form.
    await page.waitForTimeout(2300);
    if (await page.getByLabel(/^Proxy URL/).inputValue() !== "http://new-user:new-password@proxy.example:8081") throw Error("A status refresh discarded unsaved proxy edits.");
    await page.getByRole("button", { name: "Save network", exact: true }).click();
    await page.getByText("Network settings saved.", { exact: true }).waitFor();
    if (await page.getByLabel(/^Proxy URL/).inputValue()) throw Error("The saved proxy credential remains in the form.");
    if ((await page.locator("body").innerText()).includes("new-password")) throw Error("The UI displays a proxy password.");
    await page.getByRole("tab", { name: "Overview", exact: true }).click();
    await page.getByRole("button", { name: "Start profile-02", exact: true }).click();
    await page.getByRole("button", { name: "Pause profile-02", exact: true }).waitFor({ state: "visible" });
    if (await page.getByRole("button", { name: "Start profile-02", exact: true }).count() || await page.getByRole("button", { name: "Resume profile-02", exact: true }).count()) throw Error("A running profile offers start or resume.");
    await page.waitForFunction(() => !(document.querySelector('button[aria-label="Pause profile-02"]') as HTMLButtonElement | null)?.disabled);
    await page.getByRole("button", { name: "Pause profile-02", exact: true }).click();
    await page.waitForFunction(() => !(document.querySelector('button[aria-label="Resume profile-02"]') as HTMLButtonElement | null)?.disabled);
    // Pausing never causes an automatic resume, including after a status refresh.
    await page.waitForTimeout(2300);
    if (commands.some(command => command === "resume:profile-02")) throw Error("The UI resumed without an operator action.");
    await page.getByRole("button", { name: "Resume profile-02", exact: true }).click();
    await page.waitForFunction(() => !(document.querySelector('button[aria-label="Stop profile-02"]') as HTMLButtonElement | null)?.disabled);
    await page.getByRole("button", { name: "Stop profile-02", exact: true }).click();
    await page.getByRole("dialog", { name: "Stop profile-02?", exact: true }).waitFor();
    if (commands.includes("stop:profile-02")) throw Error("Opening the stop confirmation stopped the browser.");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "Stop profile-02", exact: true }).click();
    await page.getByRole("button", { name: "Stop profile", exact: true }).click();
    await page.waitForFunction(() => !(document.querySelector('button[aria-label="Start profile-02"]') as HTMLButtonElement | null)?.disabled);
    await page.getByRole("tab", { name: "Device", exact: true }).click();
    await page.getByText("Apple M2", { exact: true }).waitFor();
    await page.getByRole("tab", { name: "Logs", exact: true }).click();
    await page.getByText("Browser service ready.", { exact: false }).waitFor();
    if ((await page.getByLabel("server log", { exact: true }).innerText()).includes("fixture-password")) throw Error("The UI log exposes proxy credentials.");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    if (!(await page.getByLabel("Command").first().innerText()).includes(home)) throw Error("The MCP command does not select this service home.");
    await page.getByLabel("Theme", { exact: true }).selectOption("light");
    await page.emulateMedia({ colorScheme: "dark" });
    await expectTheme("light");
    await page.getByLabel("Theme", { exact: true }).selectOption("dark");
    await page.emulateMedia({ colorScheme: "light" });
    await expectTheme("dark");
    await page.reload();
    await page.getByRole("heading", { name: "Profiles", exact: true }).waitFor();
    await expectTheme("dark");
    if (await page.evaluate(() => (window as unknown as { firstUiTheme?: string }).firstUiTheme) !== "dark") throw Error("The stored override flashed the system theme on reload.");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    if (await page.getByLabel("Theme", { exact: true }).inputValue() !== "dark") throw Error("The theme override was not persisted.");
    const otherTab = await browserContext.newPage();
    await otherTab.goto(ui.url);
    await otherTab.getByRole("heading", { name: "Profiles", exact: true }).waitFor();
    await page.getByLabel("Theme", { exact: true }).selectOption("light");
    await otherTab.waitForFunction(() => document.documentElement.dataset.theme === "light");
    await page.getByLabel("Theme", { exact: true }).selectOption("system");
    await expectTheme("light");
    await otherTab.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    await otherTab.close();
    await captureScreen("settings");
    await page.getByRole("button", { name: "Diagnostics", exact: true }).click();
    await page.getByRole("heading", { name: "Installation", exact: true }).waitFor();
    await captureScreen("diagnostics");
    await page.getByRole("button", { name: "Profiles", exact: true }).click();
    unavailableWindows.add("profile-01");
    await page.getByRole("button", { name: "Refresh service state", exact: true }).click();
    const unavailableShow = page.getByRole("button", { name: "Show window for profile-01", exact: true });
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('button[aria-label="Show window for profile-01"]')?.disabled === true);
    const beforeUnavailable = windowSelections.length;
    await unavailableShow.locator("svg").click({ force: true });
    if (windowSelections.length !== beforeUnavailable || !await page.getByRole("heading", { name: "Profiles", exact: true }).isVisible()) throw Error("An unavailable window control dispatched a selection or opened the profile.");
    unavailableWindows.delete("profile-01");
    await page.getByRole("button", { name: "Refresh service state", exact: true }).click();
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('button[aria-label="Show window for profile-01"]')?.disabled === false);
    await page.getByRole("button", { name: "Inspect profile-01", exact: true }).click();
    const browserWindows = page.getByRole("region", { name: "Browser windows", exact: true });
    await browserWindows.getByRole("button", { name: "Show Example page in profile-01", exact: true }).waitFor();
    await captureScreen("browser-windows");
    const controllerBeforeShow = JSON.stringify(states.get("profile-01")!.controller), commandsBeforeShow = commands.length;
    await browserWindows.getByRole("button", { name: "Show Example page in profile-01", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('button[aria-label="Show Example page in profile-01"]')?.hasAttribute("disabled"));
    if (!windowSelections.some(selection => selection.id === "profile-01" && selection.windowId === 1 && selection.tabId === 10)) throw Error("Selecting a page did not show its native window.");
    if (commands.length !== commandsBeforeShow || JSON.stringify(states.get("profile-01")!.controller) !== controllerBeforeShow) throw Error("Showing a window changed lifecycle or controller state.");
    await page.getByRole("tab", { name: "Device", exact: true }).click();
    await page.waitForTimeout(200);
    const readsWhileHidden = inventoryReads.get("profile-01") ?? 0;
    await page.waitForTimeout(5_200);
    if ((inventoryReads.get("profile-01") ?? 0) !== readsWhileHidden) throw Error("A hidden window list continues polling.");
    await page.getByRole("tab", { name: "Overview", exact: true }).click();
    await browserWindows.getByRole("button", { name: "Show Example page in profile-01", exact: true }).waitFor();
    if (await page.getByRole("button", { name: "Delete profile", exact: true }).isVisible()) throw Error("A running profile offers deletion in the UI.");
    await page.getByRole("button", { name: "Release profile-01", exact: true }).click();
    await page.getByRole("dialog", { name: "Release controller from profile-01?", exact: true }).waitFor();
    await page.getByRole("button", { name: "Release controller", exact: true }).click();
    await page.getByRole("dialog", { name: "Release controller from profile-01?", exact: true }).waitFor({ state: "hidden" });
    if (states.get("profile-01")!.phase !== "ready" || states.get("profile-01")!.controller !== null) throw Error("Controller release did not preserve the running profile.");
    await page.getByRole("button", { name: "All profiles", exact: true }).click();
    for (const [id, proxy] of [["work-direct", ""], ["work-proxy", "http://created-user:created-password@created.example:8080"], [`profile-${"w".repeat(56)}`, ""]]) {
      const beforeCreate = commands.length;
      await page.getByRole("button", { name: "New profile", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Create profile", exact: true });
      await dialog.getByLabel("Profile name", { exact: true }).fill(id!);
      if (proxy) await dialog.getByLabel(/^Proxy URL/).fill(proxy);
      if (!proxy) {
        await page.screenshot({ path: join(reports, "create-desktop.png"), fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: join(reports, "create-mobile.png"), fullPage: true });
        if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error("The create dialog scrolls sideways.");
        await page.setViewportSize({ width: 1440, height: 900 });
      }
      await dialog.getByRole("button", { name: "Create profile", exact: true }).click();
      await page.getByRole("heading", { name: id, exact: true }).waitFor();
      const created = JSON.parse(readFileSync(join(home, "profiles.json"), "utf8")).profiles.find((p: { id: string }) => p.id === id);
      if (created?.mode !== (proxy ? "proxy" : "direct") || created?.storage !== "native") throw Error("Creation did not preserve the selected optional proxy.");
      if (commands.length !== beforeCreate) throw Error("Creating a profile started a browser.");
      if ((await page.locator("body").innerText()).includes("created-password")) throw Error("Creation echoed proxy credentials.");
      await page.getByRole("button", { name: "Delete profile", exact: true }).click();
      const deletion = page.getByRole("dialog", { name: `Delete ${id}?`, exact: true });
      if (id!.length === 64) await captureScreen("delete-long-id");
      const confirm = deletion.getByRole("button", { name: "Delete profile", exact: true });
      await deletion.getByRole("textbox").fill("wrong-name");
      if (await confirm.isEnabled()) throw Error("Deletion does not require the exact profile name.");
      await deletion.getByRole("textbox").fill(id!);
      await confirm.click();
      await page.getByRole("heading", { name: "Profiles", exact: true }).waitFor();
      if (JSON.parse(readFileSync(join(home, "profiles.json"), "utf8")).profiles.some((p: { id: string }) => p.id === id)) throw Error("Deleted profile remains in the catalog.");
      if (!readdirSync(join(home, "trash")).some(name => name.startsWith(`${id}-`))) throw Error("Deletion did not archive the profile.");
    }
    const beforeClose = commands.slice();
    const context = page.context();
    await page.close();
    if (JSON.stringify(commands) !== JSON.stringify(beforeClose)) throw Error("Closing the UI dispatched an action.");
    const offPage = await context.newPage();
    offPage.on("pageerror", error => errors.push(error.message));
    let apiRequests = 0;
    offPage.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/")) apiRequests++; });
    await offPage.goto(ui.url);
    await offPage.getByRole("button", { name: "Inspect profile-02", exact: true }).click();
    await offPage.getByRole("tab", { name: "Network", exact: true }).click();
    await offPage.getByLabel(/^Expected exit IP/).fill("198.51.100.11");
    await offPage.getByRole("button", { name: "Discard edits", exact: true }).waitFor();
    await offPage.getByRole("button", { name: "Turn off UI", exact: true }).click();
    const unsaved = offPage.getByRole("dialog", { name: "Discard edits and turn off UI?", exact: true });
    await unsaved.waitFor();
    await unsaved.getByRole("button", { name: "Keep editing", exact: true }).click();
    if (!(await fetch(ui.url)).ok) throw Error("Cancelling UI shutdown stopped the listener.");
    await offPage.getByRole("button", { name: "Discard edits", exact: true }).click();
    await offPage.getByRole("button", { name: "Turn off UI", exact: true }).click();
    await offPage.getByRole("heading", { name: "UI turned off", exact: true }).waitFor();
    await offPage.screenshot({ path: join(reports, "turned-off-desktop.png"), fullPage: true });
    await offPage.setViewportSize({ width: 390, height: 844 });
    await offPage.screenshot({ path: join(reports, "turned-off-mobile.png"), fullPage: true });
    if (await offPage.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error("The ended-session screen scrolls sideways.");
    const requestsAfterEnd = apiRequests;
    await offPage.waitForTimeout(2500);
    if (apiRequests !== requestsAfterEnd) throw Error("The ended UI session continued polling.");
    if ((await context.cookies()).some(value => value.name === cookie.name)) throw Error("The ended UI session retained its cookie.");
    if (JSON.stringify(commands) !== JSON.stringify(beforeClose) || states.get("profile-01")!.phase !== "ready") throw Error("Turning off the UI changed a browser lifetime.");
    let listening = false;
    try { await fetch(ui.url, { signal: AbortSignal.timeout(1000) }); listening = true; } catch {}
    if (listening) throw Error("The UI listener remained active after shutdown.");
    await offPage.close();
    if (errors.length) throw Error(`Browser errors: ${errors.join("; ")}`);
    if (external.length) throw Error("The UI requested external assets.");
    writeFileSync(join(reports, "report.json"), JSON.stringify({ result: "passed", browserErrors: errors, externalRequests: external, commands,
      checks: ["one-use session bootstrap", "fragment removed", "read-only initial observation", "offline bundled assets", "desktop/tablet/mobile layout", "mobile navigation with keyboard selection", "detail and settings responsive layouts", "state-specific lifecycle controls", "network save without credential echo", "dirty form survives polling", "explicit pause and resume", "stop confirmation", "read-only device", "redacted logs", "MCP service home", "diagnostics", "controller release preserves browser", "create direct and proxy profiles", "creation never starts browsers", "running profile deletion unavailable", "typed deletion confirmation", "deleted profiles archived", "create dialog desktop/mobile layout", "UI close preserves browser", "UI shutdown protects unsaved edits", "UI shutdown expires session", "UI shutdown stops polling and listener", "UI shutdown preserves running browsers", "ended session desktop/mobile layout"] }, null, 2));
    console.log(`UI browser checks passed. Screenshots: ${reports}`);
  } finally { await browser.close(); close(); }
}
