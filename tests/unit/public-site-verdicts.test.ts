import { describe, expect, test } from "bun:test";
import { assessSite, detectHumanChallenge, type Assessment, type SiteId } from "../helpers/public-site-verdicts.ts";
import { assessRebrowser } from "../helpers/rebrowser-verdict.ts";

const signalNames = [
  "Incognito Mode", "Bot", "VPN", "Browser Tampering", "Developer Tools", "Virtual Machine",
  "Privacy Settings", "IP Blocklist", "Proxy Detection", "High-Activity Device", "Rare Device",
];
const heading = (name: string, level = 2) => `- heading ${JSON.stringify(name)} [level=${level}]`;
const row = (label: string, value: string) => `- row ${JSON.stringify(`${label} ${value}`)}:\n  - cell ${JSON.stringify(label)}\n  - cell ${JSON.stringify(value)}`;
const verdict = (site: SiteId, snapshot: string) => assessSite(site, snapshot).verdict;
function playground(overrides: Record<string, string> = {}, omit: string[] = []): string {
  return [heading("SMART SIGNALS", 3), ...signalNames.filter(name => !omit.includes(name)).map(name => row(name, overrides[name] ?? "Not detected"))].join("\n");
}
const signals = (overrides: Record<string, string> = {}, omit: string[] = []) => verdict("fingerprint-playground", playground(overrides, omit));
const flight = `- group:
  - text: Departure
  - text: London 08:10
  - text: Arrival
  - text: Paris 10:30
  - text: Price per adult
  - text: €120.50
  - text: Total
  - text: €241.00`;
const flights = (content = flight) => `${heading("Search for today’s flights")}\n${content}\n${heading("Learn more")}`;
const scraping = (snapshot: string) => verdict("fingerprint-web-scraping", snapshot);
const pixelValues: Record<string, string> = {
  Browser: "Chrome 156.0.0.0 on Mac OS", Location: "Georgia / Okroq’ana", Proxy: "No proxy detected",
  Fingerprint: "No masking detected", Bot: "No automated behavior detected",
};
function pixelscan(overrides: Record<string, string> = {}, headline = "Your Browser Fingerprint is consistent", omit: string[] = []): string {
  return [heading("Fingerprint Scan"), heading(headline, 3),
    ...Object.entries({ ...pixelValues, ...overrides }).filter(([name]) => !omit.includes(name)).map(([name, value]) => `- generic: ${name}\n- generic: ${value}`),
    heading("What Websites See About You"),
  ].join("\n");
}
// The native page lists each value before its label.
function nativePixelscan(overrides: Record<string, string> = {}): string {
  return [heading("Fingerprint Scan", 1), "- text: Your Browser Fingerprint is consistent", '- generic "Fingerprint checks":',
    ...Object.entries({ ...pixelValues, ...overrides }).flatMap(([label, value]) => [`  - text: ${value}`, `  - text: ${label === "Bot" ? "Bot check" : label}`]),
    heading("What Websites See About You"),
  ].join("\n");
}
const pixel = (snapshot: string) => verdict("pixelscan", snapshot);
const sites: SiteId[] = ["fingerprint-web-scraping", "fingerprint-playground", "pixelscan", "rebrowser"];

test("the native low-confidence residential-proxy flag is advisory", () => {
  const warning = "Your IP is used by a residential proxy (confidence: low, ML score: 0.731)";
  const result = assessSite("fingerprint-playground", playground({ "Proxy Detection": warning }));
  expect(result.verdict).toBe("PASS");
  expect(result.details["Proxy Detection"]).toBe(warning);
  expect(result.warnings).toEqual(["Proxy Detection: " + warning]);
  expect(signals({ "Proxy Detection": warning, Bot: "You are a bot" })).toBe("FAIL");
  expect(signals({ "Proxy Detection": warning.replace("low", "medium") })).toBe("FAIL");
  expect(signals({ "Proxy Detection": warning }, ["Bot"])).toBe("INCONCLUSIVE");
  expect(signals({ "Proxy Detection": "Unknown proxy result" })).toBe("INCONCLUSIVE");
});

describe("flight results", () => {
  test("accepts every native card shape", () => {
    const result = assessSite("fingerprint-web-scraping", flights());
    expect(result.verdict).toBe("PASS");
    expect(result.details.Total).toBe("€241.00");
    const native = "- text: Departure November 3, 2026 United SFO San Francisco 11:05 AM JFK New York 06:20 PM Arrival November 8, 2026 Price per adult $ 289 Total $ 598";
    for (const snapshot of [
      flights().replace("today’s", "today's"),
      flights(`- article:\n  - paragraph: Departure: TBS 09:00\n  - paragraph: Arrival: CDG 13:00\n  - paragraph: Price per adult: USD 299.00\n  - paragraph: Total: 598.00 USD`),
      flights(`- listitem "Departure TBS 09:00 Arrival CDG 13:00 Price per adult $299 Total $598"`),
      flights(`- group:\n  - text: Departure London\n  - text: Arrival Paris\n  - text: Price per adult $120\n  - text: Total $240`),
      flights(native), flights(native.replace("- text:", "- generic:")),
    ]) expect(scraping(snapshot)).toBe("PASS");
  });

  test("fails explicit native results and reports operational errors", () => {
    for (const message of ["You are a bot", "Browser tampering detected", "Access denied: automated request"]) {
      const result = assessSite("fingerprint-web-scraping", flights(`- alert: ${message}\n${flight}`));
      expect(result.verdict).toBe("FAIL");
      expect(result.details.result).toBe(message);
    }
    for (const message of ["Network error", "Failed to load flights", "Request timed out", "Error: failed to search flights"]) {
      expect(scraping(flights(`- alert: ${message}`))).toBe("ERROR");
    }
  });

  test("ignores explanatory help and sample JSON", () => {
    const help = `${heading("Flight demo")}\n- paragraph: Bot detected means a request was blocked.\n- code: '{"result":"You are a bot"}'\n${flights()}\n- paragraph: Access denied\n- paragraph: Network error`;
    expect(scraping(help)).toBe("PASS");
    expect(scraping(flights(`- paragraph: Bot detected means the check failed.\n${flight}`))).toBe("PASS");
    expect(scraping(`${heading("About flights")}\n${flight}`)).toBe("INCONCLUSIVE");
    expect(scraping(flights(`- paragraph: If you are a bot, access is denied.\n- code: '{"Departure":"London","Arrival":"Paris","Price per adult":"$12","Total":"$24"}'`))).toBe("INCONCLUSIVE");
  });

  test("stays inconclusive for incomplete, uncombined, loading, or misplaced cards and uses the latest result section", () => {
    const native = "- text: Departure November 3, 2026 United SFO San Francisco 11:05 AM JFK New York 06:20 PM Arrival November 8, 2026 Price per adult $ 289 Total $ 598";
    for (const card of [
      flight.replace("  - text: Total\n  - text: €241.00", ""),
      flight.replace("€120.50", "Loading..."),
      flight.replace("€120.50", "120.50").replace("€241.00", "241.00"),
      `- row "Departure Arrival Price per adult Total":\n  - columnheader "Departure"\n  - columnheader "Arrival"\n  - columnheader "Price per adult"\n  - columnheader "Total"`,
      `- text: Departure\n- text: Arrival\n- text: Price per adult\n- text: Total`,
      `- group:\n  - text: Departure: London\n  - text: Arrival: Paris\n- group:\n  - text: Departure: Rome\n  - text: Price per adult: $120\n  - text: Total: $240`,
      `- group:\n  - text: Departure: London\n  - text: Arrival: Paris\n  - text: Price per adult: $120\n- group:\n  - text: Total: $240`,
      native.replace("- text: Departure", "- text: Example: Departure"), native.replace("- text:", "- code:"),
      `- status: Loading...\n${flight}`,
    ]) expect(scraping(flights(card))).toBe("INCONCLUSIVE");
    expect(scraping(`${flights()}\n${flights("- status: Loading...")}`)).toBe("INCONCLUSIVE");
    expect(scraping(`${flights("- status: Loading...")}\n${flights()}`)).toBe("PASS");
  });
});

describe("desktop SMART SIGNALS", () => {
  test("passes only with all 11 clear binary rows, including native decorations", () => {
    const result = assessSite("fingerprint-playground", playground({ Bot: "You are not a bot", VPN: "No", "Rare Device": "false" }));
    expect(result.verdict).toBe("PASS");
    expect(Object.keys(result.details)).toHaveLength(11);
    expect(signals({ Bot: "✅ Not detected", VPN: "No ✓" })).toBe("PASS");
    expect(signals({ "Developer Tools": "Yes 🔧" })).toBe("FAIL");
    expect(signals({ "Developer Tools": "Maybe 🔧" })).toBe("INCONCLUSIVE");
  });

  test("fails a native detection for every signal and every positive flag", () => {
    for (const name of signalNames) expect(signals({ [name]: "Yes" })).toBe("FAIL");
    for (const value of ["Detected", "You are a bot", "Bot detected", "true"]) expect(signals({ Bot: value })).toBe("FAIL");
    expect(signals({ Bot: "Detected" }, ["VPN"])).toBe("FAIL");
    expect(verdict("fingerprint-playground", `${playground()}\n${row("Bot", "Yes")}`)).toBe("FAIL");
  });

  test("recognizes the native VPN result and keeps its wording scoped", () => {
    const value = "You are using a VPN 🌐 (timezone mismatch)";
    for (const text of ["You are using a VPN", value]) {
      const result = assessSite("fingerprint-playground", playground({ VPN: text }));
      expect(result.verdict).toBe("FAIL");
      expect(result.reason).toBe("VPN reports detection.");
      expect(result.details.VPN).toBe(text);
    }
    for (const text of ["You are not using a VPN", `${value} (example)`, "You are using a VPN (unknown reason)"]) expect(signals({ VPN: text })).toBe("INCONCLUSIVE");
    expect(signals({ Bot: value })).toBe("INCONCLUSIVE");
    expect(verdict("fingerprint-playground", `${playground()}\n${heading("How to use this demo")}\n${row("VPN", value)}`)).toBe("PASS");
  });

  test("does not pass when a signal is absent or its value is unknown", () => {
    for (const name of signalNames) {
      const result = assessSite("fingerprint-playground", playground({}, [name]));
      expect(result.verdict).toBe("INCONCLUSIVE");
      expect(result.details.missingSignals).toContain(name);
    }
    for (const value of ["Unknown", "Loading...", "Low risk", "", "Not detected (example)"]) {
      const result = assessSite("fingerprint-playground", playground({ Bot: value }));
      expect(result.verdict).toBe("INCONCLUSIVE");
      expect(result.details.unknownSignals).toContain("Bot");
    }
  });

  test("handles row names, nested cells, YAML key quoting, refs, and whitespace", () => {
    const named = [heading("  SMART   SIGNALS  ", 3), ...signalNames.map(name => `  - row ${JSON.stringify(`${name.replace("-", "‑")}  |  No`)} [ref=e12]`)].join("\r\n");
    const cells = [heading("SMART SIGNALS", 3), ...signalNames.map(name => `- row:\n  - cell:\n    - text: ${name}\n  - cell:\n    - generic: Not detected`)].join("\n");
    const quotedRows = [heading("SMART SIGNALS", 3), ...signalNames.map(name => `- 'row "${name}: Not detected"':`)].join("\n");
    for (const snapshot of [named, cells, quotedRows]) expect(verdict("fingerprint-playground", snapshot)).toBe("PASS");
    // Result cells count, not aggregate row help.
    expect(verdict("fingerprint-playground", playground().replace('row "Bot Not detected"', 'row "Bot Not detected You are a bot means automation was found"'))).toBe("PASS");
  });

  test.each(["MOBILE SMART SIGNALS", "How to use this demo", "JSON responses"])("stops at %s", boundary => {
    expect(verdict("fingerprint-playground", `${playground()}\n${heading(boundary, 3)}\n${row("Bot", "You are a bot")}\n${row("VPN", "Yes")}`)).toBe("PASS");
    expect(verdict("fingerprint-playground", `${playground({}, ["Bot"])}\n${heading(boundary, 3)}\n${row("Bot", "No")}`)).toBe("INCONCLUSIVE");
  });

  test("keeps informational signals and help separate and does not pass loading, busy, or mixed snapshots", () => {
    const extras = [row("Suspect Score", "100"), row("Identification confidence", "0.1"), row("Geolocation", "Denied"), row("Velocity", "High"), row("Visitor ID", "bot-detected")].join("\n");
    expect(verdict("fingerprint-playground", `${heading("About this demo")}\n${row("Bot", "Detected")}\n${playground()}\n${extras}\n- paragraph: Bot detection reports Yes if you are a bot.\n- code: '{"bot":{"result":"Detected"}}'`)).toBe("PASS");
    for (const snapshot of [
      `${heading("SMART SIGNALS", 3)}\n- paragraph: Bot Not detected\n- code: '{"Bot":"No"}'`,
      `${playground()}\n${playground({}, ["Rare Device"])}`,
      `${playground()}\n- status: Loading...`,
      playground().replace('row "Bot Not detected":', 'row "Bot Not detected" [busy]:'),
    ]) expect(verdict("fingerprint-playground", snapshot)).toBe("INCONCLUSIVE");
  });
});

describe("Pixelscan summary", () => {
  test("accepts the native completed summary in every layout", () => {
    const result = assessSite("pixelscan", pixelscan());
    expect(result.verdict).toBe("PASS");
    expect(result.details.Location).toBe("Georgia / Okroq'ana");
    expect(assessSite("pixelscan", nativePixelscan()).details.Bot).toBe("No automated behavior detected");
    const summaryRows = `${heading("Fingerprint Scan")}\n- status: Your Browser Fingerprint is consistent\n${Object.entries(pixelValues).map(([label, value]) => row(label, value)).join("\n")}\n${heading("FAQ")}`;
    for (const snapshot of [summaryRows, pixelscan().replace("- generic: Bot\n", "- generic: Bot check\n"), pixelscan().replace("- generic: Browser\n- generic:", "- generic: Browser:")]) expect(pixel(snapshot)).toBe("PASS");
    for (const Location of ["Georgia / Okroqʼana", "Georgia / თბილისი · ოქროყანა"]) expect(pixel(nativePixelscan({ Location }))).toBe("PASS");
    for (const Browser of ["Firefox 144.0 on Linux", "Safari 18.1 on iOS", "Microsoft Edge 156.0.0.0 on Windows 11"]) expect(pixel(pixelscan({ Browser }))).toBe("PASS");
  });

  test.each([
    ["Browser", "Browser mismatch detected", "FAIL"], ["Location", "Location is inconsistent", "FAIL"],
    ["Proxy", "Proxy detected", "FAIL"], ["Proxy", "VPN detected", "FAIL"], ["Fingerprint", "Masking detected", "FAIL"],
    ["Bot", "Automated behavior detected", "FAIL"], ["Bot", "Bot detected", "FAIL"],
    ["Browser", "Loading...", "INCONCLUSIVE"], ["Browser", "Unknown browser", "INCONCLUSIVE"], ["Browser", "Chrome 156.0.0.0 on Unknown", "INCONCLUSIVE"],
    ["Location", "Unknown / Unknown", "INCONCLUSIVE"], ["Location", "Georgia /", "INCONCLUSIVE"],
    ["Proxy", "Loading...", "INCONCLUSIVE"], ["Fingerprint", "Checking...", "INCONCLUSIVE"],
    ["Bot", "Unknown", "INCONCLUSIVE"], ["Bot", "Maybe human", "INCONCLUSIVE"], ["Bot", "", "INCONCLUSIVE"],
  ] as const)("assesses %s value %j as %s in both layouts", (label, value, expected) => {
    expect(pixel(pixelscan({ [label]: value }))).toBe(expected);
    expect(pixel(nativePixelscan({ [label]: value }))).toBe(expected);
  });

  test("fails a negative headline or summary warning and requires every check", () => {
    for (const headline of ["Your Browser Fingerprint is inconsistent", "Your Browser Fingerprint is not consistent", "Your Browser Fingerprint is suspicious"]) expect(pixel(pixelscan({}, headline))).toBe("FAIL");
    expect(pixel(pixelscan().replace(heading("What Websites See About You"), `- alert: Warning: fingerprint mismatch\n${heading("What Websites See About You")}`))).toBe("FAIL");
    for (const label of Object.keys(pixelValues)) expect(pixel(pixelscan({}, undefined, [label]))).toBe("INCONCLUSIVE");
  });

  test("requires the consistent headline and completed loading state", () => {
    expect(pixel(pixelscan({}, "Scanning..."))).toBe("INCONCLUSIVE");
    expect(pixel(pixelscan().replace(heading("Fingerprint Scan"), `${heading("Fingerprint Scan")}\n- status: Scanning...`))).toBe("INCONCLUSIVE");
    expect(pixel(`${pixelscan()}\n${heading("Fingerprint Scan")}\n- status: Loading...`)).toBe("INCONCLUSIVE");
  });

  test("ignores help, FAQ, and sample JSON verdicts", () => {
    const help = `\n- paragraph: Your Browser Fingerprint is inconsistent\n- paragraph: Proxy detected\n- code: '{"Bot":"Automated behavior detected"}'`;
    expect(pixel(pixelscan() + help)).toBe("PASS");
    expect(pixel(`${heading("Fingerprint Scan")}\n- code:\n  - text: Your Browser Fingerprint is consistent\n${heading("FAQ")}\n${Object.entries(pixelValues).map(([label, value]) => row(label, value)).join("\n")}`)).toBe("INCONCLUSIVE");
    expect(pixel(pixelscan().replace("- generic: No proxy detected", "- paragraph: The phrase No proxy detected means a direct connection."))).toBe("INCONCLUSIVE");
  });
});

describe("human challenges", () => {
  test("recognizes actual verification or authentication UI and keeps every site inconclusive", () => {
    for (const snapshot of [
      heading("Verify you are human"), heading("Authentication required"), `- checkbox "I'm not a robot"`, `- iframe "reCAPTCHA"`,
      `- generic: Verifying you are human. This may take a few seconds.`,
      `- form "Sign in":\n  - textbox "Email address"\n  - textbox "Password"\n  - button "Sign in"`,
      `${heading("Sign in")}\n- textbox "Email"\n- button "Continue"`,
      `- textbox "Verification code"\n- button "Verify"`,
    ]) {
      expect(detectHumanChallenge(snapshot)).toBeString();
      for (const site of sites) expect(verdict(site, snapshot)).toBe("INCONCLUSIVE");
    }
    const result = assessSite("fingerprint-playground", `${playground()}\n- dialog "Verify you are human"`);
    expect(result.verdict).toBe("INCONCLUSIVE");
    expect(result.details.challenge).toContain("Verify you are human");
  });

  test("ignores incidental challenge words and examples", () => {
    for (const snapshot of [
      `- paragraph: CAPTCHA and authentication help prevent bot traffic.`,
      `- link "CAPTCHA"\n- link "Authentication"\n- button "Sign in"`,
      `${heading("How CAPTCHA works")}\n- paragraph: Verify you are human when a challenge appears.`,
      `${heading("JSON responses")}\n- code: '{"heading":"Verify you are human"}'`,
      `${heading("FAQ")}\n${heading("Verify you are human", 3)}\n- paragraph: This is an example challenge.`,
      `- code:\n  - heading "Verify you are human" [level=1]`,
      `- text: |\n    - heading "Verify you are human" [level=1]\n    - checkbox "I'm not a robot"`,
      heading("Sign in"),
    ]) expect(detectHumanChallenge(snapshot)).toBeUndefined();
  });
});

test("empty or unrelated snapshots are inconclusive and keep the exported result contract", () => {
  for (const site of sites) {
    for (const snapshot of ["", `- heading "Unrelated page" [level=1]\n- paragraph: PASS`]) {
      const result: Assessment = assessSite(site, snapshot);
      expect(result.verdict).toBe("INCONCLUSIVE");
      expect(result.reason.length).toBeGreaterThan(0);
      expect(result.details).toEqual({});
    }
  }
});

describe("rebrowser native JSON", () => {
  type Result = { type: string; rating?: unknown; note?: string };
  const automatic = ["navigatorWebdriver", "viewport", "pwInitScripts", "platformMismatch", "mobileEmulation", "bypassCsp", "popupBlocking", "nativeTampering", "workerConsistency"];
  const chromium = ["runtimeEnableLeak", "useragent", "documentInterception", "ipcFloodingProtection", "storagePartitioning", "cdpBindingGlobals", "headless"];
  const hookNotes: Record<string, string> = {
    sourceUrlLeak: "Call <code>document.getElementById('detections-json')</code> to test sourceUrl leak.",
    mainWorldExecution: "Call <code>document.getElementsByClassName('div')</code> to trigger this test.",
    exposeFunctionLeak: "No <code>window.exposedFn</code>. Use <code>page.exposeFunction</code> to trigger this test.",
  };
  const hooks = Object.keys(hookNotes);
  // Shape of a native Camoufox run: Chromium-only probes and untriggered hooks are not applicable, one automatic check is advisory.
  const captured: Result[] = [
    { type: "dummyFn", rating: 0, note: "Call <code>window.dummyFn()</code> to test main world access." },
    ...hooks.map(type => ({ type, rating: 0, note: hookNotes[type] })),
    ...chromium.map(type => ({ type, rating: type === "ipcFloodingProtection" ? 1 : -1, note: "Chromium only." })),
    ...automatic.map(type => ({ type, rating: type === "popupBlocking" ? 0.5 : -1, note: type === "popupBlocking"
      ? "\n <div>A page script opened a popup without a click. Chrome runs with <code>--disable-popup-blocking</code>.</div>\n <div>Use <a href=\"https://example.invalid\">rebrowser-patches</a>.</div>\n " : "No detection." })),
  ];
  const title = '- heading "🕵️ rebrowser-bot-detector" [level=1]';
  const area = (value: unknown) => `- heading "JSON" [level=3]\n- textbox [e4]: ${JSON.stringify(JSON.stringify(value))}`;
  const page = (value: unknown = captured) => `${title}\n${area(value)}`;
  const change = (name: string, update: Partial<Result>) => captured.map(result => result.type === name ? { ...result, ...update } : result);
  const assess = (value: unknown) => assessRebrowser(page(value));
  const indent = (text: string) => text.replace(/^/gm, "  ");

  test("scores the native Camoufox JSON with explicit partial coverage", () => {
    const result = assess(captured);
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
    expect(assess(change("popupBlocking", { rating: -1 })).warnings).toBeUndefined();
  });

  test("applicable checks: native green passes, yellow warns, red fails, and missing results are inconclusive", () => {
    for (const name of automatic) {
      const clear = assess(change(name, { rating: -1, note: "No detection." }));
      expect(clear.verdict).toBe("PASS");
      expect(clear.details[name]).toContain("PASS; native 🟢 rating=-1");
      const detected = assess(change(name, { rating: 1, note: "Native detection." }));
      expect(detected.verdict).toBe("FAIL");
      expect(detected.details[name]).toContain("FAIL; native 🔴 rating=1");
      const advisory = assess(change(name, { rating: 0.5, note: "A native advisory." }));
      expect(advisory.verdict).toBe("PASS");
      expect(advisory.warnings).toContain(`${name}: A native advisory.`);
      expect(advisory.details[name]).toContain("WARNING; native 🟡 rating=0.5");
      const missing = assess(captured.filter(result => result.type !== name));
      expect(missing.verdict).toBe("INCONCLUSIVE");
      expect(missing.details[name]).toContain("native result missing");
    }
    expect(assess(change("navigatorWebdriver", { rating: 1 }).filter(result => result.type !== "workerConsistency")).verdict).toBe("FAIL");
  });

  test("missing, pending, or unknown ratings are inconclusive", () => {
    for (const rating of [undefined, null, 0, "-1", "pending", 0.25, 2, false]) {
      const result = assess(change("workerConsistency", { rating, note: "The test failed to run." }));
      expect(result.verdict).toBe("INCONCLUSIVE");
      expect(result.details.workerConsistency).toStartWith("UNVERIFIED;");
      expect(result.details.workerConsistency).toContain(`rating=${JSON.stringify(rating) ?? "missing"}`);
    }
  });

  test("skipped Chromium probes and untriggered hooks never become applicable passes or failures", () => {
    for (const name of chromium) {
      for (const rating of [-1, 0, 0.5, 1]) {
        const result = assess(change(name, { rating }));
        expect(result.verdict).toBe("PASS");
        expect(result.details[name]).toStartWith("SKIPPED;");
        expect(result.details[name]).toContain(`rating=${rating}`);
        if (rating === 0.5) expect(result.warnings!.some(warning => warning.startsWith(`${name}:`))).toBe(true);
      }
    }
    for (const name of hooks) {
      const untriggered = assess(change(name, { rating: -1 }));
      expect(untriggered.verdict).toBe("PASS");
      expect(untriggered.details[name]).toContain("SKIPPED; native 🟢 rating=-1");
      expect(untriggered.details[name]).toContain("was not triggered");
      for (const rating of [-1, 0.5, 1]) {
        const result = assess(change(name, { rating, note: "The hook completed." }));
        expect(result.verdict).toBe(rating === 1 ? "FAIL" : "PASS");
        expect(result.details[name]).toStartWith(rating === 1 ? "FAIL;" : rating === 0.5 ? "WARNING;" : "PASS;");
      }
      expect(assess(change(name, { rating: 0, note: "Loading the hook result." })).verdict).toBe("INCONCLUSIVE");
    }
  });

  test("the nine automatic checks suffice, absent hooks stay unverified, and no applicable coverage is inconclusive", () => {
    const result = assess(captured.filter(result => automatic.includes(result.type)));
    expect(result.verdict).toBe("PASS");
    for (const name of hooks) expect(result.details[name]).toContain("native result missing");
    for (const detections of [[], captured.filter(result => !automatic.includes(result.type))]) {
      const none = assess(detections);
      expect(none.verdict).toBe("INCONCLUSIVE");
      expect(none.details.coverage).toContain("0 applicable checks completed");
    }
  });

  test("reads only the actual JSON area of the detector page", () => {
    const example = JSON.stringify(change("navigatorWebdriver", { rating: 1 }));
    expect(assessRebrowser(`${title}\n- textbox "Example results": ${JSON.stringify(example)}\n- code: ${JSON.stringify(example)}\n${area(captured)}`).verdict).toBe("PASS");
    const json = JSON.stringify(captured, null, 2);
    expect(assessRebrowser(`${title}\n- heading "JSON" [level=3]\n- textbox [e4]: |-\n${indent(json)}`).verdict).toBe("PASS");
    expect(assessRebrowser(`${title}\n- heading "JSON" [level=3]\n- textbox [e4]: '${JSON.stringify(captured).replace(/'/g, "''")}'`).verdict).toBe("PASS");
    for (const snapshot of [
      JSON.stringify(captured), `- text: ${JSON.stringify(JSON.stringify(captured))}`, area(captured), `- heading "Other detector" [level=1]\n${area(captured)}`,
      `${title}\n- textbox: ${JSON.stringify(JSON.stringify(captured))}`,
      `${title}\n- heading "Example results" [level=2]\n${area(captured)}`,
      `${title}\n- heading "How to properly run the tests?" [level=2]\n${area(captured)}`,
      `${title}\n- region "Sample results":\n${indent(area(captured))}`, `${title}\n- code:\n${indent(area(captured))}`,
      `- paragraph: |\n${indent(page())}`, `${title}\n- contentinfo:\n${indent(area(captured))}`,
      page().replace("[e4]", "[e4] [busy]"), `${page()}\n${area(captured)}`, `${title}\n- heading "JSON" [level=3]\n- textbox: "not JSON"`,
      page({ detections: captured }), page([null]), page([{}]),
    ]) expect(assessRebrowser(snapshot).verdict).toBe("INCONCLUSIVE");
  });

  test("unknown probes and duplicate results cannot silently pass", () => {
    const unknown = assess([...captured, { type: "futureProbe", rating: -1, note: "No leak." }]);
    expect(unknown.verdict).toBe("INCONCLUSIVE");
    expect(unknown.details.futureProbe).toContain("Probe applicability is unknown");
    const webdriver = captured.find(result => result.type === "navigatorWebdriver")!;
    expect(assess([...captured, webdriver]).verdict).toBe("INCONCLUSIVE");
    expect(assess([...captured, { ...webdriver, rating: 1, note: "Automation detected." }]).verdict).toBe("FAIL");
  });
});
