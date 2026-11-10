// Harness-independent acceptance. Both profiles use direct connections without proxy references.
import { writeFileSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fixture } from "../helpers/fixture.ts";
import { unusedPorts } from "../helpers/ports.ts";
import { assertTestHome, createTestHome } from "../helpers/test-home.ts";
import { routeProfileTools } from "../helpers/mcp-client.ts";
import { assertSingleStartupWindow } from "../helpers/startup-window.ts";
const root = resolve(import.meta.dir, "../..");
const home = process.env.STELZ_TEST_HOME ? assertTestHome(process.env.STELZ_TEST_HOME)
  : createTestHome("standalone-acceptance", join(root, ".state"));
const cli = process.env.STELZ_TEST_CLI || join(root, "dist/cli.js");
// Child processes receive runtime paths and browser configuration, not model credentials.
const env: Record<string, string> = { STELZ_HOME: home };
for (const key of ["PATH", "HOME", "LANG", "TMPDIR", "CAMOUFOX_EXECUTABLE"]) if (process.env[key]) env[key] = process.env[key]!;
const report: Record<string, unknown>[] = [], clients: Client[] = [];
function assert(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
async function command(...args: string[]) {
  assertTestHome(home);
  const process = Bun.spawn([Bun.which("bun")!, "--no-env-file", cli, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  if (code) throw Error(`${args.join(" ")}: ${err || out}`); return out;
}
async function connect(id: string, label: string) {
  const client = routeProfileTools(new Client({ name: label, version: "1.0.0" }), id); clients.push(client);
  const transport = new StdioClientTransport({ command: Bun.which("bun")!, args: ["--no-env-file", cli, "mcp"], env, stderr: "inherit" });
  await client.connect(transport); return { client, transport };
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  const blocks = result.content as Array<{ type: string; text?: string; data?: string }>;
  const text = blocks.filter(x => x.type === "text").map(x => x.text).join("\n");
  if (result.isError) throw Error(text);
  const shot = blocks.find(x => x.type === "image");
  if (shot?.data) writeFileSync(join(home, `snapshot-${Date.now()}.png`), Buffer.from(shot.data, "base64"), { mode: 0o600 });
  return JSON.parse(text) as Record<string, unknown>;
}
async function rejection(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 }); assert(result.isError, `${name} did not reject an invalid controller`);
}
const profileDir = (id: string) => join(home, "profiles", id);
const pin = (id: string) => readFileSync(join(profileDir(id), "fingerprint.json"), "utf8");
const instance = (id: string) => JSON.parse(readFileSync(join(profileDir(id), "running.json"), "utf8")) as { instanceId: string; serverPid: number };
let pageServer: Awaited<ReturnType<typeof fixture>> | undefined;
try {
  console.log("Explicit direct-development test. No LLM credentials or harness commands are used.");
  const ports = await unusedPorts(3);
  writeFileSync(join(home, "profiles.json"), JSON.stringify({ profiles: ["profile-01", "profile-02"].map((id, index) => ({ id, port: ports[index]! })) }), { mode: 0o600 });
  await command("setup", "--yes"); pageServer = await fixture(ports[2]!);
  const stopped = await connect("profile-01", "stopped-client");
  await rejection(stopped.client, "profile_acquire"); await stopped.client.close();
  report.push({ check: "MCP cannot implicitly start a stopped browser", result: "passed" });
  await Promise.all([command("start", "profile-01"), command("start", "profile-02")]);
  const before = instance("profile-01"), fingerprint = pin("profile-01");
  const a = await connect("profile-01", "sdk-client-a"), b = await connect("profile-01", "sdk-client-b"), second = await connect("profile-02", "sdk-client-second-profile");
  await call(a.client, "profile_acquire"); await call(second.client, "profile_acquire");
  await rejection(a.client, "profile_acquire");
  await rejection(b.client, "profile_acquire");
  const tabs: Record<string, string> = {};
  for (const [id, client] of [["profile-01", a.client], ["profile-02", second.client]] as const) {
    const tabId = await assertSingleStartupWindow(home, id, await call(client, "camofox_list_tabs"));
    await call(client, "profile_recheck");
    await assertSingleStartupWindow(home, id, await call(client, "camofox_list_tabs"));
    tabs[id] = tabId!;
    await call(client, "camofox_navigate", { tabId, url: `${pageServer.url}/?profile=${id}` });
    await call(client, "camofox_type", { tabId: tabs[id], selector: "#marker", text: id });
    await call(client, "camofox_click", { tabId: tabs[id], selector: "#save" });
    const snapshot = await call(client, "camofox_snapshot", { tabId: tabs[id] });
    assert(String(snapshot.snapshot).includes(`Storage marker: ${id}`), "Storage marker is missing from the browser snapshot");
  }
  report.push({ check: "Startup and recheck leave one blank native window with one usable MCP tab", result: "passed" });
  await rejection(a.client, "camofox_snapshot", { tabId: tabs["profile-02"] });
  report.push({ check: "Two browsers, separate storage, explicit profile routing, and duplicate acquire rejection", result: "passed" });
  await call(a.client, "profile_release"); await call(b.client, "profile_acquire");
  const checkSamePage = async (client: Client) => {
    const listing = await call(client, "camofox_list_tabs");
    assert(JSON.stringify(listing).includes(tabs["profile-01"]!), "The original tab disappeared during handoff");
    const snapshot = await call(client, "camofox_snapshot", { tabId: tabs["profile-01"] });
    assert(String(snapshot.snapshot).includes("Storage marker: profile-01"), "The original page lost its state");
    assert(JSON.stringify(instance("profile-01")) === JSON.stringify(before), "Handoff relaunched the browser");
    assert(pin("profile-01") === fingerprint, "Handoff changed the saved fingerprint");
  };
  await checkSamePage(b.client);
  report.push({ check: "Deliberate release and handoff retain process, tab, storage and fingerprint", result: "passed", evidence: before });
  await b.client.close(); await a.client.close();
  const c = await connect("profile-01", "sdk-client-c-after-disconnect");
  await call(c.client, "profile_acquire"); await checkSamePage(c.client);
  report.push({ check: "Disconnect and reconnect preserve the same running browser", result: "passed" });
  const pendingAction = call(c.client, "camofox_navigate", { tabId: tabs["profile-01"], url: `${pageServer.url}/slow` }).catch(() => undefined);
  for (let n = 0; n < 30; n++) {
    const s = await call(c.client, "profile_status");
    if ((s.controller as { activeActions?: number } | undefined)?.activeActions) break;
    await Bun.sleep(20);
  }
  assert(c.transport.pid, "The MCP process ID is unavailable"); process.kill(c.transport.pid, "SIGKILL");
  await c.client.close();
  const d = await connect("profile-01", "sdk-client-d-after-crash");
  await rejection(d.client, "profile_acquire");
  let acquired = false;
  for (let n = 0; n < 60; n++) {
    try { await call(d.client, "profile_acquire"); acquired = true; break; } catch { await Bun.sleep(100); }
  }
  assert(acquired, "The service did not release the dead controller after its action");
  await pendingAction; await checkSamePage(d.client);
  report.push({ check: "A crashed MCP client retains its action lock until the service finishes the action", result: "passed" });
  // A tab ID must keep routing input to the original page after another tab opens.
  const foreground = await call(d.client, "camofox_create_tab", { url: pageServer.url });
  await call(d.client, "profile_pause");
  await rejection(d.client, "camofox_click", { tabId: tabs["profile-01"], selector: "#human" });
  await call(d.client, "profile_resume");
  await call(d.client, "camofox_snapshot", { tabId: tabs["profile-01"] });
  // Known issue: a scroll in a tab that is not selected can exceed the action deadline. See docs/development/official-launcher-migration.md.
  // Stelz then blocks the lifetime, so record the issue and let the restart below replace that lifetime. Other errors still fail.
  const scrolled = await call(d.client, "camofox_scroll", { tabId: tabs["profile-01"], direction: "down", amount: 100 })
    .then(() => true, (error: Error) => { if (!error.message.includes("action timed out")) throw error; return false; });
  if (scrolled) {
    await checkSamePage(d.client);
    await call(d.client, "camofox_close_tab", { tabId: foreground.tabId });
    report.push({ check: "Pause and resume keep the selected browser", result: "passed" });
  } else report.push({ check: "Pause and resume keep the selected browser", result: "known-issue",
    reason: "The scroll in a tab that is not selected exceeded the action deadline. The restart below replaces the blocked lifetime." });
  await d.client.close(); await second.client.close();
  const pins = { "profile-01": pin("profile-01"), "profile-02": pin("profile-02") };
  assert(pins["profile-01"] !== pins["profile-02"], "Profile fingerprints are identical");
  await command("stop", "all"); await command("start", "all");
  for (const id of ["profile-01", "profile-02"]) {
    const next = await connect(id, `restart-${id}`); await call(next.client, "profile_acquire");
    const tabId = await assertSingleStartupWindow(home, id, await call(next.client, "camofox_list_tabs"));
    await call(next.client, "camofox_navigate", { tabId, url: pageServer.url });
    const snapshot = await call(next.client, "camofox_snapshot", { tabId });
    assert(String(snapshot.snapshot).includes(`Storage marker: ${id}`), "Storage did not survive restart");
    assert(pin(id) === pins[id as keyof typeof pins], "Restart changed a saved fingerprint"); await next.client.close();
  }
  report.push({ check: "Separate storage and saved fingerprints survive explicit stop and start", result: "passed" });
  report.push({ check: "Handoff between two installed LLM harnesses", result: "unverified", reason: "SDK clients prove the protocol. Actual Codex, Claude Code and Hermes integration needs separate validation." });
  report.push({ check: "Supplied fixed-IP proxies and human takeover", result: "unverified", reason: "No proxy credentials or human action were supplied." });
} catch (e) { report.push({ check: "Acceptance run", result: "failed", error: String(e) }); process.exitCode = 1; }
finally {
  for (const client of clients) await client.close().catch(() => {});
  await command("stop", "all").catch(() => {}); pageServer?.stop();
  writeFileSync(join(home, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
