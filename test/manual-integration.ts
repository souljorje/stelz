// Requires a person to click the headed fixture while MCP actions are paused.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fixture } from "./fixture.ts";
const root = resolve(import.meta.dir, ".."); mkdirSync(join(root, ".state"), { recursive: true });
const home = mkdtempSync(join(root, ".state/manual-acceptance-")), cli = join(root, "dist/cli.js"), id = "manual-01";
const env: Record<string, string> = { STELZ_HOME: home };
for (const key of ["PATH", "HOME", "LANG", "TMPDIR", "CAMOUFOX_EXECUTABLE"]) if (process.env[key]) env[key] = process.env[key]!;
const report: unknown[] = [], client = new Client({ name: "manual-acceptance", version: "1.0.0" });
let site: Awaited<ReturnType<typeof fixture>> | undefined;
const identityFile = (name: string) => join(home, "identities", id, name);
function assert(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
async function command(...args: string[]) {
  const p = Bun.spawn([Bun.which("bun")!, "--no-env-file", cli, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code) throw Error(`${args.join(" ")}: ${err || out}`);
}
async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  if (result.isError) throw Error(`MCP ${name} rejected`);
  return JSON.parse((result.content as Array<{ type: string; text?: string }>).filter(v => v.type === "text").map(v => v.text).join("\n")) as Record<string, unknown>;
}
try {
  await command("init"); writeFileSync(join(home, "identities.json"), JSON.stringify({ maxActive: 1, identities: [{ id, port: 9871, mode: "direct", storage: "native" }] }));
  await command("setup"); site = await fixture(9810); await command("start", id);
  await client.connect(new StdioClientTransport({ command: Bun.which("bun")!, args: ["--no-env-file", cli, "mcp", "--identity", id], env }));
  await call("identity_acquire");
  const tab = await call("camofox_create_tab", { url: "http://127.0.0.1:9810/?profile=manual-takeover&manual=takeover" });
  await call("camofox_snapshot", { tabId: tab.tabId });
  await call("camofox_scroll", { tabId: tab.tabId, direction: "down", amount: 400 });
  await call("camofox_snapshot", { tabId: tab.tabId });
  const instance = readFileSync(identityFile("running.json"), "utf8"), pin = readFileSync(identityFile("fingerprint.json"), "utf8");
  await call("identity_pause");
  const rejected = await client.callTool({ name: "camofox_list_tabs", arguments: {} });
  assert(rejected.isError, "Paused identity allowed browser actions");
  console.log(`WAITING_FOR_HUMAN: Click Human confirmation in the Camoufox acceptance fixture — manual-takeover window. Evidence: ${home}`);
  const deadline = Date.now() + 15 * 60 * 1000;
  while (!site.manualConfirmations.has("takeover") && Date.now() < deadline) await Bun.sleep(250);
  assert(site.manualConfirmations.get("takeover")?.trusted, "No human confirmation arrived before the deadline");
  assert((await call("identity_status")).phase === "paused", "Identity resumed before human confirmation");
  await call("identity_resume");
  const snapshot = await call("camofox_snapshot", { tabId: tab.tabId });
  assert(String(snapshot.snapshot).includes("Human confirmation received"), "Human action is absent from the resumed page");
  await call("camofox_scroll", { tabId: tab.tabId, direction: "up", amount: 100 });
  assert(readFileSync(identityFile("running.json"), "utf8") === instance, "Manual intervention replaced the browser service");
  assert(readFileSync(identityFile("fingerprint.json"), "utf8") === pin, "Manual intervention changed the device pin");
  report.push({ check: "Human interaction while paused, followed by MCP resume in the same browser and tab", result: "passed", tabId: tab.tabId });
} catch (error) { report.push({ check: "Manual acceptance", result: "failed", error: String(error) }); process.exitCode = 1; }
finally {
  await client.close().catch(() => {}); await command("stop", "all").catch(() => {}); site?.stop();
  writeFileSync(join(home, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 }); console.log(JSON.stringify(report, null, 2));
}
