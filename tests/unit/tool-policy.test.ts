import { expect, test } from "bun:test";
import { allowedBrowserTools, browserToolArguments } from "../../src/mcp/tool-policy.ts";
import { routedArguments, routedTools } from "../../src/mcp/mcp.ts";
import type { Contracts, Tool } from "../../src/browser/upstream.ts";

const { TOOL_DEFS } = await import(new URL("../../node_modules/@askjo/camofox-browser/mcp/lib/tool-contracts.mjs", import.meta.url).href) as Contracts;
const names = ["camofox_create_tab", "camofox_snapshot", "camofox_click", "camofox_type", "camofox_navigate", "camofox_scroll",
  "camofox_screenshot", "camofox_close_tab", "camofox_list_tabs"];
const tabId = "79bed5c4-d5b8-4369-9d13-b159451ece91";
const hidden = ["userId", "sessionKey", "coordinates", "annotateScreenshot", "fullPage"];

test("only the nine reviewed Camofox tools are exposed, and the upstream definitions stay unchanged", () => {
  const original = structuredClone(TOOL_DEFS);
  expect(allowedBrowserTools(TOOL_DEFS).map(tool => tool.name)).toEqual(names);
  expect(TOOL_DEFS).toEqual(original);
});

test("no exposed schema accepts a profile, a tab group, or a property that Stelz does not support", () => {
  for (const tool of allowedBrowserTools(TOOL_DEFS)) {
    for (const name of hidden) expect(Object.hasOwn(tool.inputSchema.properties ?? {}, name), `${tool.name}.${name}`).toBe(false);
  }
  const click = allowedBrowserTools(TOOL_DEFS).find(tool => tool.name === "camofox_click")!;
  expect(Object.keys(click.inputSchema.properties!)).toEqual(["tabId", "ref", "selector", "expected_role", "expected_accessible_name"]);
  expect(click.description).not.toContain("coordinates");
});

test("a missing or repeated reviewed tool stops startup", () => {
  for (const name of names) expect(() => allowedBrowserTools(TOOL_DEFS.filter(tool => tool.name !== name)), name).toThrow("Camofox must provide");
  const click = TOOL_DEFS.find(tool => tool.name === "camofox_click")!;
  expect(() => allowedBrowserTools([...TOOL_DEFS, click])).toThrow("Camofox must provide");
});

test("a client cannot select the profile or the tab group", () => {
  const tools = allowedBrowserTools(TOOL_DEFS), routed = routedTools(tools);
  const handle = { profileId: "profile-01", controlHandle: "handle" };
  for (const tool of tools) {
    for (const argument of hidden) {
      const args = { tabId, [argument]: argument === "coordinates" ? { x: 1, y: 1 } : "other" };
      expect(() => browserToolArguments(tool, args), `${tool.name}.${argument}`)
        .toThrow(argument === "userId" || argument === "sessionKey" ? "Routing fields" : "Unknown tool argument");
      expect(() => routedArguments(routed.find(item => item.name === tool.name)!, { ...handle, ...args }), `${tool.name}.${argument}`)
        .toThrow("Unknown tool argument");
    }
  }
  const snapshot = routed.find(tool => tool.name === "camofox_snapshot")!;
  expect(routedArguments(snapshot, { ...handle, tabId }).canonical).toEqual({ tabId });
});

test("the service accepts only exposed properties, and only Stelz sets the internal typing mode", () => {
  const tools = allowedBrowserTools(TOOL_DEFS), tool = (name: string) => tools.find(item => item.name === name)!;
  expect(browserToolArguments(tool("camofox_click"), { tabId, ref: "e1", expected_role: "button", expected_accessible_name: "Save" }))
    .toEqual({ tabId, ref: "e1", expected_role: "button", expected_accessible_name: "Save" });
  expect(browserToolArguments(tool("camofox_type"), { tabId, selector: "#x", text: "hello", mode: "keyboard", pressEnter: true }))
    .toEqual({ tabId, selector: "#x", text: "hello", mode: "keyboard", pressEnter: true });
  expect(browserToolArguments(tool("camofox_list_tabs"), {})).toEqual({});
  expect(() => browserToolArguments(tool("camofox_type"), { tabId, text: "hello", typingMode: "instant" })).toThrow("Unknown tool argument");
  expect(() => browserToolArguments(tool("camofox_snapshot"), { tabId, unknown: true })).toThrow("Unknown tool argument");
  expect(() => browserToolArguments(tool("camofox_list_tabs"), { tabId })).toThrow("Unknown tool argument");
});
