import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PUBLIC_SITES, parsePublicArgs, publicRunPassed, runPublicSites, type PublicConnection, type PublicReport, type ToolReply } from "../qa/public-sites.ts";
import { createTestHome } from "../helpers/test-home.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function outputDir() { const directory = mkdtempSync(join(tmpdir(), "stelz-public-sites-")); directories.push(directory); return directory; }
const png = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+afooAAAAASUVORK5CYII=" };
const reply = (value: unknown, image = true): ToolReply => ({ content: [{ type: "text", text: JSON.stringify(value) }, ...(image ? [png] : [])] });
const failure = (text: string): ToolReply => ({ isError: true, content: [{ type: "text", text }] });
const id = (number: number) => "00000000-0000-4000-8000-" + String(number).padStart(12, "0");
const flightHeading = '- heading "Web Scraping Prevention Test" [level=1]\n- heading "Search for today\'s flights" [level=2]\n- button "Search" [e21]\n';
const flightCards = '- text: Departure November 3, 2026 United SFO San Francisco 11:05 AM JFK New York 06:20 PM Arrival November 8, 2026 Price per adult $ 289 Total $ 598\n- heading "Learn more" [level=3]';
const clearSignals = ["Incognito Mode", "Bot", "VPN", "Browser Tampering", "Developer Tools", "Virtual Machine", "Privacy Settings", "IP Blocklist", "Proxy Detection", "High-Activity Device", "Rare Device"];
const rebrowserChecks = ["navigatorWebdriver", "viewport", "pwInitScripts", "platformMismatch", "mobileEmulation", "bypassCsp", "popupBlocking", "nativeTampering", "workerConsistency"];
const snapshots = [
  ['- heading "Fingerprint Playground" [level=1]', '- heading "SMART SIGNALS" [level=3]', '- table:',
    ...clearSignals.map(name => '  - row "' + name + ' Not detected":\n    - cell "' + name + '":\n    - cell "Not detected"'),
    '- heading "MOBILE SMART SIGNALS" [level=3]'].join("\n"),
  flightHeading + flightCards,
  ['- heading "Fingerprint Scan" [level=1]', '- text: Your Browser Fingerprint is consistent', '- generic "Fingerprint checks":',
    '  - text: Firefox 152.0 on Mac OS', '  - text: Browser', '  - text: Georgia / Tbilisi', '  - text: Location',
    '  - text: No proxy detected', '  - text: Proxy', '  - text: No masking detected', '  - text: Fingerprint',
    '  - text: No automated behavior detected', '  - text: Bot check', '- heading "What Websites See About You" [level=2]'].join("\n"),
  ['- heading "🕵️ rebrowser-bot-detector" [level=1]', '- text: These tests are designed for Chromium based browsers only.',
    '- table:', '  - row "Test name Time since load Notes"', '- heading "JSON" [level=3]',
    // popupBlocking is a native advisory, so the report must show a warning.
    '- textbox [e1]: ' + JSON.stringify(JSON.stringify(rebrowserChecks.map(type => ({ type, rating: type === "popupBlocking" ? 0.5 : -1, note: "No detection." }))))].join("\n"),
];
type Call = { name: string; args: Record<string, unknown> };
type State = {
  profileId: string; instanceId: string; phase: string; controllerHeld: boolean; closed: boolean; humanDone: boolean;
  opened: string[]; calls: Call[]; stops: Array<{ profile: string; home: string }>; events: string[];
};
type Override = (call: Call, state: State) => ToolReply | undefined | Promise<ToolReply | undefined>;
type Mock = ReturnType<typeof mockConnection>;
const PASS4 = Array<PublicReport["results"][number]["status"]>(4).fill("PASS");
const tabsAfterRun = [id(900), id(1), id(2), id(3), id(4)];
function mockConnection(override?: Override) {
  const state: State = { profileId: "test", instanceId: "original-browser", phase: "ready", controllerHeld: false,
    closed: false, humanDone: false, opened: [], calls: [], stops: [], events: [] };
  const connection: PublicConnection = {
    async call(name, args) {
      const call = { name, args }; state.calls.push(call); state.events.push(name);
      const replaced = await override?.(call, state);
      if (replaced) return replaced;
      if (name === "profile_status") return reply({ profileId: state.profileId, phase: state.phase, instanceId: state.instanceId });
      if (name === "profile_acquire") { state.controllerHeld = true; return reply({ acquired: true, controlHandle: "test-control-handle" }); }
      if (name === "profile_release") { state.controllerHeld = false; return reply({ released: true }); }
      if (name === "profile_pause") { state.phase = "paused"; return reply({ paused: true }); }
      if (name === "profile_resume") { state.phase = "ready"; return reply({ resumed: true }); }
      if (name === "tab_list") return reply({ tabs: [id(900), ...state.opened].map(tabId => ({ tabId })) });
      if (name === "tab_create") { const tabId = id(state.opened.length + 1); state.opened.push(tabId); return reply({ tabId }); }
      if (name === "tab_click") return reply({ ok: true });
      if (name === "tab_snapshot") {
        const index = state.opened.indexOf(String(args.tabId));
        return reply({ url: PUBLIC_SITES[index]!.url, snapshot: snapshots[index], hasMore: false });
      }
      if (name === "tab_screenshot") return { content: [png] };
      throw Error("Unexpected tool: " + name);
    },
    async close() { state.events.push("disconnect"); state.closed = true; },
  };
  return { connection, state };
}
function run(mock: Mock, options: Partial<Parameters<typeof runPublicSites>[0]> = {}) {
  let clock = 0;
  const { stop, ...rest } = options;
  const output = options.outputDir ?? outputDir(), home = options.home ?? createTestHome("service", output);
  return runPublicSites({ profile: "test", home, outputDir: output, connect: async () => mock.connection, log: () => {},
    now: () => clock, sleep: async ms => { clock += ms; }, timeoutMs: 2, pollMs: 1, ...rest,
    stop: async (profile, home) => {
      mock.state.stops.push({ profile, home }); mock.state.events.push("stop");
      if (stop) await stop(profile, home);
      else mock.state.phase = "stopped";
      if (mock.state.phase === "stopped") mock.state.controllerHeld = false;
    } });
}
const called = (mock: Mock, name: string) => mock.state.calls.some(call => call.name === name);
const siteSnapshotCalls = (mock: Mock, tab: string) => mock.state.calls.filter(call => call.name === "tab_snapshot" && call.args.tabId === tab);
function savedReport(directory: string): PublicReport { return JSON.parse(readFileSync(join(directory, "report.json"), "utf8")); }
// The explicit stop ran once with the controller retained, so no release RPC was sent, and the connection closed.
function expectShutdown(mock: Mock, report: PublicReport, passed = false) {
  expect(report.stopped).toBe(true);
  expect(report.released).toBe(true);
  expect(report.finalInstanceId).toBe("original-browser");
  expect(mock.state.stops).toHaveLength(1);
  expect(mock.state.phase).toBe("stopped");
  expect(called(mock, "profile_release")).toBe(false);
  expect(mock.state.closed).toBe(true);
  expect(publicRunPassed(report)).toBe(passed);
}
// Stop did not confirm, so cleanup fell back to one release RPC and never claimed shutdown.
function expectFallbackRelease(mock: Mock, report: PublicReport) {
  expect(report.stopped).toBe(false);
  expect(report.errors.some(error => error.startsWith("Stop: "))).toBe(true);
  expect(mock.state.calls.filter(call => call.name === "profile_release")).toHaveLength(1);
  expect(mock.state.events.slice(-2)).toEqual(["profile_release", "disconnect"]);
  expect(report.released).toBe(true);
  expect(mock.state.closed).toBe(true);
  expect(savedReport(report.outputDir)).toEqual(report);
  expect(publicRunPassed(report)).toBe(false);
}
const pending = () => { let done!: () => void; const promise = new Promise<void>(resolve => { done = resolve; }); return { promise, done }; };

test("a full run uses one controller, saves private evidence before stopping the selected profile, and reports every site", async () => {
  const directory = outputDir(), home = createTestHome("service-home", directory) + "/nested/..", mock = mockConnection();
  mock.state.profileId = "selected-profile";
  const report = await run(mock, { profile: "selected-profile", home, outputDir: directory,
    connect: async () => {
      expect(savedReport(directory)).toMatchObject({ profile: "selected-profile", stopped: false, released: false });
      return mock.connection;
    },
    stop: async (profile, serviceHome) => {
      expect({ profile, serviceHome }).toEqual({ profile: "selected-profile", serviceHome: resolve(home) });
      expect(mock.state.controllerHeld).toBe(true);
      expect(mock.state.closed).toBe(false);
      expect(mock.state.calls.at(-1)!.name).toBe("profile_status");
      const saved = savedReport(directory);
      expect(saved).toMatchObject({ stopped: false, released: false, initialInstanceId: "original-browser", initialTabIds: [id(900)], finalTabIds: tabsAfterRun });
      expect(saved.results.map(site => site.status)).toEqual(PASS4);
      for (const site of saved.results) {
        expect(readFileSync(site.screenshot!).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        expect(statSync(site.screenshot!).mode & 0o777).toBe(0o600);
        expect(JSON.parse(readFileSync(site.snapshot!, "utf8")).pages).toHaveLength(1);
      }
      const markdown = readFileSync(join(directory, "report.md"), "utf8");
      expect(markdown).toContain("![Pixelscan]");
      expect(markdown).toContain("Warning: popupBlocking");
      mock.state.phase = "stopped";
    } });
  expectShutdown(mock, report, true);
  expect(publicRunPassed({ ...report, stopped: false })).toBe(false);
  expect(report.errors).toEqual([]);
  expect(report.results[3]!.reason).toContain("Partial coverage");
  expect(mock.state.stops).toEqual([{ profile: "selected-profile", home: resolve(home) }]);
  expect(mock.state.calls.slice(0, 3).map(call => call.name)).toEqual(["profile_status", "profile_acquire", "tab_list"]);
  expect(mock.state.events.slice(-4)).toEqual(["profile_status", "stop", "profile_status", "disconnect"]);
  expect(mock.state.events.lastIndexOf("tab_list")).toBeLessThan(mock.state.events.indexOf("stop"));
  expect(mock.state.calls.filter(call => call.name === "tab_create").map(call => call.args)).toEqual(PUBLIC_SITES.map(site => ({ url: site.url })));
  expect(mock.state.calls.every(call => !/evaluate|close_tab|stop|start|recheck|scroll/.test(call.name))).toBe(true);
  // The flight screenshot follows native scrolling to an observed test-area control.
  const click = mock.state.calls.findIndex(call => call.name === "tab_click");
  expect(mock.state.calls[click - 1]!.name).toBe("tab_snapshot");
  expect(mock.state.calls[click]!.args).toEqual({ tabId: id(2), ref: "e21" });
  expect(mock.state.calls[click + 1]!.name).toBe("tab_snapshot");
  expect(report.results[1]!.screenshotFramed).toBe(true);
  expect(savedReport(directory)).toEqual(report);
});

test("report write failures cannot skip shutdown or disconnect", async () => {
  const directory = outputDir(), blockedWrite = join(directory, "report.json.tmp");
  let blocked = false;
  const mock = mockConnection(({ name }) => {
    if (name === "tab_snapshot" && !blocked) { mkdirSync(blockedWrite); blocked = true; }
    return undefined;
  });
  const report = await run(mock, { outputDir: directory });
  expect(statSync(blockedWrite).isDirectory()).toBe(true);
  const reportErrors = report.errors.filter(error => error.startsWith("Report: "));
  expect(reportErrors).toHaveLength(2);
  expect(reportErrors.every(error => error.includes("report.json.tmp"))).toBe(true);
  expectShutdown(mock, report);
  expect(mock.state.events.slice(-4)).toEqual(["profile_status", "stop", "profile_status", "disconnect"]);
});

test.each([
  ["a failed test-area activation", "tab_click", "Test-area activation failed."],
  ["an unavailable site", "tab_snapshot", "Site unavailable."],
] as const)("%s is reported as an error and the other sites still run", async (_label, tool, text) => {
  const mock = mockConnection(({ name, args }) => name === tool && (tool === "tab_click" || args.tabId === id(2)) ? failure(text) : undefined);
  const report = await run(mock);
  expect(report.results.map(site => site.status)).toEqual(["PASS", "ERROR", "PASS", "PASS"]);
  expect(report.results[1]!.errors).toContain(text);
  expect(report.results[1]!.screenshotFramed).not.toBe(true);
  expect(mock.state.opened).toHaveLength(4);
  expectShutdown(mock, report);
});

test.each([
  ["a stopped profile", () => undefined, "stopped"],
  ["a controller conflict", ({ name }: Call) => name === "profile_acquire" ? failure("Profile has an active controller.") : undefined, "ready"],
  ["an unacknowledged acquisition", ({ name }: Call) => name === "profile_acquire" ? reply({ acquired: false }) : undefined, "ready"],
  ["a missing instance", ({ name }: Call) => name === "profile_status" ? reply({ profileId: "test", phase: "ready" }) : undefined, "ready"],
] as const)("%s at entry cannot create tabs, stop a browser, or release another controller", async (_label, override, phase) => {
  const mock = mockConnection(override);
  mock.state.phase = phase;
  const report = await run(mock);
  expect(publicRunPassed(report)).toBe(false);
  expect(report.stopped).toBe(false);
  expect(report.released).toBe(false);
  expect(report.errors.length).toBeGreaterThan(0);
  expect(mock.state.opened).toHaveLength(0);
  expect(mock.state.stops).toHaveLength(0);
  expect(called(mock, "profile_release")).toBe(false);
  expect(mock.state.closed).toBe(true);
});

test("a failed connection cannot stop or release a profile", async () => {
  const mock = mockConnection(), report = await run(mock, { connect: async () => { throw Error("MCP connection failed."); } });
  expect(report.errors).toContain("MCP connection failed.");
  expect(report.stopped).toBe(false);
  expect(report.released).toBe(false);
  expect(mock.state.calls).toHaveLength(0);
  expect(mock.state.stops).toHaveLength(0);
  expect(publicRunPassed(report)).toBe(false);
});

test.each([
  ["an unavailable tab inventory", () => ({ name }: Call) => name === "tab_list" ? failure("Tab inventory unavailable.") : undefined, "Tab inventory unavailable."],
  ["a disappeared original tab", () => { let listings = 0; return ({ name }: Call, state: State) =>
    name === "tab_list" && ++listings > 1 ? reply({ tabs: state.opened.map(tabId => ({ tabId })) }) : undefined; }, "tab disappeared"],
] as const)("an acquired profile is still stopped after %s", async (_label, makeOverride, error) => {
  const mock = mockConnection(makeOverride());
  const report = await run(mock);
  expect(report.errors.join(" ")).toContain(error);
  expect(mock.state.events.lastIndexOf("tab_list")).toBeLessThan(mock.state.events.indexOf("stop"));
  expectShutdown(mock, report);
});

test.each(["changed profile", "changed instance", "missing instance"] as const)(
  "cleanup refuses to stop an acquired browser with a %s", async condition => {
  const mock = mockConnection(({ name }, state) => {
    if (name === "tab_list") {
      if (condition === "changed profile") state.profileId = "other-profile";
      if (condition === "changed instance") state.instanceId = "replacement-browser";
    }
    if (condition === "missing instance" && name === "profile_status" && called(mock, "tab_list")) return reply({ profileId: "test", phase: state.phase });
  });
  const report = await run(mock);
  expect(report.stopped).toBe(false);
  expect(report.errors.some(error => error.startsWith("Stop: "))).toBe(true);
  expect(mock.state.stops).toHaveLength(0);
  expect(mock.state.opened).toHaveLength(0);
  expect(mock.state.closed).toBe(true);
  expect(publicRunPassed(report)).toBe(false);
});

test.each(["blocked", "verification_failed"])("a %s service stops new browser actions and is shut down", async phase => {
  const mock = mockConnection(({ name }, state) => {
    if (name === "tab_snapshot") { state.phase = phase; return failure("Service action deadline exceeded."); }
  });
  const report = await run(mock);
  expect(report.results.map(site => site.status)).toEqual(["ERROR", "INCONCLUSIVE", "INCONCLUSIVE", "INCONCLUSIVE"]);
  expect(mock.state.opened).toHaveLength(1);
  const failureIndex = mock.state.calls.findIndex(call => call.name === "tab_snapshot");
  expect(mock.state.calls.slice(failureIndex + 1).every(call => call.name.startsWith("profile_"))).toBe(true);
  expectShutdown(mock, report);
});

test("a failed status request after an action failure prevents screenshot fallbacks and falls back to release", async () => {
  let actionFailed = false;
  const mock = mockConnection(({ name }) => {
    if (name === "tab_snapshot") { actionFailed = true; return failure("Action failed."); }
    if (name === "profile_status" && actionFailed) throw Error("Status is unreachable.");
  });
  const report = await run(mock);
  expect(called(mock, "tab_screenshot")).toBe(false);
  expect(mock.state.opened).toHaveLength(1);
  expect(report.results[0]!.status).toBe("ERROR");
  expect(report.errors.join(" ")).toContain("Status is unreachable");
  expect(mock.state.stops).toHaveLength(0);
  expectFallbackRelease(mock, report);
});

test("an already stopped acquired lifetime is confirmed without another stop or release", async () => {
  const mock = mockConnection(({ name }, state) => {
    if (name === "tab_snapshot") { state.phase = "stopped"; state.controllerHeld = false; return failure("The browser window was closed."); }
  });
  const report = await run(mock);
  expect(report.stopped).toBe(true);
  expect(report.released).toBe(true);
  expect(report.finalInstanceId).toBe("original-browser");
  expect(mock.state.stops).toHaveLength(0);
  expect(called(mock, "profile_release")).toBe(false);
  expect(publicRunPassed(report)).toBe(false);
});

test("late MCP responses are awaited but cannot pass the site deadline", async () => {
  let clock = 0;
  const mock = mockConnection(({ name, args }) => { if (name === "tab_snapshot" && args.tabId === id(1)) clock += 10; return undefined; });
  const report = await run(mock, { now: () => clock, timeoutMs: 5 });
  expect(report.results[0]).toMatchObject({ status: "INCONCLUSIVE", observedVerdict: "PASS" });
  expect(report.results[0]!.reason).toContain("arrived after");
});

test("tab creation time counts toward the site deadline", async () => {
  let clock = 0;
  const mock = mockConnection(({ name }) => { if (name === "tab_create") clock += 10; return undefined; });
  const report = await run(mock, { now: () => clock, timeoutMs: 5 });
  expect(report.results.every(site => site.status === "INCONCLUSIVE")).toBe(true);
  expect(called(mock, "tab_snapshot")).toBe(false);
});

test("pagination joins the windows of one view before assessing a complete result", async () => {
  const mock = mockConnection(({ name, args }) => {
    if (name !== "tab_snapshot" || args.tabId !== id(2)) return;
    // A window ends at a line break, and nextOffset skips the break.
    return reply({ url: PUBLIC_SITES[1]!.url, snapshot: args.offset ? flightCards : flightHeading.slice(0, -1), viewId: "v1",
      nextOffset: args.offset ? null : flightHeading.length });
  });
  const report = await run(mock);
  expect(report.results[1]!.status).toBe("PASS");
  const calls = siteSnapshotCalls(mock, id(2));
  expect(calls.map(call => call.args.offset)).toEqual([undefined, flightHeading.length, undefined, flightHeading.length]);
  // The first window asks for the screenshot and the whole page. A later window pages that view and asks for nothing else.
  expect(calls[0]!.args).toEqual({ tabId: id(2), maxChars: 80_000, collapse: false, includeScreenshot: true });
  expect(calls[1]!.args).toEqual({ tabId: id(2), maxChars: 80_000, offset: flightHeading.length, viewId: "v1" });
  expect(JSON.parse(readFileSync(report.results[1]!.snapshot!, "utf8")).pages).toHaveLength(2);
});

test("non-advancing pagination fails instead of reading indefinitely", async () => {
  const mock = mockConnection(({ name, args }) => name === "tab_snapshot" && args.tabId === id(2)
    ? reply({ url: PUBLIC_SITES[1]!.url, snapshot: flightHeading, hasMore: true, nextOffset: 0 }) : undefined);
  const report = await run(mock);
  expect(report.results[1]!.status).toBe("ERROR");
  expect(report.results[1]!.reason).toContain("pagination did not advance");
  expect(siteSnapshotCalls(mock, id(2))).toHaveLength(1);
});

test("loading can resolve later, and stale loading screenshots cannot prove the final verdict", async () => {
  let observed = 0;
  const mock = mockConnection(({ name, args }) => {
    if (name === "tab_snapshot" && args.tabId === id(2)) return reply({ url: PUBLIC_SITES[1]!.url,
      snapshot: ++observed === 1 ? flightHeading + "- text: Loading" : snapshots[1] }, observed === 1);
    if (name === "tab_screenshot" && args.tabId === id(2)) return { content: [{ ...png, data: "not-a-png" }] };
  });
  const report = await run(mock, { pollMs: 10, timeoutMs: 30 });
  expect(observed).toBe(2);
  expect(report.results[1]).toMatchObject({ status: "ERROR", observedVerdict: "PASS" });
  expect(report.results[1]!.screenshot).toBeUndefined();
  expect(report.results[1]!.errors.join(" ")).toContain("invalid PNG bytes");
  expect(publicRunPassed(report)).toBe(false);
});

test.each([
  ["an unfinished verdict", { snapshot: flightHeading + "- text: Loading" }, "No completed verdict within"],
  ["an unexpected redirect to a disabled detector URL", { url: PUBLIC_SITES[1]!.url + "?disableBotDetection=1", snapshot: snapshots[1] }, "Unexpected final URL"],
] as const)("%s keeps the evidence and never becomes a pass", async (_label, page, reason) => {
  const mock = mockConnection(({ name, args }) => name === "tab_snapshot" && args.tabId === id(2) ? reply({ url: PUBLIC_SITES[1]!.url, ...page }) : undefined);
  const report = await run(mock, { pollMs: 10, timeoutMs: 20 });
  expect(report.results[1]!.status).toBe("INCONCLUSIVE");
  expect(report.results[1]!.reason).toContain(reason);
  expect(report.results[1]!.screenshot).toBeDefined();
  expect(report.results[3]!.status).toBe("PASS");
  expect(publicRunPassed(report)).toBe(false);
});

const challengeMock = () => mockConnection(({ name, args }, state) => name === "tab_snapshot" && args.tabId === id(1) && !state.humanDone
  ? reply({ url: PUBLIC_SITES[0]!.url, snapshot: '- heading "Verify you are human" [level=1]\n- button "Verify"' }) : undefined);

test("human confirmation pauses and resumes the same profile before a fresh observation", async () => {
  const mock = challengeMock();
  const report = await run(mock, { confirmHuman: async () => {
    expect(mock.state.phase).toBe("paused");
    expect(mock.state.controllerHeld).toBe(true);
    expect(mock.state.stops).toHaveLength(0);
    mock.state.humanDone = true; return true;
  } });
  const names = mock.state.calls.map(call => call.name), resume = names.indexOf("profile_resume");
  expect(resume).toBeGreaterThan(names.indexOf("profile_pause"));
  expect(names.slice(resume + 1, resume + 3)).toEqual(["profile_status", "tab_snapshot"]);
  expect(report.results.map(site => site.status)).toEqual(PASS4);
  expectShutdown(mock, report, true);
});

test.each(["ended", "interrupted"])("unconfirmed authentication stays paused while waiting and stops when %s", async ending => {
  const mock = challengeMock(), abort = new AbortController(), entered = pending();
  let finish!: (confirmed: boolean) => void;
  const confirmation = new Promise<boolean>(resolve => { finish = resolve; });
  const running = run(mock, { signal: abort.signal, confirmHuman: async () => { entered.done(); return confirmation; } });
  await entered.promise;
  expect(mock.state.phase).toBe("paused");
  expect(mock.state.controllerHeld).toBe(true);
  expect(mock.state.closed).toBe(false);
  expect(mock.state.stops).toHaveLength(0);
  if (ending === "interrupted") abort.abort("SIGINT");
  finish(false);
  const report = await running;
  expect(report.results[0]!.status).toBe("INCONCLUSIVE");
  expect(report.results[0]!.reason).toContain("The run ended before authentication was confirmed.");
  expect(called(mock, "profile_resume")).toBe(false);
  expect(mock.state.opened).toHaveLength(1);
  expect(report.interrupted).toBe(ending === "interrupted" ? "SIGINT" : undefined);
  expectShutdown(mock, report);
});

test("interrupts await in-flight operations and save reports before stopping the browser", async () => {
  const abort = new AbortController(), directory = outputDir(), started = pending(), release = pending();
  let inFlight = false;
  const mock = mockConnection(async ({ name, args }) => {
    if (name === "tab_snapshot" && args.tabId === id(1)) { inFlight = true; started.done(); await release.promise; inFlight = false; }
    return undefined;
  });
  const running = run(mock, { signal: abort.signal, outputDir: directory, stop: async () => {
    expect(inFlight).toBe(false);
    expect(mock.state.controllerHeld).toBe(true);
    expect(savedReport(directory)).toMatchObject({ interrupted: "SIGINT", stopped: false, released: false });
    mock.state.phase = "stopped";
  } });
  await started.promise; abort.abort("SIGINT");
  expect(inFlight).toBe(true);
  expect(mock.state.stops).toHaveLength(0);
  expect(mock.state.closed).toBe(false);
  release.done();
  const report = await running;
  expect(report.interrupted).toBe("SIGINT");
  expect(mock.state.opened).toHaveLength(1);
  expect(mock.state.events.slice(-4)).toEqual(["profile_status", "stop", "profile_status", "disconnect"]);
  expect(savedReport(directory)).toEqual(report);
  expectShutdown(mock, report);
});

test.each(["command rejected", "still ready", "changed profile", "missing instance", "status unavailable"] as const)(
  "cleanup falls back to release without claiming shutdown when stop has %s", async outcome => {
  const mock = mockConnection(({ name }, state) => {
    if (name === "profile_status" && state.stops.length) {
      if (outcome === "status unavailable") throw Error("Shutdown status is unreachable.");
      if (outcome === "missing instance") return reply({ profileId: "test", phase: "stopped" });
    }
  });
  const report = await run(mock, { stop: async () => {
    if (outcome === "command rejected") throw Error("Explicit shutdown failed.");
    if (outcome === "still ready") return;
    mock.state.phase = "stopped";
    if (outcome === "changed profile") mock.state.profileId = "other-profile";
  } });
  expect(report.results.every(site => site.status === "PASS")).toBe(true);
  expect(report.finalInstanceId).toBe("original-browser");
  expect(mock.state.stops).toEqual([{ profile: "test", home: report.serviceHome }]);
  if (outcome === "command rejected") expect(report.errors).toContain("Stop: Explicit shutdown failed.");
  expectFallbackRelease(mock, report);
});

test("cleanup disconnects and records both failures when stop and fallback release fail", async () => {
  const mock = mockConnection(({ name }) => name === "profile_release" ? failure("Release failed.") : undefined);
  const report = await run(mock, { stop: async () => { throw Error("Explicit shutdown failed."); } });
  expect(report.errors).toContain("Stop: Explicit shutdown failed.");
  expect(report.errors).toContain("Release: Release failed.");
  expect(report.stopped).toBe(false);
  expect(report.released).toBe(false);
  expect(mock.state.events.slice(-3)).toEqual(["stop", "profile_release", "disconnect"]);
  expect(mock.state.closed).toBe(true);
  expect(savedReport(report.outputDir)).toEqual(report);
  expect(publicRunPassed(report)).toBe(false);
});

test("CLI arguments cannot select an operator's profile", () => {
  expect(parsePublicArgs([])).toEqual({ help: false });
  expect(parsePublicArgs(["--help"]).help).toBe(true);
  for (const args of [["--profile", "profile-02"], ["--profile"], ["--profile", "../bad"], ["--unknown"]]) expect(() => parsePublicArgs(args)).toThrow();
});

test("unowned service directories fail before connecting or running cleanup", async () => {
  const home = outputDir(), mock = mockConnection();
  await expect(run(mock, { home })).rejects.toThrow("unowned service directory");
  expect(mock.state.calls).toEqual([]);
  expect(mock.state.stops).toEqual([]);
});
