import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// Run the installed memory-pressure timer with fake process readings and record which closers it calls.
const source = readFileSync(new URL("../../node_modules/@askjo/camofox-browser/server.js", import.meta.url), "utf8");
const start = source.indexOf("const MEM_PRESSURE_RESTART_COOLDOWN_MS"), end = source.indexOf("}, 30_000);", start) + "}, 30_000);".length;
if (start < 0 || end < start) throw Error("The memory-pressure timer no longer matches.");

async function tick(sessions: Map<string, object>) {
  const closed: string[] = [];
  let timer!: () => Promise<void>;
  runInNewContext(source.slice(start, end), {
    setInterval(callback: () => Promise<void>) { timer = callback; },
    browser: {}, sessions, _lastBrowserRestartAt: 0, _nativeMemBaseline: 0, process, Date,
    browserProcessTreeRssMb: () => 100_000, browserProcessNameRssMb: () => 100_000, _browserPid: () => 1,
    CONFIG: { browserRssRestartThresholdMb: 1500 }, NATIVE_MEM_RESTART_THRESHOLD_MB: 300, log() {},
    browserRestartsTotal: { labels: () => ({ inc() {} }) },
    async closeAllSessions() { closed.push("sessions"); }, async closeBrowserFully() { closed.push("browser"); },
  });
  await timer();
  return closed;
}

test("memory pressure never closes a browser that has a session", async () => {
  expect(await tick(new Map([["profile", {}]]))).toEqual([]);
});

test("memory pressure still restarts a browser that has no session", async () => {
  expect(await tick(new Map())).toEqual(["browser"]);
});
