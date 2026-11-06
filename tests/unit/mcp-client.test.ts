import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { redactControlHandles, routeProfileTools } from "../helpers/mcp-client.ts";

const browserTools = ["camofox_create_tab", "camofox_list_tabs", "camofox_snapshot", "camofox_click", "camofox_type",
  "camofox_navigate", "camofox_scroll", "camofox_close_tab", "camofox_screenshot"];
const controlTools = ["profile_release", "profile_pause", "profile_resume", "profile_recheck"];
const names = ["profile_list", "profile_create", "profile_start", "profile_status", "profile_acquire", ...controlTools, ...browserTools];
const reply = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const rejection = (): CallToolResult => ({ isError: true, content: [{ type: "text", text: "Rejected by the fixture." }] });
const parsed = (value: Awaited<ReturnType<Client["callTool"]>>) =>
  JSON.parse((value.content as { type: string; text?: string }[]).filter(block => block.type === "text").map(block => block.text).join("\n"));

async function fixture() {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const held = new Map<string, string>();
  let ordinal = 0, rejectRelease = false;
  const server = new Server({ name: "routing-fixture", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: names.map(name => ({ name, inputSchema: { type: "object" as const, properties: {} } })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args = {} } = request.params;
    calls.push({ name, args });
    if (name === "profile_list") return reply({ profiles: ["alpha", "beta"] });
    if (typeof args.profileId !== "string") return rejection();
    if (["profile_create", "profile_start", "profile_status"].includes(name)) return reply({ profileId: args.profileId });
    if (name === "profile_acquire") {
      if (held.has(args.profileId)) return rejection();
      const controlHandle = "synthetic-handle-" + ++ordinal;
      held.set(args.profileId, controlHandle);
      return reply({ profileId: args.profileId, phase: "ready", controlHandle });
    }
    if (!held.has(args.profileId) || args.controlHandle !== held.get(args.profileId)) return rejection();
    if (name === "profile_release") {
      if (rejectRelease) return rejection();
      held.delete(args.profileId);
    }
    if (name === "camofox_screenshot") return { content: [{ type: "image", data: "fixture", mimeType: "image/png" }] };
    return reply({ ok: true });
  });
  const client = routeProfileTools(new Client({ name: "routing-check", version: "1" }), "alpha");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  return { client, calls, held, call, rejectRelease: (value: boolean) => { rejectRelease = value; },
    close: async () => { await client.close(); await server.close(); } };
}

test("one connection routes two profiles and all nine browser tools without changing responses", async () => {
  const f = await fixture();
  try {
    await f.call("profile_list");
    expect(f.calls.at(-1)!.args).toEqual({});
    for (const name of ["profile_create", "profile_start", "profile_status"]) {
      await f.call(name);
      expect(f.calls.at(-1)!.args).toEqual({ profileId: "alpha" });
    }
    const alpha = parsed(await f.call("profile_acquire")).controlHandle;
    const beta = parsed(await f.call("profile_acquire", { profileId: "beta" })).controlHandle;
    expect(alpha).not.toBe(beta);
    for (const profileId of ["alpha", "beta"]) {
      for (const name of [...browserTools, "profile_pause", "profile_resume", "profile_recheck"]) {
        const response = await f.call(name, { profileId, tabId: "synthetic-tab", mode: "instant" });
        expect(response.isError).not.toBe(true);
        expect(f.calls.at(-1)!.args).toEqual({ profileId, controlHandle: profileId === "alpha" ? alpha : beta,
          tabId: "synthetic-tab", mode: "instant" });
        if (name === "camofox_screenshot") expect(response.content).toEqual([{ type: "image", data: "fixture", mimeType: "image/png" }]);
      }
    }
    await f.call("profile_release");
    expect((await f.call("camofox_list_tabs", { profileId: "beta" })).isError).not.toBe(true);
    expect((await f.call("camofox_list_tabs")).isError).toBe(true);
  } finally { await f.close(); }
});

test("duplicate acquires reach the server and explicit invalid routing stays invalid", async () => {
  const f = await fixture();
  try {
    expect((await f.call("camofox_list_tabs")).isError).toBe(true);
    expect(f.calls.map(call => call.name)).toEqual(["camofox_list_tabs"]);
    const attempts = await Promise.all([f.call("profile_acquire"), f.call("profile_acquire")]);
    expect(attempts.filter(result => !result.isError)).toHaveLength(1);
    expect(f.calls.filter(call => call.name === "profile_acquire")).toHaveLength(2);
    const alpha = parsed(attempts.find(result => !result.isError)!).controlHandle;
    const beta = parsed(await f.call("profile_acquire", { profileId: "beta" })).controlHandle;
    for (const args of [
      { profileId: "alpha", controlHandle: beta }, { profileId: "beta", controlHandle: alpha },
      { controlHandle: "unknown" }, { controlHandle: undefined }, { profileId: "unowned" }, { profileId: null },
    ]) expect((await f.call("camofox_list_tabs", args)).isError).toBe(true);
    // A failed duplicate acquire must not discard the original handle.
    expect((await f.call("camofox_list_tabs")).isError).not.toBe(true);
    expect((await f.call("camofox_list_tabs", { profileId: "beta" })).isError).not.toBe(true);
  } finally { await f.close(); }
});

test("failed release retains control and a new acquisition replaces the released handle", async () => {
  const f = await fixture();
  try {
    const original = parsed(await f.call("profile_acquire")).controlHandle;
    f.rejectRelease(true);
    expect((await f.call("profile_release")).isError).toBe(true);
    expect((await f.call("camofox_list_tabs")).isError).not.toBe(true);
    f.rejectRelease(false);
    await f.call("profile_release");
    const replacement = parsed(await f.call("profile_acquire")).controlHandle;
    expect(replacement).not.toBe(original);
    expect((await f.call("profile_release", { controlHandle: original })).isError).toBe(true);
    expect((await f.call("camofox_list_tabs")).isError).not.toBe(true);
    expect(f.calls.at(-1)!.args.controlHandle).toBe(replacement);
  } finally { await f.close(); }
});

test("diagnostics redact handles in structured results and MCP JSON text", () => {
  const result = { ...reply({ profileId: "alpha", controlHandle: "synthetic-secret" }),
    structuredContent: { profiles: [{ profileId: "beta", controlHandle: "synthetic-secret" }] } };
  const redacted = JSON.stringify(redactControlHandles(result));
  expect(redacted).not.toContain("synthetic-secret");
  expect(redacted).toContain("alpha");
  expect(redacted).toContain("beta");
  expect(JSON.stringify(result)).toContain("synthetic-secret");
});
