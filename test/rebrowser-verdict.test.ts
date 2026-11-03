import { describe, expect, test } from "bun:test";
import { assessRebrowser } from "./rebrowser-verdict.ts";

type Result = { type: string; rating?: unknown; note?: string; debug?: unknown; msSinceLoad?: number };

// Native JSON from .state/public-sites/2026-11-03T13-51-57-338Z-gyZa1G/rebrowser.snapshot.json.
// Captured on 2026-11-03 at 13:53:18.423Z. Keep this fixture independent of ignored local state.
const captured: Result[] = [
  {"type":"dummyFn","rating":0,"note":"Call <code>window.dummyFn()</code> to test if you can access main world objects.","msSinceLoad":1},
  {"type":"sourceUrlLeak","rating":0,"note":"Call <code>document.getElementById('detections-json')</code> to test sourceUrl leak.","msSinceLoad":1},
  {"type":"mainWorldExecution","rating":0,"note":"Call <code>document.getElementsByClassName('div')</code> to trigger this test. If you did and the test wasn't triggered, then you're running it in an isolated world, which is safe and not detectable.","msSinceLoad":1},
  {"type":"runtimeEnableLeak","rating":-1,"note":"No leak detected.","msSinceLoad":1},
  {"type":"exposeFunctionLeak","note":"No <code>window.exposedFn</code>. Use <code>page.exposeFunction</code> to trigger this test.","rating":0,"msSinceLoad":2},
  {"type":"navigatorWebdriver","rating":-1,"note":"No webdriver presented.","msSinceLoad":2},
  {"type":"viewport","rating":-1,"debug":{"width":1200,"height":800},"note":"Viewport is different from default values used in automation libraries.","msSinceLoad":8},
  {"type":"useragent","rating":0,"note":"Cannot detect Chrome version as navigator.userAgentData is undefined.","msSinceLoad":8},
  {"type":"pwInitScripts","rating":-1,"note":"No <code>window.__pwInitScripts</code> detected.","msSinceLoad":8},
  {"type":"platformMismatch","rating":-1,"note":"User agent, <code>navigator.platform</code> and client hints agree.","debug":{"userAgent":"Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:152.0) Gecko/20100101 Firefox/152.0","navigator.platform":"MacIntel","userAgentData.platform":null,"activeTextLight":"rgb(238, 0, 0)"},"msSinceLoad":10},
  {"type":"mobileEmulation","rating":-1,"note":"Desktop user agent, no mobile emulation detected.","msSinceLoad":11},
  {"type":"documentInterception","rating":0,"note":"Runs in Chromium-based browsers only.","msSinceLoad":11},
  {"type":"bypassCsp","rating":-1,"note":"Content Security Policy (CSP) is enabled, it's expected behavior.","msSinceLoad":182},
  {"type":"popupBlocking","rating":0.5,"note":"\n <div>A page script opened a popup without a click. Either popups are allowed for this site in the browser settings, or Chrome runs with <code>--disable-popup-blocking</code> (a Puppeteer and Playwright default).</div>\n <div>Use <a href=\"https://github.com/rebrowser/rebrowser-patches\" target=\"_blank\">rebrowser-patches</a> to fix it.</div>\n ","msSinceLoad":195},
  {"type":"ipcFloodingProtection","rating":1,"note":"\n <div>All 300 rapid <code>history.replaceState()</code> calls went through. Chrome ignores them after 200 within 10 seconds, unless it runs with <code>--disable-ipc-flooding-protection</code> (a Puppeteer and Playwright default).</div>\n <div>Use <a href=\"https://github.com/rebrowser/rebrowser-patches\" target=\"_blank\">rebrowser-patches</a> to fix it.</div>\n ","debug":{"applied":300},"msSinceLoad":271},
  {"type":"storagePartitioning","rating":0,"note":"Runs in Chromium-based browsers only (Safari shares this storage by design).","msSinceLoad":271},
  {"type":"cdpBindingGlobals","rating":-1,"note":"No unnamed native functions on <code>window</code>.","msSinceLoad":271},
  {"type":"headless","rating":-1,"note":"No signs of headless Chrome.","debug":{"userAgent":"Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:152.0) Gecko/20100101 Firefox/152.0","brands":[],"windowChrome":"undefined","notificationPermission":"default","notificationsQueryState":"prompt","anyPointer":["fine"],"screen":"1680x1050","plugins":5,"pdfViewerEnabled":true,"webglRenderer":"Apple M1, or similar"},"msSinceLoad":316},
  {"type":"nativeTampering","rating":-1,"note":"Native functions look untouched.","debug":{"tampered":{},"automationFrames":{},"iframeSharesRealm":false},"msSinceLoad":323},
  {"type":"workerConsistency","rating":-1,"note":"<code>navigator</code> in a Web Worker matches the page.","debug":{"main":{"userAgent":"Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:152.0) Gecko/20100101 Firefox/152.0","platform":"MacIntel","languages":["en-US","en"],"hardwareConcurrency":10},"worker":{"userAgent":"Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:152.0) Gecko/20100101 Firefox/152.0","platform":"MacIntel","languages":["en-US","en"],"hardwareConcurrency":10}},"msSinceLoad":348},
];

const automatic = [
  "navigatorWebdriver", "viewport", "pwInitScripts", "platformMismatch", "mobileEmulation",
  "bypassCsp", "popupBlocking", "nativeTampering", "workerConsistency",
];
const chromium = [
  "runtimeEnableLeak", "useragent", "documentInterception", "ipcFloodingProtection",
  "storagePartitioning", "cdpBindingGlobals", "headless",
];
const hooks = ["sourceUrlLeak", "mainWorldExecution", "exposeFunctionLeak"];
const title = '- heading "🕵️ rebrowser-bot-detector" [level=1]';
const area = (value: unknown) => `- heading "JSON" [level=3]\n- textbox [e4]: ${JSON.stringify(JSON.stringify(value))}`;
const page = (value: unknown = captured) => `${title}\n${area(value)}`;
const change = (name: string, update: Partial<Result>) => captured.map(result => result.type === name ? { ...result, ...update } : result);

test("scores the captured native Camoufox JSON with explicit partial coverage", () => {
  const result = assessRebrowser(page());
  expect(result.verdict).toBe("PASS");
  expect(result.reason).toContain("9 applicable checks completed (8 clear, 1 advisory, 0 detection)");
  expect(result.reason).toContain("Partial coverage: 11 probes skipped");
  expect(result.warnings).toHaveLength(1);
  expect(result.warnings![0]).toContain("popupBlocking: A page script opened a popup without a click.");
  expect(result.details.popupBlocking).toContain("WARNING; native 🟡 rating=0.5");
  expect(result.details.ipcFloodingProtection).toContain("SKIPPED; native 🔴 rating=1");
  expect(result.details.ipcFloodingProtection).toContain("Firefox rate limits differ");
  expect(result.details.headless).toContain("does not verify Firefox headless behavior");
  expect(result.details.platformMismatch).toContain("Chromium client hints and color checks are not verified");
  for (const name of [...chromium, ...hooks, "dummyFn"]) expect(result.details[name]).toStartWith("SKIPPED;");
  expect(Object.keys(result.details)).toHaveLength(21);
});

describe("applicable native ratings", () => {
  for (const name of automatic) {
    test(`${name}: native green passes and native red fails`, () => {
      const clear = assessRebrowser(page(change(name, { rating: -1, note: "No detection." })));
      expect(clear.verdict).toBe("PASS");
      expect(clear.details[name]).toContain("PASS; native 🟢 rating=-1");
      const detected = assessRebrowser(page(change(name, { rating: 1, note: "Native detection." })));
      expect(detected.verdict).toBe("FAIL");
      expect(detected.details[name]).toContain("FAIL; native 🔴 rating=1");
    });

    test(`${name}: native yellow is a nonfatal warning`, () => {
      const result = assessRebrowser(page(change(name, { rating: 0.5, note: "A native advisory." })));
      expect(result.verdict).toBe("PASS");
      expect(result.warnings).toContain(`${name}: A native advisory.`);
      expect(result.details[name]).toContain("WARNING; native 🟡 rating=0.5");
    });
  }

  test("has no warnings when every applicable check is green", () => {
    const result = assessRebrowser(page(change("popupBlocking", { rating: -1, note: "Popups without a click are blocked, as in a normal browser." })));
    expect(result.verdict).toBe("PASS");
    expect(result.warnings).toBeUndefined();
  });

  for (const rating of [undefined, null, 0, "-1", "pass", "pending", "unknown", 0.25, -2, 2, false]) {
    test(`missing, pending, or unknown rating ${JSON.stringify(rating)} is inconclusive`, () => {
      const result = assessRebrowser(page(change("workerConsistency", { rating, note: "The test failed to run." })));
      expect(result.verdict).toBe("INCONCLUSIVE");
      expect(result.details.workerConsistency).toStartWith("UNVERIFIED;");
      expect(result.details.workerConsistency).toContain(`rating=${JSON.stringify(rating) ?? "missing"}`);
    });
  }

  for (const name of automatic) {
    test(`missing ${name} is inconclusive`, () => {
      const result = assessRebrowser(page(captured.filter(result => result.type !== name)));
      expect(result.verdict).toBe("INCONCLUSIVE");
      expect(result.details[name]).toContain("native result missing");
    });
  }

  test("an applicable detection fails even when another applicable check is missing", () => {
    const result = assessRebrowser(page(change("navigatorWebdriver", { rating: 1 }).filter(result => result.type !== "workerConsistency")));
    expect(result.verdict).toBe("FAIL");
  });
});

describe("skipped probes and optional hooks", () => {
  for (const name of chromium) {
    test(`${name} never becomes an applicable pass or failure`, () => {
      for (const rating of [-1, 0, 0.5, 1]) {
        const result = assessRebrowser(page(change(name, { rating })));
        expect(result.verdict).toBe("PASS");
        expect(result.details[name]).toStartWith("SKIPPED;");
        expect(result.details[name]).toContain(`rating=${rating}`);
        if (rating === 0.5) expect(result.warnings!.some(warning => warning.startsWith(`${name}:`))).toBe(true);
      }
    });
  }

  for (const name of hooks) {
    test(`${name}: explicit untriggered notes cannot count as a pass`, () => {
      const result = assessRebrowser(page(change(name, { rating: -1 })));
      expect(result.verdict).toBe("PASS");
      expect(result.details[name]).toContain("SKIPPED; native 🟢 rating=-1");
      expect(result.details[name]).toContain("was not triggered");
    });

    test(`${name}: completed hooks use native ratings without triggering probes`, () => {
      for (const rating of [-1, 0.5, 1]) {
        const result = assessRebrowser(page(change(name, { rating, note: "The hook completed." })));
        expect(result.verdict).toBe(rating === 1 ? "FAIL" : "PASS");
        expect(result.details[name]).toStartWith(rating === 1 ? "FAIL;" : rating === 0.5 ? "WARNING;" : "PASS;");
      }
      expect(assessRebrowser(page(change(name, { rating: 0, note: "Loading the hook result." }))).verdict).toBe("INCONCLUSIVE");
    });
  }

  test("the nine automatic checks suffice and absent hooks remain unverified", () => {
    const result = assessRebrowser(page(captured.filter(result => automatic.includes(result.type))));
    expect(result.verdict).toBe("PASS");
    expect(result.reason).toContain("Partial coverage: 11 probes skipped");
    for (const name of hooks) expect(result.details[name]).toContain("native result missing");
  });

  test("no applicable completed coverage is inconclusive", () => {
    for (const detections of [[], captured.filter(result => !automatic.includes(result.type))]) {
      const result = assessRebrowser(page(detections));
      expect(result.verdict).toBe("INCONCLUSIVE");
      expect(result.details.coverage).toContain("0 applicable checks completed");
    }
  });
});

describe("native result boundaries", () => {
  test("ignores unrelated JSON and code before the actual JSON area", () => {
    const example = JSON.stringify(change("navigatorWebdriver", { rating: 1 }));
    const snapshot = `${title}\n- textbox "Example results": ${JSON.stringify(example)}\n- code: ${JSON.stringify(example)}\n${area(captured)}`;
    expect(assessRebrowser(snapshot).verdict).toBe("PASS");
  });

  test("does not accept bare JSON, arbitrary text, or another page's JSON", () => {
    for (const snapshot of [JSON.stringify(captured), `- text: ${JSON.stringify(JSON.stringify(captured))}`, area(captured),
      `- heading "Other detector" [level=1]\n${area(captured)}`, `${title}\n- textbox: ${JSON.stringify(JSON.stringify(captured))}`]) {
      expect(assessRebrowser(snapshot).verdict).toBe("INCONCLUSIVE");
    }
  });

  test("ignores help sections, example regions, and ARIA-like text inside literal scalars", () => {
    for (const snapshot of [
      `${title}\n- heading "Example results" [level=2]\n${area(captured)}`,
      `${title}\n- heading "How to properly run the tests?" [level=2]\n${area(captured)}`,
      `${title}\n- region "Sample results":\n${area(captured).replace(/^/gm, "  ")}`,
      `${title}\n- code:\n${area(captured).replace(/^/gm, "  ")}`,
      `- paragraph: |\n${page().replace(/^/gm, "  ")}`,
      `${title}\n- contentinfo:\n${area(captured).replace(/^/gm, "  ")}`,
    ]) expect(assessRebrowser(snapshot).verdict).toBe("INCONCLUSIVE");
  });

  test("accepts the native JSON textarea as a YAML literal or single-quoted scalar", () => {
    const json = JSON.stringify(captured, null, 2);
    expect(assessRebrowser(`${title}\n- heading "JSON" [level=3]\n- textbox [e4]: |-\n${json.replace(/^/gm, "  ")}`).verdict).toBe("PASS");
    expect(assessRebrowser(`${title}\n- heading "JSON" [level=3]\n- textbox [e4]: '${JSON.stringify(captured).replace(/'/g, "''")}'`).verdict).toBe("PASS");
  });

  test("malformed, busy, ambiguous, or non-array JSON is inconclusive", () => {
    for (const snapshot of [page().replace("[e4]", "[e4] [busy]"), `${page()}\n${area(captured)}`,
      `${title}\n- heading "JSON" [level=3]\n- textbox: "not JSON"`, page({ detections: captured }), page([null]), page([{}])]) {
      expect(assessRebrowser(snapshot).verdict).toBe("INCONCLUSIVE");
    }
  });

  test("unknown probes and duplicate results cannot silently pass", () => {
    const unknown = assessRebrowser(page([...captured, { type: "futureProbe", rating: -1, note: "No leak." }]));
    expect(unknown.verdict).toBe("INCONCLUSIVE");
    expect(unknown.details.futureProbe).toContain("Probe applicability is unknown");
    expect(assessRebrowser(page([...captured, captured[5]!])).verdict).toBe("INCONCLUSIVE");
    expect(assessRebrowser(page([...captured, { type: "navigatorWebdriver", rating: 1, note: "Automation detected." }])).verdict).toBe("FAIL");
  });
});
