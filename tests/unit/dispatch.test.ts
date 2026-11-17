import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Contracts } from "../../src/browser/catalog.ts";
import { createDispatch } from "../../src/mcp/dispatch.ts";
import { createControlRegistry } from "../../src/mcp/control-registry.ts";
import { service } from "../helpers/control-service.ts";

const upstream = await import(new URL("../../node_modules/@askjo/camofox-browser/mcp/lib/tool-contracts.mjs", import.meta.url).href) as Contracts;
const tabId = "79bed5c4-d5b8-4369-9d13-b159451ece91";
const profileTools = ["profile_list", "profile_create", "profile_start", "profile_status", "profile_acquire", "profile_release", "profile_pause", "profile_resume", "profile_recheck"];
const coreTabs = ["tab_list", "tab_create", "tab_close", "tab_navigate", "tab_back", "tab_snapshot", "tab_click", "tab_type", "tab_press",
  "tab_select", "tab_scroll", "tab_screenshot", "tab_wait"];
const scriptTools = ["tab_evaluate", "tab_init_script"];

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function home(profiles: Array<Record<string, unknown>> = [{ id: "alpha", port: 9401, allowScripts: true }, { id: "beta", port: 9402 }]) {
  const value = mkdtempSync(join(tmpdir(), "stelz-dispatch-")); homes.push(value);
  const save = (next = profiles) => writeFileSync(join(value, "profiles.json"), JSON.stringify({ profiles: next }));
  save();
  return Object.assign(value, { save });
}
function fixture(options: { tools?: string; profiles?: Array<Record<string, unknown>> } = {}) {
  const directory = home(options.profiles), s = service(), registry = createControlRegistry(s.transport);
  const dispatch = createDispatch({ defs: upstream.TOOL_DEFS, registry, tools: options.tools, home: directory, label: () => "dispatch-test" });
  const names = dispatch.tools.map(tool => tool.name);
  const acquire = async (profileId: string) => (await dispatch.call("profile_acquire", { profileId })).payload as { controlHandle: string };
  return { directory, s, registry, dispatch, names, acquire };
}

test("core lists the nine profile tools and the core browser tools", () => {
  const { names, dispatch } = fixture();
  expect(names).toEqual([...profileTools, ...coreTabs]);
  expect(dispatch.tools.every(tool => !tool.name.startsWith("camofox_"))).toBe(true);
});

test("full lists every listed tool, and core is a subset of full", () => {
  const core = fixture().names, full = fixture({ tools: "full" }).names;
  for (const name of core) expect(full).toContain(name);
  expect(full).toEqual(expect.arrayContaining(["tab_forward", "tab_refresh", "tab_mouse_wheel", "tab_drag", "tab_ax", "tab_actionables", "tab_table_rows",
    "tab_links", "tab_images", "tab_extract", ...scriptTools]));
  // Held and excluded tools are never listed.
  expect(full).not.toContain("tab_activate");
  expect(full.filter(name => name.startsWith("camofox_"))).toEqual([]);
  expect(full).toHaveLength(profileTools.length + 23 + scriptTools.length);
});

test("every owned tool takes profileId and controlHandle, and profile_list takes nothing", () => {
  const { dispatch } = fixture({ tools: "full" });
  for (const tool of dispatch.tools) {
    const properties = Object.keys(tool.inputSchema.properties ?? {});
    if (["profile_list"].includes(tool.name)) expect(properties).toEqual([]);
    else if (["profile_create", "profile_start", "profile_status", "profile_acquire"].includes(tool.name)) expect(properties).toEqual(["profileId"]);
    else expect(properties, tool.name).toEqual(expect.arrayContaining(["profileId", "controlHandle"]));
    expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
    for (const name of ["userId", "sessionKey"]) expect(properties, tool.name).not.toContain(name);
  }
});

test("scripts tools are absent when no profile allows scripts, even for full or an explicit name", () => {
  const profiles = [{ id: "alpha", port: 9401 }, { id: "beta", port: 9402, allowScripts: false }];
  for (const tools of ["full", "core,tab_evaluate", "tab_evaluate,tab_init_script"]) {
    const names = fixture({ tools, profiles }).names;
    for (const name of scriptTools) expect(names, `${tools}: ${name}`).not.toContain(name);
  }
  expect(fixture({ tools: "full", profiles }).names).toContain("tab_ax");
});

test("scripts tools appear with full or an explicit name when a profile allows scripts", () => {
  expect(fixture({ tools: "full" }).names).toEqual(expect.arrayContaining(scriptTools));
  expect(fixture({ tools: "core,tab_evaluate" }).names).toEqual([...profileTools, ...coreTabs, "tab_evaluate"]);
  expect(fixture({ tools: "tab_init_script" }).names).toEqual(["tab_init_script"]);
});

test("--tools accepts core, full, tool names, and a comma-separated mix", () => {
  expect(fixture({ tools: "tab_snapshot, tab_click" }).names).toEqual(["tab_snapshot", "tab_click"]);
  expect(fixture({ tools: "profile_list,tab_wait" }).names).toEqual(["profile_list", "tab_wait"]);
  expect(fixture({ tools: "core,full" }).names).toEqual(fixture({ tools: "full" }).names);
  expect(fixture({ tools: "core" }).names).toEqual(fixture().names);
});

test("an unknown, held, or excluded tool name fails at startup", () => {
  for (const tools of ["tab_unknown", "tab_activate", "camofox_snapshot", "camofox_upload", "camofox_import_cookies", "tab_viewport", "", "core,", ",core", "Full", "core;full"])
    expect(() => fixture({ tools }), JSON.stringify(tools)).toThrow("Unknown tool in --tools");
});

test("a tool that the connection does not list is unknown, so the tool list stays fixed", async () => {
  const f = fixture(), { controlHandle } = await f.acquire("alpha");
  const count = f.s.sent.length;
  for (const name of ["tab_evaluate", "tab_forward", "tab_activate", "camofox_snapshot", "camofox_evaluate"])
    await expect(f.dispatch.call(name, { profileId: "alpha", controlHandle, tabId })).rejects.toThrow("Unknown tool.");
  expect(f.s.sent).toHaveLength(count);
});

test("an owned tool needs a well-formed profileId and controlHandle", async () => {
  const f = fixture(), a = await f.acquire("alpha");
  const count = f.s.sent.length;
  await expect(f.dispatch.call("tab_snapshot", { profileId: "alpha", tabId })).rejects.toThrow("Missing required argument: controlHandle");
  await expect(f.dispatch.call("tab_snapshot", { controlHandle: a.controlHandle, tabId })).rejects.toThrow("Missing required argument: profileId");
  await expect(f.dispatch.call("tab_snapshot", { profileId: "alpha", controlHandle: "", tabId })).rejects.toThrow("controlHandle must be");
  await expect(f.dispatch.call("tab_snapshot", { profileId: "alpha", controlHandle: 1, tabId })).rejects.toThrow("controlHandle must be");
  await expect(f.dispatch.call("tab_snapshot", { profileId: "Bad_ID", controlHandle: a.controlHandle, tabId })).rejects.toThrow("profileId must be");
  for (const name of ["profile_release", "profile_pause", "profile_resume", "profile_recheck"])
    await expect(f.dispatch.call(name, { profileId: "alpha" }), name).rejects.toThrow("Missing required argument: controlHandle");
  expect(f.s.sent).toHaveLength(count);
});

test("dispatch routes a browser tool with its Stelz name and returns the raw service reply", async () => {
  const f = fixture(), a = await f.acquire("alpha");
  expect(a.controlHandle).toBeString();
  expect(JSON.stringify((await f.dispatch.call("profile_acquire", { profileId: "beta" })).payload)).not.toContain("controllerId");
  const result = await f.dispatch.call("tab_snapshot", { profileId: "alpha", controlHandle: a.controlHandle, tabId });
  expect<unknown>(result).toEqual({ completed: true, profileId: "alpha" });
  const sent = f.s.sent.at(-1)!;
  expect(sent.action).toBe("tool");
  expect(sent.body).toMatchObject({ name: "tab_snapshot", args: { tabId }, profileId: "alpha" });
  expect(JSON.stringify(sent.body)).not.toContain(a.controlHandle);
  await f.dispatch.call("tab_wait", { profileId: "alpha", controlHandle: a.controlHandle, tabId, timeout: 2_000 });
  expect(f.s.sent.at(-1)!.body.args).toEqual({ tabId, timeout: 2_000 });
  expect(await f.dispatch.call("profile_release", { profileId: "alpha", controlHandle: a.controlHandle })).toEqual({ kind: "json", payload: { profileId: "alpha", released: true } });
});

test("unknown, hidden, and routing arguments are refused before any request", async () => {
  const f = fixture({ tools: "full" }), a = await f.acquire("alpha"), handle = { profileId: "alpha", controlHandle: a.controlHandle };
  const count = f.s.sent.length;
  const refused = async (name: string, args: Record<string, unknown>, message: string | RegExp) =>
    await expect(f.dispatch.call(name, { ...handle, ...args }), `${name} ${JSON.stringify(args)}`).rejects.toThrow(message);
  await refused("tab_snapshot", { tabId, unknown: true }, "Unknown tool argument");
  await refused("tab_snapshot", { tabId, annotateScreenshot: true }, "Unknown tool argument");
  await refused("tab_click", { tabId, coordinates: { x: 1, y: 1 } }, "Unknown tool argument");
  await refused("tab_wait", { tabId, dismissConsent: true }, "Unknown tool argument");
  await refused("tab_type", { tabId, text: "x", typingMode: "instant" }, "Unknown tool argument");
  await refused("tab_list", { tabId }, "Unknown tool argument");
  for (const name of ["userId", "sessionKey", "controllerId", "instanceId", "accessKey"]) await refused("tab_snapshot", { tabId, [name]: "other" }, "Unknown tool argument");
  await refused("tab_snapshot", { tabId: "../local-profile/stop" }, "tabId must be");
  await refused("tab_type", { tabId, text: "x", mode: "auto" }, "Typing mode");
  await refused("tab_wait", { tabId, timeout: 3_600_000 }, "timeout must be");
  await refused("tab_evaluate", { tabId, expression: "1", timeoutMs: 900_000 }, "timeoutMs must be");
  await refused("profile_status", { extra: true }, "Unknown tool argument");
  await expect(f.dispatch.call("profile_list", { profileId: "alpha" })).rejects.toThrow("Unknown tool argument");
  expect(f.s.sent).toHaveLength(count);
});

test("a scripts tool is refused on a profile without the switch, and it reads the switch on each call", async () => {
  const f = fixture({ tools: "full" }), a = await f.acquire("alpha"), b = await f.acquire("beta");
  const call = (profileId: string, controlHandle: string, name = "tab_evaluate") =>
    f.dispatch.call(name, { profileId, controlHandle, tabId, ...(name === "tab_evaluate" ? { expression: "1+1" } : { script: "1" }) });
  let count = f.s.sent.length;
  for (const name of scriptTools) {
    const error = await call("beta", b.controlHandle, name).catch(cause => cause as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(name);
    expect((error as Error).message).toContain("stelz profile config beta --allow-scripts");
    expect((error as Error).message).toContain("UI");
  }
  expect(f.s.sent).toHaveLength(count);
  expect<unknown>(await call("alpha", a.controlHandle)).toEqual({ completed: true, profileId: "alpha" });
  expect(f.s.sent.at(-1)!.body).toMatchObject({ name: "tab_evaluate", args: { tabId, expression: "1+1" } });
  // The switch is off now. The same connection and handle are refused at once.
  f.directory.save([{ id: "alpha", port: 9401 }, { id: "beta", port: 9402 }]);
  count = f.s.sent.length;
  await expect(call("alpha", a.controlHandle)).rejects.toThrow("--allow-scripts");
  f.directory.save([{ id: "alpha", port: 9401, allowScripts: true }, { id: "beta", port: 9402, allowScripts: true }]);
  expect(await call("beta", b.controlHandle, "tab_init_script")).toMatchObject({ completed: true });
  expect(f.s.sent).toHaveLength(count + 1);
});

test("a profile without the switch can still use every other tool", async () => {
  const f = fixture({ tools: "full" }), b = await f.acquire("beta");
  for (const [name, args] of [["tab_snapshot", {}], ["tab_forward", {}], ["tab_ax", {}]] as const)
    expect(await f.dispatch.call(name, { profileId: "beta", controlHandle: b.controlHandle, tabId, ...args })).toMatchObject({ completed: true });
});
