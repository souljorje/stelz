import { describe, expect, test } from "bun:test";
import { assessSite, detectHumanChallenge, type Assessment, type SiteId } from "./public-site-verdicts.ts";

const signalNames = [
  "Incognito Mode", "Bot", "VPN", "Browser Tampering", "Developer Tools", "Virtual Machine",
  "Privacy Settings", "IP Blocklist", "Proxy Detection", "High-Activity Device", "Rare Device",
];
const heading = (name: string, level = 2) => `- heading ${JSON.stringify(name)} [level=${level}]`;
const row = (label: string, value: string) => `- row ${JSON.stringify(`${label} ${value}`)}:\n  - cell ${JSON.stringify(label)}\n  - cell ${JSON.stringify(value)}`;
function playground(overrides: Record<string, string> = {}, omit: string[] = []): string {
  return [heading("SMART SIGNALS", 3), ...signalNames.filter(name => !omit.includes(name)).map(name => row(name, overrides[name] ?? "Not detected"))].join("\n");
}
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
const sites: SiteId[] = ["fingerprint-web-scraping", "fingerprint-playground", "pixelscan", "rebrowser"];

test("the native low-confidence residential-proxy flag is advisory", () => {
  const warning = "Your IP is used by a residential proxy (confidence: low, ML score: 0.731)";
  const result = assessSite("fingerprint-playground", playground({ "Proxy Detection": warning }));
  expect(result.verdict).toBe("PASS");
  expect(result.details["Proxy Detection"]).toBe(warning);
  expect(result.warnings).toEqual(["Proxy Detection: " + warning]);
  expect(assessSite("fingerprint-playground", playground({ "Proxy Detection": warning, Bot: "You are a bot" })).verdict).toBe("FAIL");
  for (const confidence of ["medium", "high"]) {
    expect(assessSite("fingerprint-playground", playground({ "Proxy Detection": warning.replace("low", confidence) })).verdict).toBe("FAIL");
  }
  expect(assessSite("fingerprint-playground", playground({ "Proxy Detection": warning }, ["Bot"])).verdict).toBe("INCONCLUSIVE");
  expect(assessSite("fingerprint-playground", playground({ "Proxy Detection": "Unknown proxy result" })).verdict).toBe("INCONCLUSIVE");
});

describe("flight results", () => {
  test("requires a rendered card and accepts either apostrophe", () => {
    for (const snapshot of [flights(), flights().replace("today’s", "today's")]) {
      const result = assessSite("fingerprint-web-scraping", snapshot);
      expect(result.verdict).toBe("PASS");
      expect(result.details.Total).toBe("€241.00");
    }
  });

  test("accepts inline fields and a complete accessible card name", () => {
    const inline = `- article:\n  - paragraph: Departure: TBS 09:00\n  - paragraph: Arrival: CDG 13:00\n  - paragraph: Price per adult: USD 299.00\n  - paragraph: Total: 598.00 USD`;
    const named = `- listitem "Departure TBS 09:00 Arrival CDG 13:00 Price per adult $299 Total $598"`;
    for (const card of [inline, named]) expect(assessSite("fingerprint-web-scraping", flights(card)).verdict).toBe("PASS");
  });

  test("accepts the native single-text flight card used by the runner", () => {
    const card = "- text: Departure November 3, 2026 United SFO San Francisco 11:05 AM JFK New York 06:20 PM Arrival November 8, 2026 Price per adult $ 289 Total $ 598";
    for (const role of ["text", "generic"]) {
      expect(assessSite("fingerprint-web-scraping", flights(card.replace("- text:", `- ${role}:`))).verdict).toBe("PASS");
    }
    expect(assessSite("fingerprint-web-scraping", flights(card.replace("- text: Departure", "- text: Example: Departure"))).verdict).toBe("INCONCLUSIVE");
    expect(assessSite("fingerprint-web-scraping", flights(card.replace("- text:", "- code:"))).verdict).toBe("INCONCLUSIVE");
  });

  test.each(["You are a bot", "Bot detected", "Browser tampering detected", "Access denied", "Access denied: automated request"])("fails explicit native result: %s", message => {
    const result = assessSite("fingerprint-web-scraping", flights(`- alert: ${message}\n${flight}`));
    expect(result.verdict).toBe("FAIL");
    expect(result.details.result).toBe(message);
  });

  test.each(["Network error", "Failed to load flights", "Something went wrong", "Service unavailable", "Request timed out", "Error: failed to search flights"])("reports an operational error: %s", message => {
    expect(assessSite("fingerprint-web-scraping", flights(`- alert: ${message}`)).verdict).toBe("ERROR");
  });

  test("ignores explanatory help and sample JSON", () => {
    const help = `${heading("Flight demo")}\n- paragraph: Bot detected means a request was blocked.\n- code: '{"result":"You are a bot"}'\n${flights()}\n- paragraph: Access denied\n- paragraph: Network error`;
    expect(assessSite("fingerprint-web-scraping", help).verdict).toBe("PASS");
    expect(assessSite("fingerprint-web-scraping", `${heading("About flights")}\n${flight}`).verdict).toBe("INCONCLUSIVE");
    expect(assessSite("fingerprint-web-scraping", flights(`- paragraph: If you are a bot, access is denied.\n- code: '{"Departure":"London","Arrival":"Paris","Price per adult":"$12","Total":"$24"}'`)).verdict).toBe("INCONCLUSIVE");
    expect(assessSite("fingerprint-web-scraping", flights(`- paragraph: Bot detected means the check failed.\n${flight}`)).verdict).toBe("PASS");
  });

  test("does not accept incomplete cards, headers, or prices without currency", () => {
    for (const card of [
      flight.replace("  - text: Total\n  - text: €241.00", ""),
      flight.replace("€120.50", "Loading..."),
      flight.replace("€120.50", "120.50").replace("€241.00", "241.00"),
      `- row "Departure Arrival Price per adult Total":\n  - columnheader "Departure"\n  - columnheader "Arrival"\n  - columnheader "Price per adult"\n  - columnheader "Total"`,
      `- text: Departure\n- text: Arrival\n- text: Price per adult\n- text: Total`,
    ]) expect(assessSite("fingerprint-web-scraping", flights(card)).verdict).toBe("INCONCLUSIVE");
  });

  test("does not combine incomplete cards", () => {
    const cards = `- group:\n  - text: Departure: London\n  - text: Arrival: Paris\n- group:\n  - text: Departure: Rome\n  - text: Price per adult: $120\n  - text: Total: $240`;
    expect(assessSite("fingerprint-web-scraping", flights(cards)).verdict).toBe("INCONCLUSIVE");
    const splitCard = `- group:\n  - text: Departure: London\n  - text: Arrival: Paris\n  - text: Price per adult: $120\n- group:\n  - text: Total: $240`;
    expect(assessSite("fingerprint-web-scraping", flights(splitCard)).verdict).toBe("INCONCLUSIVE");
  });

  test("accepts separate inline field nodes without colon separators", () => {
    const card = `- group:\n  - text: Departure London\n  - text: Arrival Paris\n  - text: Price per adult $120\n  - text: Total $240`;
    expect(assessSite("fingerprint-web-scraping", flights(card)).verdict).toBe("PASS");
  });

  test("remains inconclusive during loading and uses the latest result section", () => {
    expect(assessSite("fingerprint-web-scraping", flights(`- status: Loading...\n${flight}`)).verdict).toBe("INCONCLUSIVE");
    expect(assessSite("fingerprint-web-scraping", `${flights()}\n${flights("- status: Loading...")}`).verdict).toBe("INCONCLUSIVE");
    expect(assessSite("fingerprint-web-scraping", `${flights("- status: Loading...")}\n${flights()}`).verdict).toBe("PASS");
  });
});

describe("desktop SMART SIGNALS", () => {
  test("passes only with all 11 clear binary rows", () => {
    const result = assessSite("fingerprint-playground", playground({ Bot: "You are not a bot", VPN: "No", "Rare Device": "false" }));
    expect(result.verdict).toBe("PASS");
    expect(Object.keys(result.details)).toHaveLength(11);
  });

  test.each(signalNames)("fails a native detection for %s", name => {
    expect(assessSite("fingerprint-playground", playground({ [name]: "Yes" })).verdict).toBe("FAIL");
  });

  test.each(["Yes", "Detected", "You are a bot", "Bot detected", "true"])("recognizes native positive flag %s", value => {
    expect(assessSite("fingerprint-playground", playground({ Bot: value })).verdict).toBe("FAIL");
  });

  test("recognizes native status decorations without accepting unknown text", () => {
    expect(assessSite("fingerprint-playground", playground({ "Developer Tools": "Yes 🔧" })).verdict).toBe("FAIL");
    expect(assessSite("fingerprint-playground", playground({ Bot: "✅ Not detected", VPN: "No ✓" })).verdict).toBe("PASS");
    expect(assessSite("fingerprint-playground", playground({ "Developer Tools": "Maybe 🔧" })).verdict).toBe("INCONCLUSIVE");
  });

  test.each(signalNames)("does not pass when %s is absent", name => {
    const result = assessSite("fingerprint-playground", playground({}, [name]));
    expect(result.verdict).toBe("INCONCLUSIVE");
    expect(result.details.missingSignals).toContain(name);
  });

  test.each(["Unknown", "Loading...", "Maybe", "Low risk", "", "Not detected (example)"])("does not interpret an unknown flag: %s", value => {
    const result = assessSite("fingerprint-playground", playground({ Bot: value }));
    expect(result.verdict).toBe("INCONCLUSIVE");
    expect(result.details.unknownSignals).toContain("Bot");
  });

  test("keeps detections when other rows are missing or duplicated", () => {
    expect(assessSite("fingerprint-playground", playground({ Bot: "Detected" }, ["VPN"])).verdict).toBe("FAIL");
    expect(assessSite("fingerprint-playground", `${playground()}\n${row("Bot", "Yes")}`).verdict).toBe("FAIL");
  });

  test("handles row names, nested cells, YAML key quoting, refs, and whitespace", () => {
    const named = [heading("  SMART   SIGNALS  ", 3), ...signalNames.map(name => `  - row ${JSON.stringify(`${name.replace("-", "‑")}  |  No`)} [ref=e12]`)].join("\r\n");
    expect(assessSite("fingerprint-playground", named).verdict).toBe("PASS");
    const cells = [heading("SMART SIGNALS", 3), ...signalNames.map(name => `- row:\n  - cell:\n    - text: ${name}\n  - cell:\n    - generic: Not detected`)].join("\n");
    expect(assessSite("fingerprint-playground", cells).verdict).toBe("PASS");
    const quotedRows = [heading("SMART SIGNALS", 3), ...signalNames.map(name => `- 'row "${name}: Not detected"':`)].join("\n");
    expect(assessSite("fingerprint-playground", quotedRows).verdict).toBe("PASS");
  });

  test("uses result cells instead of aggregate row help", () => {
    const snapshot = playground().replace('row "Bot Not detected"', 'row "Bot Not detected You are a bot means automation was found"');
    expect(assessSite("fingerprint-playground", snapshot).verdict).toBe("PASS");
  });

  test.each(["MOBILE SMART SIGNALS", "How to use this demo", "JSON responses"])("stops at %s", boundary => {
    const snapshot = `${playground()}\n${heading(boundary, 3)}\n${row("Bot", "You are a bot")}\n${row("VPN", "Yes")}`;
    expect(assessSite("fingerprint-playground", snapshot).verdict).toBe("PASS");
    expect(assessSite("fingerprint-playground", `${playground({}, ["Bot"])}\n${heading(boundary, 3)}\n${row("Bot", "No")}`).verdict).toBe("INCONCLUSIVE");
  });

  test("keeps informational signals and help separate from binary results", () => {
    const extras = [row("Suspect Score", "100"), row("Identification confidence", "0.1"), row("Geolocation", "Denied"), row("Velocity", "High"), row("Visitor ID", "bot-detected")].join("\n");
    const snapshot = `${heading("About this demo")}\n${row("Bot", "Detected")}\n${playground()}\n${extras}\n- paragraph: Bot detection reports Yes if you are a bot.\n- code: '{"bot":{"result":"Detected"}}'`;
    expect(assessSite("fingerprint-playground", snapshot).verdict).toBe("PASS");
    expect(assessSite("fingerprint-playground", `${heading("SMART SIGNALS", 3)}\n- paragraph: Bot Not detected\n- code: '{"Bot":"No"}'`).verdict).toBe("INCONCLUSIVE");
  });

  test("does not combine rows from separate snapshots", () => {
    expect(assessSite("fingerprint-playground", `${playground()}\n${playground({}, ["Rare Device"])}`).verdict).toBe("INCONCLUSIVE");
  });

  test("does not pass a table that still reports loading or busy state", () => {
    expect(assessSite("fingerprint-playground", `${playground()}\n- status: Loading...`).verdict).toBe("INCONCLUSIVE");
    const busy = playground().replace('row "Bot Not detected":', 'row "Bot Not detected" [busy]:');
    expect(assessSite("fingerprint-playground", busy).verdict).toBe("INCONCLUSIVE");
  });
});

describe("Pixelscan summary", () => {
  function nativePixelscan(overrides: Record<string, string> = {}): string {
    return [heading("Fingerprint Scan", 1), "- text: Your Browser Fingerprint is consistent", '- generic "Fingerprint checks":',
      ...Object.entries({ ...pixelValues, ...overrides }).flatMap(([label, value]) => [`  - text: ${value}`, `  - text: ${label === "Bot" ? "Bot check" : label}`]),
      heading("What Websites See About You"),
    ].join("\n");
  }
  test("accepts the native completed summary", () => {
    const result = assessSite("pixelscan", pixelscan());
    expect(result.verdict).toBe("PASS");
    expect(result.details.Location).toBe("Georgia / Okroq'ana");
  });

  test("accepts native values before labels and the Bot check label", () => {
    const result = assessSite("pixelscan", nativePixelscan({ Browser: "Firefox 152.0 on Mac OS" }));
    expect(result.verdict).toBe("PASS");
    expect(result.details.Bot).toBe("No automated behavior detected");
    expect(assessSite("pixelscan", pixelscan().replace("- generic: Bot\n", "- generic: Bot check\n")).verdict).toBe("PASS");
  });

  test.each([
    ["Proxy", "Proxy detected", "FAIL"], ["Fingerprint", "Masking detected", "FAIL"],
    ["Bot", "Automated behavior detected", "FAIL"], ["Bot", "Unknown", "INCONCLUSIVE"],
    ["Proxy", "Loading...", "INCONCLUSIVE"], ["Browser", "Loading...", "INCONCLUSIVE"],
  ] as const)("assesses native values before labels: %s %s", (label, value, verdict) => {
    expect(assessSite("pixelscan", nativePixelscan({ [label]: value })).verdict).toBe(verdict);
  });

  test("accepts Unicode location names and punctuation", () => {
    for (const Location of ["Georgia / Okroqʼana", "France / L’Haÿ‑les‑Roses", "Georgia / თბილისი · ოქროყანა"]) {
      expect(assessSite("pixelscan", nativePixelscan({ Location })).verdict).toBe("PASS");
    }
  });

  test.each(["Firefox 144.0 on Linux", "Safari 18.1 on iOS", "Microsoft Edge 156.0.0.0 on Windows 11"])("accepts browser variants: %s", Browser => {
    expect(assessSite("pixelscan", pixelscan({ Browser })).verdict).toBe("PASS");
  });

  test("accepts summary rows and scalar label variations", () => {
    const snapshot = `${heading("Fingerprint Scan")}\n- status: Your Browser Fingerprint is consistent\n${Object.entries(pixelValues).map(([label, value]) => row(label, value)).join("\n")}\n${heading("FAQ")}`;
    expect(assessSite("pixelscan", snapshot).verdict).toBe("PASS");
    expect(assessSite("pixelscan", pixelscan().replace("- generic: Browser\n- generic:", "- generic: Browser:")).verdict).toBe("PASS");
  });

  test.each(["Your Browser Fingerprint is inconsistent", "Your Browser Fingerprint is not consistent", "Your Browser Fingerprint is suspicious"])("fails a negative headline: %s", headline => {
    expect(assessSite("pixelscan", pixelscan({}, headline)).verdict).toBe("FAIL");
  });

  test.each([
    ["Browser", "Browser mismatch detected"], ["Location", "Location is inconsistent"],
    ["Proxy", "Proxy detected"], ["Proxy", "VPN detected"],
    ["Fingerprint", "Masking detected"], ["Bot", "Automated behavior detected"], ["Bot", "Bot detected"],
  ])("fails native warning %s: %s", (label, value) => {
    expect(assessSite("pixelscan", pixelscan({ [label]: value })).verdict).toBe("FAIL");
  });

  test("fails a native summary warning even when all checks otherwise look clear", () => {
    expect(assessSite("pixelscan", pixelscan().replace(heading("What Websites See About You"), `- alert: Warning: fingerprint mismatch\n${heading("What Websites See About You")}`)).verdict).toBe("FAIL");
  });

  test.each(Object.keys(pixelValues))("requires the %s check", label => {
    expect(assessSite("pixelscan", pixelscan({}, undefined, [label])).verdict).toBe("INCONCLUSIVE");
  });

  test.each([
    ["Browser", "Unknown browser"], ["Browser", "Chrome 156.0.0.0 on Unknown"], ["Location", "Unknown / Unknown"],
    ["Location", "Georgia /"], ["Proxy", "Loading..."], ["Fingerprint", "Checking..."],
    ["Bot", "Maybe human"], ["Bot", ""],
  ])("keeps incomplete or unknown %s value inconclusive: %s", (label, value) => {
    expect(assessSite("pixelscan", pixelscan({ [label]: value })).verdict).toBe("INCONCLUSIVE");
  });

  test("requires the consistent headline and completed loading state", () => {
    expect(assessSite("pixelscan", pixelscan({}, "Scanning..." )).verdict).toBe("INCONCLUSIVE");
    expect(assessSite("pixelscan", pixelscan().replace(heading("Fingerprint Scan"), `${heading("Fingerprint Scan")}\n- status: Scanning...`)).verdict).toBe("INCONCLUSIVE");
    expect(assessSite("pixelscan", `${pixelscan()}\n${heading("Fingerprint Scan")}\n- status: Loading...`).verdict).toBe("INCONCLUSIVE");
  });

  test("ignores help, FAQ, and sample JSON verdicts", () => {
    const help = `\n- paragraph: Your Browser Fingerprint is inconsistent\n- paragraph: Proxy detected\n- code: '{"Bot":"Automated behavior detected"}'`;
    expect(assessSite("pixelscan", pixelscan() + help).verdict).toBe("PASS");
    expect(assessSite("pixelscan", `${heading("Fingerprint Scan")}\n- code:\n  - text: Your Browser Fingerprint is consistent\n${heading("FAQ")}\n${Object.entries(pixelValues).map(([label, value]) => row(label, value)).join("\n")}`).verdict).toBe("INCONCLUSIVE");
    expect(assessSite("pixelscan", pixelscan().replace("- generic: No proxy detected", "- paragraph: The phrase No proxy detected means a direct connection." )).verdict).toBe("INCONCLUSIVE");
  });
});

describe("human challenges", () => {
  test.each([
    heading("Verify you are human"), heading("Verify you're human"), heading("Authentication required"),
    `- checkbox "I'm not a robot"`, `- iframe "reCAPTCHA"`,
    `- generic: Verifying you are human. This may take a few seconds.`,
    `- text: Verify you are human\n- button "Verify"`,
    `- form "Sign in":\n  - textbox "Email address"\n  - textbox "Password"\n  - button "Sign in"`,
    `${heading("Sign in")}\n- textbox "Email"\n- button "Continue"`,
    `- textbox "Verification code"\n- button "Verify"`,
  ])("recognizes actual verification or authentication UI: %s", snapshot => {
    expect(detectHumanChallenge(snapshot)).toBeString();
    for (const site of sites) expect(assessSite(site, snapshot).verdict).toBe("INCONCLUSIVE");
  });

  test.each([
    `- paragraph: CAPTCHA and authentication help prevent bot traffic.`,
    `${heading("Bot detection")}\n- paragraph: You are a bot is a possible result.`,
    `- link "CAPTCHA"\n- link "Authentication"\n- button "Sign in"`,
    `${heading("How CAPTCHA works")}\n- paragraph: Verify you are human when a challenge appears.`,
    `${heading("About authentication")}\n- paragraph: Authentication required is an example error.`,
    `${heading("JSON responses")}\n- code: '{"heading":"Verify you are human"}'`,
    `${heading("FAQ")}\n${heading("Verify you are human", 3)}\n- paragraph: This is an example challenge.`,
    `- code:\n  - heading "Verify you are human" [level=1]`,
    `- text: |\n    - heading "Verify you are human" [level=1]\n    - checkbox "I'm not a robot"`,
    heading("Sign in"),
  ])("ignores incidental challenge words and examples: %s", snapshot => {
    expect(detectHumanChallenge(snapshot)).toBeUndefined();
  });

  test("a real challenge prevents a completed result from passing", () => {
    const result = assessSite("fingerprint-playground", `${playground()}\n- dialog "Verify you are human"`);
    expect(result.verdict).toBe("INCONCLUSIVE");
    expect(result.details.challenge).toContain("Verify you are human");
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
