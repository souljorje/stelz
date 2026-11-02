// Explicit, isolated direct-development acceptance run. Never edits production profiles.
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fixture } from "./fixture.ts";

const root = resolve(import.meta.dir, ".."), folder = join(root, ".state/acceptance");
mkdirSync(folder, { recursive: true, mode: 0o700 });
const configPath = join(folder, "profiles.json");
writeFileSync(configPath, JSON.stringify({ maxActive: 2, profiles: [{ id: "test-01", port: 9471, mode: "direct" }, { id: "test-02", port: 9472, mode: "direct", expectedIPEnv: "STELZ_TEST_EXPECTED_IP" }, { id: "test-proxy-fail", port: 9473, mode: "proxy", proxyEnv: "STELZ_TEST_BAD_PROXY" }] }));
process.env.STELZ_CONFIG = configPath; process.env.STELZ_STATE_DIR = folder;
// config.ts has already been loaded by fixture.ts; runtime is exercised through MCP children.
const testServer = await fixture();
const env = Object.fromEntries(Object.entries(process.env).filter((v): v is [string, string] => v[1] !== undefined));
const client = new Client({ name: "stelz-acceptance", version: "0.1.0" });
const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, "src/mcp.ts")], cwd: root, env, stderr: "inherit" });
type Entry = { test: string; result: string; evidence?: unknown };
const report: Entry[] = [];
const tokens: Record<string, string> = {}, tabs: Record<string, string> = {};
function assert(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  const blocks = result.content as Array<{ type: string; text?: string; data?: string }>;
  const text = blocks.filter(b => b.type === "text").map(b => b.text).join("\n");
  if (result.isError) throw Error(text);
  const image = blocks.find(b => b.type === "image");
  if (image?.data) writeFileSync(join(folder, `${name}-${String(args.profileId || "all")}.png`), Buffer.from(image.data, "base64"), { mode: 0o600 });
  try { return JSON.parse(text) as Record<string, unknown>; } catch { return { text }; }
}
const args = (id: string, extra: Record<string, unknown> = {}) => ({ profileId: id, leaseToken: tokens[id], tabId: tabs[id], ...extra });
async function acquire(id: string) { const result = await call("profile_acquire", { profileId: id, owner: "automated-acceptance" }); tokens[id] = String(result.leaseToken); return result; }
async function open(id: string) { const result = await call("camofox_create_tab", args(id, { url: "http://127.0.0.1:9410" })); tabs[id] = String(result.tabId); assert(tabs[id] !== "undefined", `No tabId: ${JSON.stringify(result)}`); }
async function observe(id: string) {
  const response = await fetch(`http://127.0.0.1:${id === "test-01" ? 9471 : 9472}/tabs/${tabs[id]}/evaluate`, { method: "POST", headers: { Authorization: `Bearer ${readFileSync(join(folder, id, "access-key"), "utf8").trim()}`, "Content-Type": "application/json" }, body: JSON.stringify({ userId: id, expression: "({markers: JSON.parse(document.getElementById('markers').textContent), observations: JSON.parse(document.getElementById('observations').textContent)})" }) });
  const payload = await response.json() as { result?: { markers: Record<string, unknown>; observations: Record<string, unknown> }; error?: string };
  assert(response.ok && payload.result, `Observation failed: ${JSON.stringify(payload)}`); return payload.result;
}
try {
  console.log("EXPLICIT DIRECT DEVELOPMENT TEST: two isolated test profiles; no fixed-IP verification.");
  await client.connect(transport);
  const list = await client.listTools(); assert(list.tools.some(t => t.name === "camofox_snapshot"), "MCP tools missing");
  await Promise.all([acquire("test-01"), acquire("test-02")]);
  const live = await call("profiles_list");
  report.push({ test: "A: concurrent visible runtimes", result: "passed", evidence: live });
  try { await acquire("test-01"); throw Error("Duplicate lease unexpectedly succeeded"); } catch (e) { assert(String(e).includes("already leased"), String(e)); }
  report.push({ test: "Exclusive profile lease", result: "passed" });
  await Promise.all([open("test-01"), open("test-02")]);
  for (const id of ["test-01", "test-02"]) {
    await call("camofox_snapshot", args(id));
    await call("camofox_type", args(id, { selector: "#marker", text: id }));
    await call("camofox_click", args(id, { selector: "#save" }));
    await call("camofox_scroll", args(id, { direction: "down", amount: 100 }));
    await call("camofox_screenshot", args(id));
  }
  const before: Record<string, Awaited<ReturnType<typeof observe>>> = {};
  const pins: Record<string, string> = {};
  for (const id of ["test-01", "test-02"]) { before[id] = await observe(id); pins[id] = readFileSync(join(folder, id, "fingerprint.json"), "utf8"); assert(before[id].markers.localStorage === id && before[id].markers.indexedDB === id && String(before[id].markers.cookie).includes(id), "Wrong pre-restart marker"); }
  await call("profile_pause", args("test-01"));
  try { await call("camofox_click", args("test-01", { selector: "#human" })); throw Error("Paused action unexpectedly succeeded"); } catch (e) { assert(String(e).includes("paused"), String(e)); }
  await call("profile_resume", args("test-01"));
  await call("camofox_snapshot", args("test-01"));
  report.push({ test: "Pause blocks actions; resume retains the context", result: "passed" });
  await Promise.all([call("profile_release", args("test-01")), call("profile_release", args("test-02"))]);
  await Promise.all([acquire("test-01"), acquire("test-02")]);
  await Promise.all([open("test-01"), open("test-02")]);
  const after: typeof before = {};
  for (const id of ["test-01", "test-02"]) {
    after[id] = await observe(id);
    assert(after[id].markers.localStorage === id && after[id].markers.indexedDB === id && String(after[id].markers.cookie).includes(id), "Storage did not persist separately");
    assert(pins[id] === readFileSync(join(folder, id, "fingerprint.json"), "utf8"), "Saved fingerprint changed");
  }
  assert(pins["test-01"] !== pins["test-02"], "Fingerprint configurations are identical");
  report.push({ test: "C: separated cookies, localStorage and IndexedDB survive clean restart", result: "passed", evidence: Object.fromEntries(Object.entries(after).map(([id, value]) => [id, value.markers])) });
  report.push({ test: "D: distinct immutable fingerprint configurations; observable comparison", result: "passed", evidence: { before, after, differences: Object.fromEntries(Object.keys(before).map(id => [id, Object.keys(before[id]!.observations).filter(k => JSON.stringify(before[id]!.observations[k]) !== JSON.stringify(after[id]!.observations[k]))])) } });
  report.push({ test: "B: two natural-language Codex workers", result: "unverified", evidence: "Run the two provided prompts through Codex; scripted fixture checks do not count." });
  report.push({ test: "E: supplied proxy and expected fixed IPs", result: "unverified", evidence: "No proxy credentials supplied; both acceptance profiles are explicitly direct." });
  report.push({ test: "F: actual human intervention followed by agent continuation", result: "unverified", evidence: "Pause/resume mechanics pass; a human must perform the manual action." });
} catch (e) { report.push({ test: "Acceptance run", result: "failed", evidence: String(e) }); process.exitCode = 1; }
finally {
  for (const id of Object.keys(tokens)) { try { await call("profile_release", args(id)); } catch {} }
  await client.close(); testServer.stop();
  writeFileSync(join(folder, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
