import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PUBLIC_SITES, parsePublicArgs, publicRunPassed, runPublicSites, type PublicConnection, type PublicReport, type ToolReply } from "../qa/public-sites.ts";

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
  flightHeading + flightCards,
  ['- heading "Fingerprint Playground" [level=1]', '- heading "SMART SIGNALS" [level=3]', '- table:',
    ...clearSignals.map(name => '  - row "' + name + ' Not detected":\n    - cell "' + name + '":\n    - cell "Not detected"'),
    '- heading "MOBILE SMART SIGNALS" [level=3]'].join("\n"),
  ['- heading "Fingerprint Scan" [level=1]', '- text: Your Browser Fingerprint is consistent', '- generic "Fingerprint checks":',
    '  - text: Firefox 152.0 on Mac OS', '  - text: Browser', '  - text: Georgia / Tbilisi', '  - text: Location',
    '  - text: No proxy detected', '  - text: Proxy', '  - text: No masking detected', '  - text: Fingerprint',
    '  - text: No automated behavior detected', '  - text: Bot check', '- heading "What Websites See About You" [level=2]'].join("\n"),
  ['- heading "🕵️ rebrowser-bot-detector" [level=1]', '- text: These tests are designed for Chromium based browsers only.',
    '- table:', '  - row "Test name Time since load Notes"', '- heading "JSON" [level=3]',
    '- textbox [e1]: ' + JSON.stringify(JSON.stringify(rebrowserChecks.map(type => ({ type, rating: -1, note: "No detection." }))))].join("\n"),
];
type Call = { name: string; args: Record<string, unknown> };
type State = {
  profileId: string; instanceId: string; phase: string; controllerHeld: boolean; closed: boolean; humanDone: boolean;
  opened: string[]; calls: Call[]; stops: Array<{ profile: string; home: string }>; events: string[];
};
type Override = (call: Call, state: State) => ToolReply | undefined | Promise<ToolReply | undefined>;
function mockConnection(override?: Override) {
  const state: State = { profileId: "test", instanceId: "original-browser", phase: "ready", controllerHeld: false,
    closed: false, humanDone: false, opened: [], calls: [], stops: [], events: [] };
  const connection: PublicConnection = {
    async call(name, args) {
      const call = { name, args }; state.calls.push(call); state.events.push(name);
      const replaced = await override?.(call, state);
      if (replaced) return replaced;
      if (name === "profile_status") return reply({ profileId: state.profileId, phase: state.phase, instanceId: state.instanceId });
      if (name === "profile_acquire") { state.controllerHeld = true; return reply({ acquired: true }); }
      if (name === "profile_release") { state.controllerHeld = false; return reply({ released: true }); }
      if (name === "profile_pause") { state.phase = "paused"; return reply({ paused: true }); }
      if (name === "profile_resume") { state.phase = "ready"; return reply({ resumed: true }); }
      if (name === "camofox_list_tabs") return reply({ tabs: [id(900), ...state.opened].map(tabId => ({ tabId })) });
      if (name === "camofox_create_tab") { const tabId = id(state.opened.length + 1); state.opened.push(tabId); return reply({ tabId }); }
      if (name === "camofox_click") return reply({ ok: true });
      if (name === "camofox_snapshot") {
        const index = state.opened.indexOf(String(args.tabId));
        return reply({ url: PUBLIC_SITES[index]!.url, snapshot: snapshots[index], hasMore: false });
      }
      if (name === "camofox_screenshot") return { content: [png] };
      throw Error("Unexpected tool: " + name);
    },
    async close() { state.events.push("disconnect"); state.closed = true; },
  };
  return { connection, state };
}
function run(mock: ReturnType<typeof mockConnection>, options: Partial<Parameters<typeof runPublicSites>[0]> = {}) {
  let clock = 0;
  const { stop, ...rest } = options;
  return runPublicSites({ profile: "test", outputDir: outputDir(), connect: async () => mock.connection, log: () => {},
    now: () => clock, sleep: async ms => { clock += ms; }, timeoutMs: 2, pollMs: 1, ...rest,
    stop: async (profile, home) => {
      mock.state.stops.push({ profile, home }); mock.state.events.push("stop");
      if (stop) await stop(profile, home);
      else mock.state.phase = "stopped";
      if (mock.state.phase === "stopped") mock.state.controllerHeld = false;
    } });
}
function savedReport(directory: string): PublicReport { return JSON.parse(readFileSync(join(directory, "report.json"), "utf8")); }

test("all four sites use one Camoufox controller and produce private PNGs and complete reports", async () => {
  const mock = mockConnection(), report = await run(mock);
  expect(report.results.map(site => site.status)).toEqual(["PASS", "PASS", "PASS", "PASS"]);
  expect(report.results[3]!.reason).toContain("Partial coverage");
  expect(publicRunPassed(report)).toBe(true);
  expect(publicRunPassed({ ...report, stopped: false })).toBe(false);
  expect(report.stopped).toBe(true);
  expect(report.released).toBe(true);
  expect(report.finalInstanceId).toBe("original-browser");
  expect(report.initialTabIds).toEqual([id(900)]);
  expect(report.finalTabIds).toEqual([id(900), id(1), id(2), id(3), id(4)]);
  expect(mock.state.stops).toEqual([{ profile: "test", home: report.serviceHome }]);
  expect(mock.state.phase).toBe("stopped");
  expect(mock.state.controllerHeld).toBe(false);
  expect(mock.state.closed).toBe(true);
  expect(mock.state.calls.slice(0, 3).map(call => call.name)).toEqual(["profile_status", "profile_acquire", "camofox_list_tabs"]);
  expect(mock.state.events.slice(-4)).toEqual(["profile_status", "stop", "profile_status", "disconnect"]);
  expect(mock.state.events.lastIndexOf("camofox_list_tabs")).toBeLessThan(mock.state.events.indexOf("stop"));
  expect(mock.state.calls.some(call => call.name === "profile_release")).toBe(false);
  expect(mock.state.calls.filter(call => call.name === "camofox_create_tab").map(call => call.args)).toEqual(PUBLIC_SITES.map(site => ({ url: site.url })));
  expect(mock.state.calls.every(call => !/evaluate|close_tab|stop|start|recheck/.test(call.name))).toBe(true);
  for (const site of report.results) {
    expect(readFileSync(site.screenshot!).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(statSync(site.screenshot!).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(site.snapshot!, "utf8")).pages).toHaveLength(1);
  }
  expect(JSON.parse(readFileSync(join(report.outputDir, "report.json"), "utf8"))).toEqual(report);
  expect(readFileSync(join(report.outputDir, "report.md"), "utf8")).toContain("![Pixelscan]");
});

test("cleanup saves readable evidence before stopping the selected profile and home with its controller held", async () => {
  const directory = outputDir(), home = directory + "/nested/../service-home", mock = mockConnection();
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
      expect(mock.state.calls.some(call => call.name === "profile_release")).toBe(false);
      const saved = savedReport(directory);
      expect(saved).toMatchObject({ stopped: false, released: false, initialInstanceId: "original-browser",
        initialTabIds: [id(900)], finalTabIds: [id(900), id(1), id(2), id(3), id(4)] });
      expect(saved.results.map(site => site.status)).toEqual(["PASS", "PASS", "PASS", "PASS"]);
      for (const site of saved.results) {
        expect(JSON.parse(readFileSync(site.snapshot!, "utf8")).pages.length).toBeGreaterThan(0);
        expect(readFileSync(site.screenshot!).length).toBeGreaterThan(0);
      }
      expect(readFileSync(join(directory, "report.md"), "utf8")).toContain("![Pixelscan]");
      mock.state.phase = "stopped";
    } });
  expect(mock.state.stops).toEqual([{ profile: "selected-profile", home: resolve(home) }]);
  expect(report.errors).toEqual([]);
  expect(report.finalInstanceId).toBe("original-browser");
  expect(publicRunPassed(report)).toBe(true);
  expect(savedReport(directory)).toEqual(report);
});

test("report write failures cannot skip shutdown or disconnect", async () => {
  const directory = outputDir(), blockedWrite = join(directory, "report.json.tmp");
  let blocked = false;
  const mock = mockConnection(({ name }) => {
    if (name === "camofox_snapshot" && !blocked) { mkdirSync(blockedWrite); blocked = true; }
    return undefined;
  });
  const report = await run(mock, { outputDir: directory });
  expect(blocked).toBe(true);
  expect(statSync(blockedWrite).isDirectory()).toBe(true);
  const reportErrors = report.errors.filter(error => error.startsWith("Report: "));
  expect(reportErrors).toHaveLength(2);
  expect(reportErrors.every(error => error.includes("report.json.tmp"))).toBe(true);
  expect(report.stopped).toBe(true);
  expect(report.released).toBe(true);
  expect(report.finalInstanceId).toBe("original-browser");
  expect(mock.state.stops).toEqual([{ profile: "test", home: report.serviceHome }]);
  expect(mock.state.phase).toBe("stopped");
  expect(mock.state.controllerHeld).toBe(false);
  expect(mock.state.calls.some(call => call.name === "profile_release")).toBe(false);
  expect(mock.state.events.slice(-4)).toEqual(["profile_status", "stop", "profile_status", "disconnect"]);
  expect(mock.state.closed).toBe(true);
  expect(publicRunPassed(report)).toBe(false);
});

test("the flight screenshot follows native scrolling to an observed test-area control", async () => {
  const mock = mockConnection(), report = await run(mock);
  const click = mock.state.calls.findIndex(call => call.name === "camofox_click");
  expect(click).toBeGreaterThan(0);
  expect(mock.state.calls[click - 1]!.name).toBe("camofox_snapshot");
  expect(mock.state.calls[click]!.args).toEqual({ tabId: id(1), ref: "e21" });
  expect(mock.state.calls[click + 1]!.name).toBe("camofox_snapshot");
  expect(mock.state.calls.some(call => call.name === "camofox_scroll")).toBe(false);
  expect(report.results[0]!.screenshotFramed).toBe(true);
  expect(report.results[0]!.screenshot).toBeDefined();
});

test("a failed test-area activation is reported as an error", async () => {
  const mock = mockConnection(({ name }) => name === "camofox_click" ? failure("Test-area activation failed.") : undefined);
  const report = await run(mock);
  expect(report.results[0]!.status).toBe("ERROR");
  expect(report.results[0]!.errors).toContain("Test-area activation failed.");
  expect(report.results[0]!.screenshotFramed).not.toBe(true);
  expect(report.stopped).toBe(true);
  expect(report.released).toBe(true);
  expect(mock.state.stops).toHaveLength(1);
  expect(publicRunPassed(report)).toBe(false);
});

test("low-confidence proxy warnings remain visible in the report", async () => {
  const value = "Your IP is used by a residential proxy (confidence: low, ML score: 0.688)";
  const mock = mockConnection(({ name, args }) => name === "camofox_snapshot" && args.tabId === id(2)
    ? reply({ url: PUBLIC_SITES[1]!.url, snapshot: snapshots[1]!.replaceAll("Proxy Detection Not detected", "Proxy Detection " + value)
      .replace('cell "Proxy Detection":\n    - cell "Not detected"', 'cell "Proxy Detection":\n    - cell "' + value + '"') }) : undefined);
  const report = await run(mock);
  expect(report.results[1]!.status).toBe("PASS");
  expect(report.results[1]!.warnings).toHaveLength(1);
  expect(readFileSync(join(report.outputDir, "report.md"), "utf8")).toContain("Warning: Proxy Detection");
});

test.each(["stopped", "controller conflict", "unacknowledged acquisition", "failed acquisition", "wrong profile", "missing instance"] as const)(
  "%s at entry cannot create tabs, stop a browser, or release another controller", async condition => {
  const mock = mockConnection(({ name }) => {
    if (condition === "controller conflict" && name === "profile_acquire") return failure("Profile has an active controller.");
    if (condition === "unacknowledged acquisition" && name === "profile_acquire") return reply({ acquired: false });
    if (condition === "failed acquisition" && name === "profile_acquire") throw Error("Acquisition disconnected.");
    if (condition === "missing instance" && name === "profile_status") return reply({ profileId: "test", phase: "ready" });
  });
  if (condition === "stopped") mock.state.phase = "stopped";
  if (condition === "wrong profile") mock.state.profileId = "other-profile";
  const report = await run(mock);
  expect(publicRunPassed(report)).toBe(false);
  expect(report.stopped).toBe(false);
  expect(report.released).toBe(false);
  expect(report.errors.length).toBeGreaterThan(0);
  expect(report.results).toHaveLength(4);
  expect(mock.state.opened).toHaveLength(0);
  expect(mock.state.stops).toHaveLength(0);
  expect(mock.state.calls.some(call => call.name === "profile_release")).toBe(false);
  expect(mock.state.closed).toBe(true);
});

test("a failed connection cannot stop or release a profile", async () => {
  const mock = mockConnection(), report = await run(mock, { connect: async () => { throw Error("MCP connection failed."); } });
  expect(report.errors).toContain("MCP connection failed.");
  expect(report.stopped).toBe(false);
  expect(report.released).toBe(false);
  expect(publicRunPassed(report)).toBe(false);
  expect(mock.state.calls).toHaveLength(0);
  expect(mock.state.stops).toHaveLength(0);
  expect(mock.state.closed).toBe(false);
});

test("an acquired profile is stopped even when the initial tab inventory fails", async () => {
  const mock = mockConnection(({ name }) => name === "camofox_list_tabs" ? failure("Tab inventory unavailable.") : undefined);
  const report = await run(mock);
  expect(report.errors).toContain("Tab inventory unavailable.");
  expect(report.stopped).toBe(true);
  expect(report.released).toBe(true);
  expect(mock.state.stops).toHaveLength(1);
  expect(mock.state.opened).toHaveLength(0);
  expect(mock.state.calls.some(call => call.name === "profile_release")).toBe(false);
  expect(mock.state.closed).toBe(true);
  expect(publicRunPassed(report)).toBe(false);
});

test.each(["changed profile", "changed instance", "missing instance"] as const)(
  "cleanup refuses to stop an acquired browser with a %s", async condition => {
  const mock = mockConnection(({ name }, state) => {
    if (name === "camofox_list_tabs") {
      if (condition === "changed profile") state.profileId = "other-profile";
      if (condition === "changed instance") state.instanceId = "replacement-browser";
    }
    if (condition === "missing instance" && name === "profile_status" && state.calls.some(call => call.name === "camofox_list_tabs")) {
      return reply({ profileId: "test", phase: state.phase });
    }
  });
  const report = await run(mock);
  expect(report.initialInstanceId).toBe("original-browser");
  expect(report.stopped).toBe(false);
  expect(report.errors.some(error => error.startsWith("Stop: "))).toBe(true);
  expect(mock.state.stops).toHaveLength(0);
  expect(mock.state.opened).toHaveLength(0);
  expect(mock.state.closed).toBe(true);
  expect(publicRunPassed(report)).toBe(false);
});

test("individual site errors preserve evidence and allow the remaining sites to run", async () => {
  const mock = mockConnection(({ name, args }) => name === "camofox_snapshot" && args.tabId === id(2) ? failure("Site unavailable.") : undefined);
  const report = await run(mock);
  expect(report.results.map(site => site.status)).toEqual(["PASS", "ERROR", "PASS", "PASS"]);
  expect(report.results[1]!.errors).toContain("Site unavailable.");
  expect(report.stopped).toBe(true);
  expect(report.released).toBe(true);
  expect(mock.state.opened).toHaveLength(4);
  expect(mock.state.stops).toHaveLength(1);
  expect(mock.state.phase).toBe("stopped");
  expect(mock.state.calls.some(call => call.name === "profile_release")).toBe(false);
  expect(publicRunPassed(report)).toBe(false);
});

test.each(["blocked", "verification_failed"])("a %s service stops new browser actions and is shut down", async phase => {
  const mock = mockConnection(({ name }, state) => {
    if (name === "camofox_snapshot") { state.phase = phase; return failure("Service action deadline exceeded."); }
  });
  const report = await run(mock);
  expect(report.results.map(site => site.status)).toEqual(["ERROR", "INCONCLUSIVE", "INCONCLUSIVE", "INCONCLUSIVE"]);
  expect(mock.state.opened).toHaveLength(1);
  const failureIndex = mock.state.calls.findIndex(call => call.name === "camofox_snapshot");
  expect(mock.state.calls.slice(failureIndex + 1).every(call => call.name.startsWith("profile_"))).toBe(true);
  expect(report.stopped).toBe(true);
  expect(report.released).toBe(true);
  expect(report.finalInstanceId).toBe("original-browser");
  expect(mock.state.stops).toHaveLength(1);
  expect(mock.state.phase).toBe("stopped");
  expect(mock.state.calls.some(call => call.name === "profile_release")).toBe(false);
  expect(mock.state.closed).toBe(true);
  expect(publicRunPassed(report)).toBe(false);
});

test("a failed status request after an action failure prevents screenshot fallbacks", async () => {
  let actionFailed = false;
  const mock = mockConnection(({ name }) => {
    if (name === "camofox_snapshot") { actionFailed = true; return failure("Action failed."); }
    if (name === "profile_status" && actionFailed) throw Error("Status is unreachable.");
  });
  const report = await run(mock);
  expect(mock.state.calls.some(call => call.name === "camofox_screenshot")).toBe(false);
  expect(mock.state.opened).toHaveLength(1);
  expect(report.results[0]!.status).toBe("ERROR");
  expect(report.errors.join(" ")).toContain("Status is unreachable");
  expect(report.errors.some(error => error.startsWith("Stop: "))).toBe(true);
  expect(report.stopped).toBe(false);
  expect(report.released).toBe(true);
  expect(mock.state.stops).toHaveLength(0);
  expect(mock.state.events.slice(-2)).toEqual(["profile_release", "disconnect"]);
  expect(mock.state.closed).toBe(true);
});

test("an already stopped acquired lifetime is confirmed without another stop or release", async () => {
  const mock = mockConnection(({ name }, state) => {
    if (name === "camofox_snapshot") {
      state.phase = "stopped"; state.controllerHeld = false;
      return failure("The browser window was closed.");
    }
  });
  const report = await run(mock);
  expect(report.stopped).toBe(true);
  expect(report.released).toBe(true);
  expect(report.finalInstanceId).toBe("original-browser");
  expect(mock.state.stops).toHaveLength(0);
  expect(mock.state.calls.some(call => call.name === "profile_release")).toBe(false);
  expect(mock.state.closed).toBe(true);
  expect(publicRunPassed(report)).toBe(false);
});

test("late MCP responses are awaited but cannot pass the site deadline", async () => {
  let clock = 0;
  const mock = mockConnection(({ name, args }) => {
    if (name === "camofox_snapshot" && args.tabId === id(1)) clock += 10;
    return undefined;
  });
  const report = await run(mock, { now: () => clock, timeoutMs: 5 });
  expect(report.results[0]).toMatchObject({ status: "INCONCLUSIVE", observedVerdict: "PASS" });
  expect(report.results[0]!.reason).toContain("arrived after");
  expect(report.released).toBe(true);
});

test("tab creation time counts toward the site deadline", async () => {
  let clock = 0;
  const mock = mockConnection(({ name }) => { if (name === "camofox_create_tab") clock += 10; return undefined; });
  const report = await run(mock, { now: () => clock, timeoutMs: 5 });
  expect(report.results.every(site => site.status === "INCONCLUSIVE")).toBe(true);
  expect(mock.state.calls.some(call => call.name === "camofox_snapshot")).toBe(false);
  expect(report.released).toBe(true);
});

test("pagination omits repeated navigation tails before assessing a complete result", async () => {
  const mock = mockConnection(({ name, args }) => {
    if (name !== "camofox_snapshot" || args.tabId !== id(1)) return;
    return reply({ url: PUBLIC_SITES[0]!.url, snapshot: args.offset ? flightCards : flightHeading + '\n[truncated]\n- heading "Learn more"',
      hasMore: !args.offset, nextOffset: args.offset ? null : flightHeading.length });
  });
  const report = await run(mock);
  expect(report.results[0]!.status).toBe("PASS");
  expect(mock.state.calls.filter(call => call.name === "camofox_snapshot" && call.args.tabId === id(1)).map(call => call.args.offset)).toEqual([undefined, flightHeading.length, undefined, flightHeading.length]);
  expect(JSON.parse(readFileSync(report.results[0]!.snapshot!, "utf8")).pages).toHaveLength(2);
});

test("non-advancing pagination fails instead of reading indefinitely", async () => {
  const mock = mockConnection(({ name, args }) => name === "camofox_snapshot" && args.tabId === id(1)
    ? reply({ url: PUBLIC_SITES[0]!.url, snapshot: flightHeading, hasMore: true, nextOffset: 0 }) : undefined);
  const report = await run(mock);
  expect(report.results[0]!.status).toBe("ERROR");
  expect(report.results[0]!.reason).toContain("pagination did not advance");
  expect(mock.state.calls.filter(call => call.name === "camofox_snapshot" && call.args.tabId === id(1))).toHaveLength(1);
});

test("loading can resolve later, and stale loading screenshots cannot prove the final verdict", async () => {
  let observed = 0, clock = 0;
  const mock = mockConnection(({ name, args }) => {
    if (name === "camofox_snapshot" && args.tabId === id(1)) return reply({ url: PUBLIC_SITES[0]!.url,
      snapshot: ++observed === 1 ? flightHeading + "- text: Loading" : snapshots[0] }, observed === 1);
    if (name === "camofox_screenshot" && args.tabId === id(1)) return { content: [{ ...png, data: "not-a-png" }] };
  });
  const report = await run(mock, { now: () => clock, sleep: async ms => { clock += ms; }, pollMs: 10, timeoutMs: 30 });
  expect(observed).toBe(2);
  expect(report.results[0]).toMatchObject({ status: "ERROR", observedVerdict: "PASS" });
  expect(report.results[0]!.screenshot).toBeUndefined();
  expect(report.results[0]!.errors.join(" ")).toContain("invalid PNG bytes");
  expect(publicRunPassed(report)).toBe(false);
});

test("unfinished verdicts time out with evidence and do not become passes", async () => {
  let clock = 0;
  const mock = mockConnection(({ name, args }) => name === "camofox_snapshot" && args.tabId === id(1)
    ? reply({ url: PUBLIC_SITES[0]!.url, snapshot: flightHeading + "- text: Loading" }) : undefined);
  const report = await run(mock, { now: () => clock, sleep: async ms => { clock += ms; }, pollMs: 10, timeoutMs: 20 });
  expect(report.results[0]!.status).toBe("INCONCLUSIVE");
  expect(report.results[0]!.reason).toContain("No completed verdict within");
  expect(report.results[0]!.screenshot).toBeDefined();
  expect(report.results[3]!.status).toBe("PASS");
});

test("unexpected redirects and disabled detector URLs cannot pass", async () => {
  let clock = 0;
  const mock = mockConnection(({ name, args }) => name === "camofox_snapshot" && args.tabId === id(1)
    ? reply({ url: PUBLIC_SITES[0]!.url + "?disableBotDetection=1", snapshot: snapshots[0] }) : undefined);
  const report = await run(mock, { now: () => clock, sleep: async ms => { clock += ms; }, timeoutMs: 1, pollMs: 1 });
  expect(report.results[0]!.status).toBe("INCONCLUSIVE");
  expect(report.results[0]!.reason).toContain("Unexpected final URL");
});

function challengeMock() {
  return mockConnection(({ name, args }, state) => name === "camofox_snapshot" && args.tabId === id(1) && !state.humanDone
    ? reply({ url: PUBLIC_SITES[0]!.url, snapshot: '- heading "Verify you are human" [level=1]\n- button "Verify"' }) : undefined);
}
test("human confirmation pauses and resumes the same profile before a fresh observation", async () => {
  const mock = challengeMock();
  const report = await run(mock, { confirmHuman: async () => {
    expect(mock.state.phase).toBe("paused");
    expect(mock.state.controllerHeld).toBe(true);
    expect(mock.state.stops).toHaveLength(0);
    mock.state.humanDone = true; return true;
  } });
  expect(publicRunPassed(report)).toBe(true);
  const names = mock.state.calls.map(call => call.name), resume = names.indexOf("profile_resume");
  expect(resume).toBeGreaterThan(names.indexOf("profile_pause"));
  expect(names[resume + 1]).toBe("profile_status");
  expect(names[resume + 2]).toBe("camofox_snapshot");
  expect(report.stopped).toBe(true);
  expect(mock.state.phase).toBe("stopped");
});

test.each(["ended", "interrupted"])("unconfirmed authentication stays paused while waiting and stops when %s", async ending => {
  const mock = challengeMock(), abort = new AbortController();
  let entered!: () => void, finish!: (confirmed: boolean) => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const confirmation = new Promise<boolean>(resolve => { finish = resolve; });
  const running = run(mock, { signal: abort.signal, confirmHuman: async () => { entered(); return confirmation; } });
  await waiting;
  expect(mock.state.phase).toBe("paused");
  expect(mock.state.controllerHeld).toBe(true);
  expect(mock.state.closed).toBe(false);
  expect(mock.state.stops).toHaveLength(0);
  if (ending === "interrupted") abort.abort("SIGINT");
  finish(false);
  const report = await running;
  expect(report.results[0]!.status).toBe("INCONCLUSIVE");
  expect(report.results[0]!.reason).toContain("The run ended before authentication was confirmed.");
  expect(mock.state.phase).toBe("stopped");
  expect(mock.state.calls.some(call => call.name === "profile_resume")).toBe(false);
  expect(mock.state.calls.some(call => call.name === "profile_release")).toBe(false);
  expect(mock.state.opened).toHaveLength(1);
  expect(mock.state.stops).toHaveLength(1);
  expect(report.stopped).toBe(true);
  expect(report.released).toBe(true);
  expect(report.interrupted).toBe(ending === "interrupted" ? "SIGINT" : undefined);
  expect(mock.state.closed).toBe(true);
  expect(publicRunPassed(report)).toBe(false);
});

test("interrupts await in-flight operations and save reports before stopping the browser", async () => {
  const abort = new AbortController();
  const directory = outputDir();
  let inFlight = false;
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), pending = new Promise<void>(resolve => { finish = resolve; });
  const mock = mockConnection(async ({ name, args }) => {
    if (name === "camofox_snapshot" && args.tabId === id(1)) { inFlight = true; entered(); await pending; inFlight = false; }
    return undefined;
  });
  const running = run(mock, { signal: abort.signal, outputDir: directory, stop: async () => {
    expect(inFlight).toBe(false);
    expect(mock.state.controllerHeld).toBe(true);
    expect(savedReport(directory)).toMatchObject({ interrupted: "SIGINT", stopped: false, released: false });
    mock.state.phase = "stopped";
  } });
  await started; abort.abort("SIGINT");
  expect(inFlight).toBe(true);
  expect(mock.state.stops).toHaveLength(0);
  expect(mock.state.closed).toBe(false);
  expect(mock.state.calls.some(call => call.name === "profile_release")).toBe(false);
  finish();
  const report = await running;
  expect(report.interrupted).toBe("SIGINT");
  expect(report.results).toHaveLength(4);
  expect(report.stopped).toBe(true);
  expect(report.released).toBe(true);
  expect(mock.state.opened).toHaveLength(1);
  expect(mock.state.stops).toHaveLength(1);
  expect(mock.state.phase).toBe("stopped");
  expect(mock.state.calls.some(call => call.name === "profile_release")).toBe(false);
  expect(mock.state.events.slice(-4)).toEqual(["profile_status", "stop", "profile_status", "disconnect"]);
  expect(savedReport(directory)).toEqual(report);
  expect(publicRunPassed(report)).toBe(false);
});

test.each(["command rejected", "still ready", "changed profile", "changed instance", "missing instance", "status unavailable"] as const)(
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
    if (outcome === "changed instance") mock.state.instanceId = "replacement-browser";
  } });
  expect(report.results.every(site => site.status === "PASS")).toBe(true);
  expect(report.finalInstanceId).toBe("original-browser");
  expect(report.stopped).toBe(false);
  expect(report.released).toBe(true);
  expect(report.errors.some(error => error.startsWith("Stop: "))).toBe(true);
  if (outcome === "command rejected") expect(report.errors).toContain("Stop: Explicit shutdown failed.");
  expect(mock.state.stops).toEqual([{ profile: "test", home: report.serviceHome }]);
  expect(mock.state.calls.filter(call => call.name === "profile_release")).toHaveLength(1);
  expect(mock.state.events.slice(-2)).toEqual(["profile_release", "disconnect"]);
  expect(mock.state.closed).toBe(true);
  expect(savedReport(report.outputDir)).toEqual(report);
  expect(publicRunPassed(report)).toBe(false);
});

test("cleanup disconnects and records both failures when stop and fallback release fail", async () => {
  const mock = mockConnection(({ name }) => name === "profile_release" ? failure("Release failed.") : undefined);
  const report = await run(mock, { stop: async () => { throw Error("Explicit shutdown failed."); } });
  expect(report.errors).toContain("Stop: Explicit shutdown failed.");
  expect(report.errors).toContain("Release: Release failed.");
  expect(report.stopped).toBe(false);
  expect(report.released).toBe(false);
  expect(mock.state.stops).toHaveLength(1);
  expect(mock.state.events.slice(-3)).toEqual(["stop", "profile_release", "disconnect"]);
  expect(mock.state.closed).toBe(true);
  expect(savedReport(report.outputDir)).toEqual(report);
  expect(publicRunPassed(report)).toBe(false);
});

test("disappeared original tabs fail the run before shutdown", async () => {
  let listings = 0;
  const mock = mockConnection(({ name }, state) => {
    if (name === "camofox_list_tabs" && ++listings > 1) return reply({ tabs: state.opened.map(tabId => ({ tabId })) });
  });
  const report = await run(mock);
  expect(report.errors.join(" ")).toContain("tab disappeared");
  expect(report.initialTabIds).toEqual([id(900)]);
  expect(report.finalTabIds).toEqual([id(1), id(2), id(3), id(4)]);
  expect(mock.state.events.lastIndexOf("camofox_list_tabs")).toBeLessThan(mock.state.events.indexOf("stop"));
  expect(report.stopped).toBe(true);
  expect(report.released).toBe(true);
  expect(mock.state.stops).toHaveLength(1);
  expect(mock.state.closed).toBe(true);
  expect(publicRunPassed(report)).toBe(false);
});

test("CLI arguments require one explicit profile", () => {
  expect(parsePublicArgs(["--profile", "profile-02"])).toEqual({ profile: "profile-02", help: false });
  expect(parsePublicArgs(["--help"]).help).toBe(true);
  for (const args of [[], ["--profile"], ["--profile", "../bad"], ["--profile", "first", "--profile", "second"], ["--unknown"]]) {
    expect(() => parsePublicArgs(args)).toThrow();
  }
});
