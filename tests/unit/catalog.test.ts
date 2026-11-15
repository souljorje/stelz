import { expect, test } from "bun:test";
import { browserTools, deadline, entries, excluded, toolArguments, type Contracts } from "../../src/browser/catalog.ts";
import { DEFAULT_MAX_CHARS, MAX_MAX_CHARS, MIN_MAX_CHARS } from "../../src/browser/snapshot-view.ts";
import { ACTION_LIMIT_MS, EVALUATE_DEFAULT_MS, EVALUATE_MAX_MS, TYPING_LIMIT_MS, WAIT_DEFAULT_MS, WAIT_MAX_MS } from "../../src/browser/deadlines.ts";

const upstream = await import(new URL("../../node_modules/@askjo/camofox-browser/mcp/lib/tool-contracts.mjs", import.meta.url).href) as Contracts;
const tabId = "79bed5c4-d5b8-4369-9d13-b159451ece91";
const tools = browserTools(upstream.TOOL_DEFS);
const tool = (name: string) => tools.get(name)!.tool;
const core = entries.filter(item => item.group === "core").map(item => item.name);

test("every upstream tool has a Stelz entry, or is excluded", () => {
  const classified = [...entries.map(item => item.upstream), ...excluded];
  expect(new Set(classified).size).toBe(classified.length);
  expect([...classified].sort()).toEqual([...upstream.TOOL_NAMES].sort());
});

test("names are unique, use the tab_ prefix, and give every tool a deadline", () => {
  const names = entries.map(item => item.name);
  expect(new Set(names).size).toBe(names.length);
  for (const item of entries) {
    expect(item.name, item.name).toMatch(/^tab_[a-z_]+$/);
    expect(item.upstream, item.name).toMatch(/^camofox_[a-z_]+$/);
    const limit = item.deadline({});
    expect(Number.isFinite(limit) && limit > 0, item.name).toBe(true);
  }
});

test("held tools are not built, scripts tools are marked, and core tools need no switch", () => {
  expect(entries.filter(item => item.policy === "held").map(item => item.name)).toEqual(["tab_activate"]);
  expect(entries.filter(item => item.policy === "scripts").map(item => item.name)).toEqual(["tab_evaluate", "tab_init_script"]);
  expect([...tools.keys()]).toEqual(entries.filter(item => item.policy !== "held").map(item => item.name));
  // core is a subset of full: every core tool is listed, and none needs the scripts switch.
  for (const name of core) expect(entries.find(item => item.name === name)!.policy, name).toBe("default");
  expect(core).toEqual(["tab_list", "tab_create", "tab_close", "tab_navigate", "tab_back", "tab_snapshot", "tab_click", "tab_type", "tab_press",
    "tab_select", "tab_scroll", "tab_screenshot", "tab_wait"]);
});

test("no exposed schema has a routing field or an excluded property, and the upstream definitions stay unchanged", () => {
  const original = structuredClone(upstream.TOOL_DEFS);
  const built = browserTools(upstream.TOOL_DEFS);
  expect(upstream.TOOL_DEFS).toEqual(original);
  for (const { tool } of built.values()) {
    for (const name of ["userId", "sessionKey", "coordinates", "annotateScreenshot", "dismissConsent"])
      expect(Object.hasOwn(tool.inputSchema.properties ?? {}, name), `${tool.name}.${name}`).toBe(false);
  }
  expect(Object.keys(tool("tab_click").inputSchema.properties!)).toEqual(["tabId", "ref", "selector", "expected_role", "expected_accessible_name"]);
  expect(Object.keys(tool("tab_screenshot").inputSchema.properties!)).toEqual(["tabId", "fullPage"]);
  expect(Object.keys(tool("tab_wait").inputSchema.properties!)).toEqual(["tabId", "timeout", "waitForNetwork"]);
  expect(tool("tab_type").inputSchema.properties).toHaveProperty("mode.enum", ["balanced", "keyboard", "instant"]);
  expect(tool("tab_type").inputSchema.required).toEqual(upstream.TOOL_DEFS.find(def => def.name === "camofox_type")!.inputSchema.required);
  expect(tool("tab_wait").inputSchema.properties).toHaveProperty("timeout.maximum", WAIT_MAX_MS);
  expect(tool("tab_evaluate").inputSchema.properties).toHaveProperty("timeoutMs.maximum", EVALUATE_MAX_MS);
});

test("descriptions use Stelz names and do not promote the engine", () => {
  for (const { tool } of tools.values()) {
    expect(tool.description, tool.name).not.toMatch(/camofox_|PREFERRED|instead of Chrome|Preferred over Chrome|consent/i);
    expect(tool.description.trim(), tool.name).not.toBe("");
  }
  expect(tool("tab_ax").description).toContain("tab_snapshot");
  expect(tool("tab_table_rows").description).toContain("tab_snapshot");
  expect(tool("tab_mouse_wheel").description).toContain("tab_scroll");
  expect(tool("tab_press").description).toContain("tab_type");
  expect(tool("tab_init_script").description).toContain("tab_evaluate");
  expect(tool("tab_click").description).not.toContain("coordinates");
});

test("no description names a field that the snapshot text drops, and tab_snapshot describes the reply", () => {
  for (const { tool } of tools.values()) {
    const text = [tool.description, ...Object.values(tool.inputSchema.properties ?? {}).map(value => (value as { description?: string }).description ?? "")].join("\n");
    // The word "structure" is also plain prose, as in "ARIA structure". Match only the field name.
    expect(text, tool.name).not.toMatch(/\b(hasMore|totalChars)\b|`structure`|\bstructure\s*[:=]/);
  }
  const { description } = tool("tab_snapshot");
  for (const field of ["url", "refsCount", "truncated", "nextOffset", "offset"]) expect(description).toContain(field);
  expect(description).toContain("e1, e2");
  expect(description).not.toContain("hasMore");
});

test("tab_snapshot exposes the shaping arguments and no annotated screenshot, and tab_table_rows names where table ids come from", () => {
  const properties = tool("tab_snapshot").inputSchema.properties!;
  expect(Object.keys(properties)).toEqual(["tabId", "offset", "scope", "contains", "diff", "collapse", "maxChars", "viewId", "includeScreenshot", "includeStructure"]);
  expect(properties).toHaveProperty("scope.required", ["role"]);
  expect(properties).toHaveProperty("scope.properties.nth.minimum", 0);
  expect(properties).toHaveProperty("maxChars.minimum", MIN_MAX_CHARS);
  expect(properties).toHaveProperty("maxChars.maximum", MAX_MAX_CHARS);
  expect(properties).toHaveProperty("offset.type", "integer");
  expect((properties.maxChars as { description: string }).description).toContain(String(DEFAULT_MAX_CHARS));
  expect(tool("tab_snapshot").inputSchema.required).toEqual(["tabId"]);
  const { description } = tool("tab_snapshot");
  for (const word of ["viewId", "baseline", "includeScreenshot", "scope", "contains", "diff", "may have shifted"]) expect(description).toContain(word);
  expect(tool("tab_table_rows").description).toContain("includeStructure");
  expect(tool("tab_table_rows").description).not.toContain("camofox_");
});

test("snapshot arguments are checked before any call", () => {
  const snapshot = (args: Record<string, unknown>) => toolArguments(tool("tab_snapshot"), { tabId, ...args });
  expect(snapshot({ scope: { role: "list", name: "Results", nth: 1 }, contains: "lamp", diff: true, collapse: false, maxChars: 5000, includeScreenshot: true, includeStructure: false }))
    .toMatchObject({ scope: { role: "list", name: "Results", nth: 1 }, maxChars: 5000 });
  expect(snapshot({ scope: { role: "main" } })).toMatchObject({ scope: { role: "main" } });
  for (const scope of [null, "list", [], {}, { role: "" }, { role: " " }, { role: 1 }, { role: "list", name: 1 }, { role: "list", nth: -1 },
    { role: "list", nth: 1.5 }, { role: "list", nth: "1" }, { role: "list", extra: true }])
    expect(() => snapshot({ scope }), JSON.stringify(scope)).toThrow("scope must be an object with a role");
  expect(() => snapshot({ contains: "" })).toThrow("contains must be text");
  expect(() => snapshot({ contains: 5 })).toThrow("contains must be text");
  for (const key of ["diff", "collapse", "includeScreenshot", "includeStructure"]) for (const value of ["true", 1, null]) expect(() => snapshot({ [key]: value }), key).toThrow(`${key} must be true or false`);
  for (const maxChars of [MIN_MAX_CHARS - 1, MAX_MAX_CHARS + 1, Number.NaN, Infinity, "5000", 5000.5]) expect(() => snapshot({ maxChars }), String(maxChars)).toThrow("maxChars must be");
  expect(snapshot({ maxChars: MAX_MAX_CHARS })).toMatchObject({ maxChars: MAX_MAX_CHARS });
  expect(() => snapshot({ viewId: "" })).toThrow("viewId must be");
  for (const offset of [-1, 1.5, "10", null, Number.NaN]) expect(() => snapshot({ offset, viewId: "v1" }), String(offset)).toThrow("offset must be");
});

test("an offset needs the viewId of its reply, and paging cannot shape a new view", () => {
  const snapshot = (args: Record<string, unknown>) => toolArguments(tool("tab_snapshot"), { tabId, ...args });
  expect(snapshot({ offset: 4000, viewId: "v3" })).toEqual({ tabId, offset: 4000, viewId: "v3" });
  expect(snapshot({ offset: 4000, viewId: "v3", maxChars: 2000 })).toMatchObject({ maxChars: 2000 });
  expect(() => snapshot({ offset: 4000 })).toThrow("offset needs the viewId");
  expect(() => snapshot({ viewId: "v3" })).toThrow("viewId is for paging");
  expect(() => snapshot({ offset: 0, viewId: "v3" })).toThrow("viewId is for paging");
  expect(snapshot({ offset: 0 })).toEqual({ tabId, offset: 0 });
  for (const extra of [{ scope: { role: "list" } }, { contains: "x" }, { diff: true }, { collapse: false }, { includeScreenshot: false }, { includeStructure: true }])
    expect(() => snapshot({ offset: 10, viewId: "v1", ...extra }), Object.keys(extra)[0]).toThrow(`Do not pass ${Object.keys(extra)[0]}`);
});

test("a missing upstream tool stops startup", () => {
  for (const item of entries.filter(item => item.policy !== "held"))
    expect(() => browserTools(upstream.TOOL_DEFS.filter(def => def.name !== item.upstream)), item.name).toThrow("Camofox must provide");
  expect(() => browserTools([...upstream.TOOL_DEFS, upstream.TOOL_DEFS[0]!])).toThrow("Camofox must provide");
});

test("the service accepts only exposed properties, and only Stelz sets the internal typing mode", () => {
  expect(toolArguments(tool("tab_click"), { tabId, ref: "e1", expected_role: "button", expected_accessible_name: "Save" }))
    .toEqual({ tabId, ref: "e1", expected_role: "button", expected_accessible_name: "Save" });
  expect(toolArguments(tool("tab_type"), { tabId, selector: "#x", text: "hello", mode: "keyboard", pressEnter: true }))
    .toEqual({ tabId, selector: "#x", text: "hello", mode: "keyboard", pressEnter: true });
  expect(toolArguments(tool("tab_list"), {})).toEqual({});
  for (const [name, args] of [["tab_type", { tabId, text: "hello", typingMode: "instant" }], ["tab_snapshot", { tabId, unknown: true }],
    ["tab_list", { tabId }], ["tab_click", { tabId, coordinates: { x: 1, y: 1 } }], ["tab_snapshot", { tabId, annotateScreenshot: true }],
    ["tab_wait", { tabId, dismissConsent: true }]] as const)
    expect(() => toolArguments(tool(name), args), name).toThrow("Unknown tool argument");
  for (const name of ["userId", "sessionKey"]) expect(() => toolArguments(tool("tab_snapshot"), { tabId, [name]: "other" })).toThrow("Routing fields");
  expect(() => toolArguments(tool("tab_type"), { tabId, text: "x", mode: "auto" })).toThrow("Typing mode");
  for (const invalid of ["../x", `${tabId}/evaluate`, "", undefined, null, 1, [tabId]]) expect(() => toolArguments(tool("tab_click"), { tabId: invalid })).toThrow("tabId");
  for (const args of [null, false, 1, [], "invalid"]) expect(() => toolArguments(tool("tab_click"), args)).toThrow("must be an object");
});

test("a time limit above its maximum, below its minimum, or not a number is refused", () => {
  const wait = tool("tab_wait"), evaluate = tool("tab_evaluate");
  expect(toolArguments(wait, { tabId, timeout: WAIT_MAX_MS })).toEqual({ tabId, timeout: WAIT_MAX_MS });
  expect(toolArguments(wait, { tabId, timeout: 0 })).toEqual({ tabId, timeout: 0 });
  expect(toolArguments(evaluate, { tabId, expression: "1", timeoutMs: EVALUATE_MAX_MS })).toMatchObject({ timeoutMs: EVALUATE_MAX_MS });
  for (const timeout of [WAIT_MAX_MS + 1, -1, Number.NaN, Infinity, "5000", null, 1e12]) expect(() => toolArguments(wait, { tabId, timeout }), String(timeout)).toThrow("timeout must be");
  for (const timeoutMs of [EVALUATE_MAX_MS + 1, 999, "30000", Infinity]) expect(() => toolArguments(evaluate, { tabId, expression: "1", timeoutMs }), String(timeoutMs)).toThrow("timeoutMs must be");
  // Upstream rejects a fraction, so the schema says integer and the check agrees.
  expect(evaluate.inputSchema.properties).toHaveProperty("timeoutMs.type", "integer");
  for (const timeoutMs of [1500.5, 2000.1, Number.NaN]) expect(() => toolArguments(evaluate, { tabId, expression: "1", timeoutMs }), String(timeoutMs)).toThrow("timeoutMs must be an integer");
  expect(toolArguments(evaluate, { tabId, expression: "1", timeoutMs: 2000 })).toMatchObject({ timeoutMs: 2000 });
  // A wait timeout is still a number, and upstream accepts a fraction there.
  expect(toolArguments(tool("tab_wait"), { tabId, timeout: 1500.5 })).toEqual({ tabId, timeout: 1500.5 });
});

test("deadlines come from the call arguments, with caps", () => {
  expect(deadline("tab_click", {})).toBe(ACTION_LIMIT_MS);
  expect(deadline("tab_navigate", { tabId })).toBe(ACTION_LIMIT_MS);
  expect(deadline("tab_type", {})).toBe(TYPING_LIMIT_MS);
  expect(deadline("tab_wait", {})).toBe(WAIT_DEFAULT_MS);
  expect(deadline("tab_wait", { timeout: 2_000 })).toBe(2_000);
  expect(deadline("tab_wait", { timeout: 1e12 })).toBe(WAIT_MAX_MS);
  expect(deadline("tab_evaluate", {})).toBe(EVALUATE_DEFAULT_MS);
  expect(deadline("tab_evaluate", { timeoutMs: 90_000 })).toBe(90_000);
  expect(deadline("tab_evaluate", { timeoutMs: 1e12 })).toBe(EVALUATE_MAX_MS);
  expect(deadline("tab_evaluate", { timeoutMs: "x" })).toBe(EVALUATE_DEFAULT_MS);
  expect(() => deadline("tab_unknown", {})).toThrow("Unknown browser tool");
});
