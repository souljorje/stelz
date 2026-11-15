import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { NO_MEMORY_RESTART } from "../../src/profiles/config.ts";

// Run the installed memory-pressure timer with huge process readings and record which closers it calls.
// The timer reads its limits from the upstream configuration, so the test loads that with the supervisor limits.
// A "native" reading hides the browser size, so only the native-memory growth limit applies. That limit applies to an idle browser only.
const source = readFileSync(new URL("../../node_modules/@askjo/camofox-browser/server.js", import.meta.url), "utf8");
const { loadConfig } = await import(new URL("../../node_modules/@askjo/camofox-browser/lib/config.js", import.meta.url).href);
const start = source.indexOf("const MEM_PRESSURE_RESTART_COOLDOWN_MS"), end = source.indexOf("}, 30_000);", start) + "}, 30_000);".length;
if (start < 0 || end < start) throw Error("The memory-pressure timer no longer matches.");

function upstreamConfig(environment: Record<string, string>) {
  const names = ["BROWSER_RSS_RESTART_THRESHOLD_MB", "NATIVE_MEM_RESTART_THRESHOLD_MB"], previous = names.map(name => process.env[name]);
  try {
    for (const name of names) delete process.env[name];
    Object.assign(process.env, environment);
    return loadConfig();
  } finally { names.forEach((name, index) => previous[index] === undefined ? delete process.env[name] : process.env[name] = previous[index]); }
}

async function tick(sessions: Map<string, object>, environment: Record<string, string>, reading: "browser" | "native" = "browser") {
  const rss = () => reading === "browser" ? 1_000_000 : null, CONFIG = upstreamConfig(environment), closed: string[] = [];
  let timer!: () => Promise<void>;
  runInNewContext(source.slice(start, end), {
    setInterval(callback: () => Promise<void>) { timer = callback; },
    browser: {}, sessions, _lastBrowserRestartAt: 0, _nativeMemBaseline: 0, Date,
    process: { memoryUsage: () => ({ rss: 2 ** 40, heapUsed: 0 }) },
    browserProcessTreeRssMb: rss, browserProcessNameRssMb: rss, _browserPid: () => 1,
    CONFIG, NATIVE_MEM_RESTART_THRESHOLD_MB: CONFIG.nativeMemRestartThresholdMb, log() {},
    browserRestartsTotal: { labels: () => ({ inc() {} }) },
    async closeAllSessions() { closed.push("sessions"); }, async closeBrowserFully() { closed.push("browser"); },
  });
  await timer();
  return closed;
}

test("the supervisor limits keep upstream from restarting a browser at any memory reading", async () => {
  expect(await tick(new Map([["profile", {}]]), NO_MEMORY_RESTART)).toEqual([]);
  expect(await tick(new Map(), NO_MEMORY_RESTART)).toEqual([]);
  expect(await tick(new Map(), NO_MEMORY_RESTART, "native")).toEqual([]);
});

test("without the supervisor limits upstream restarts a browser under the same readings", async () => {
  expect(await tick(new Map([["profile", {}]]), {})).toEqual(["sessions", "browser"]);
  expect(await tick(new Map(), {})).toEqual(["browser"]);
  expect(await tick(new Map(), {}, "native")).toEqual(["browser"]);
});
