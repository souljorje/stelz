// Headed input acceptance through unchanged MCP tools. Existing profiles must be stopped.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { HOME_DIR } from "../../packages/stelz/src/profiles/config.ts";

const root = resolve(import.meta.dir, "../.."), cli = join(root, "packages/stelz/dist/cli.js");
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--profile" || !/^[a-z][a-z0-9-]{0,63}$/.test(args[1]!)))
  throw Error("Usage: bun run test:typing [--profile STOPPED-PROFILE]");
const existingProfile = args[1], profileId = existingProfile || "typing-check";
mkdirSync(join(root, ".state"), { recursive: true });
const output = mkdtempSync(join(root, ".state/typing-acceptance-"));
const home = existingProfile ? HOME_DIR : output;
const env: Record<string, string> = { STELZ_HOME: home, STELZ_TYPING_MODE: "paced" };
for (const name of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR", "CAMOUFOX_EXECUTABLE"])
  if (process.env[name]) env[name] = process.env[name]!;
type Event = { type: string; target: string; key: string; trusted: boolean; at: number };
type Sample = { values: Record<string, string>; events: Event[]; submits: number };
let sample: Sample | undefined, client: Client | undefined, started = false;
const checks: Array<{ check: string; [key: string]: unknown }> = [];
function assert(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  if (new URL(request.url).pathname === "/sample" && request.method === "POST") {
    sample = await request.json() as Sample;
    return new Response(null, { status: 204 });
  }
  return new Response(`<!doctype html><meta charset="utf-8"><title>stelz typing acceptance</title>
<style>body{font:20px system-ui;padding:30px}label,div,button{display:block;margin:16px}input,textarea{font:inherit}#editable{border:1px solid;padding:10px}</style>
<h1>Typing acceptance</h1><form><label>Message <input id="message" value="old value"></label><button>Submit message</button></form>
<label>Multiline <textarea id="multiline">old value</textarea></label>
<div id="editable" contenteditable="true" role="textbox" aria-label="Editable message">old value</div>
<label>Number <input id="number" type="number" value="1"></label>
<label>Date <input id="date" type="date" value="2026-01-01"></label>
<p id="status">Ready</p><script>
const events = []; let submits = 0;
function publish() {
  const values = Object.fromEntries(['message','multiline','editable','number','date'].map(id => {
    const el = document.getElementById(id); return [id, el.value === undefined ? el.textContent : el.value];
  }));
  document.getElementById('status').textContent = 'Submissions: ' + submits;
  fetch('/sample', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({values,events,submits})});
}
for (const type of ['input','keydown','keyup']) document.addEventListener(type, event => {
  events.push({type,target:event.target.id,key:event.key||'',trusted:event.isTrusted,at:performance.now()}); publish();
});
document.querySelector('form').onsubmit = event => { event.preventDefault(); submits++; publish(); };
publish();
</script>`, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
} });
const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = reservation.port;
reservation.stop(true);
async function command(...args: string[]) {
  const child = Bun.spawn([process.execPath, "--no-env-file", cli, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw Error(`${args[0]}: ${err || out}`);
  return out;
}
async function connect() {
  client = new Client({ name: "typing-acceptance", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: ["--no-env-file", cli, "mcp", "--profile", profileId], env, stderr: "inherit" }));
  await call("profile_status"); await call("profile_acquire");
}
async function result(name: string, args: Record<string, unknown> = {}) {
  return client!.callTool({ name, arguments: args }, undefined, { timeout: 65_000 });
}
async function call(name: string, args: Record<string, unknown> = {}) {
  const response = await result(name, args);
  const text = (response.content as Array<{ type: string; text?: string }>).filter(block => block.type === "text").map(block => block.text).join("\n");
  if (response.isError) throw Error(`${name}: ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}
async function observed(predicate: (value: Sample) => boolean) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (sample && predicate(sample)) return sample;
    await Bun.sleep(20);
  }
  throw Error("The browser did not report the expected input state.");
}
async function type(tabId: string, selector: string, text: string, pressEnter = false) {
  await call("camofox_snapshot", { tabId });
  await call("camofox_type", { tabId, selector, text, pressEnter });
  await call("camofox_snapshot", { tabId });
}
try {
  if (existingProfile) {
    const status = JSON.parse(await command("status", profileId));
    assert(status.phase === "stopped", "The selected profile must be stopped before typing acceptance.");
  } else {
    await command("init");
    writeFileSync(join(home, "profiles.json"), JSON.stringify({ profiles: [
      { id: profileId, port, mode: "direct", storage: "native" },
    ] }));
    await command("setup");
  }
  started = true;
  await command("start", profileId); await connect();
  const tools = await client!.listTools();
  const schema = tools.tools.find(tool => tool.name === "camofox_type")!.inputSchema;
  assert(!("mode" in schema.properties!) && !("delay" in schema.properties!), "The canonical MCP typing schema changed.");
  const tabId = String((await call("camofox_create_tab", { url: `http://127.0.0.1:${server.port}` })).tabId);
  const text = "Paced typing, with pauses.";
  await type(tabId, "#message", text, true);
  const paced = await observed(value => value.values.message === text && value.submits === 1);
  const inputs = paced.events.filter(event => event.type === "input" && event.target === "message");
  const gaps = inputs.slice(2).map((event, i) => event.at - inputs[i + 1]!.at);
  assert(inputs.length >= text.length, "Paced typing did not produce per-character input events.");
  assert(paced.events.some(event => event.type === "keydown" && event.key === "P"), "Keyboard events are missing.");
  assert(paced.events.every(event => event.trusted), "Input events were not browser-generated.");
  assert(Math.max(...gaps) - Math.min(...gaps) > 20, "Typing intervals did not vary.");
  assert(paced.events.filter(event => event.type === "keydown" && event.key === "Enter").length === 1, "Enter was not pressed exactly once.");
  checks.push({ check: "paced replacement, varied timing, browser-generated events, one Enter", inputEvents: inputs.length,
    minIntervalMs: Math.round(Math.min(...gaps)), maxIntervalMs: Math.round(Math.max(...gaps)) });
  for (const [id, value, expected] of [
    ["message", "Cafe\u0301 👨‍👩‍👧‍👦 ქართული", "Cafe\u0301 👨‍👩‍👧‍👦 ქართული"],
    ["message", "one\ntwo", "onetwo"],
    ["multiline", "one\r\ntwo\rthree", "one\ntwo\nthree"],
    ["editable", "Editable words.", "Editable words."], ["number", "12.5", "12.5"], ["date", "2026-11-03", "2026-11-03"],
    ["message", "", ""],
  ] as const) {
    await type(tabId, `#${id}`, value);
    await observed(sample => sample.values[id] === expected && sample.submits === 1);
  }
  checks.push({ check: "Unicode, single-line normalization, multiline, contenteditable, number, date, and empty input" });
  await type(tabId, "#message", "Keep this value");
  await call("camofox_snapshot", { tabId });
  const tooLong = await result("camofox_type", { tabId, selector: "#message", text: "x".repeat(10_000) });
  assert(tooLong.isError && JSON.stringify(tooLong.content).includes("typing_too_long"), "Oversized paced input did not fail before editing.");
  assert(JSON.stringify(await call("camofox_snapshot", { tabId })).includes("Keep this value"), "Oversized input changed the field contents.");
  assert((await call("profile_status")).phase === "ready", "A preflight length rejection blocked the browser.");
  checks.push({ check: "oversized paced input preserves field contents and service readiness" });
  await call("profile_release"); await client!.close(); client = undefined;
  await command("stop", profileId); started = false;
  env.STELZ_TYPING_MODE = "instant";
  started = true;
  await command("start", profileId); await connect();
  const instantTab = String((await call("camofox_create_tab", { url: `http://127.0.0.1:${server.port}` })).tabId);
  await observed(value => value.values.message === "old value");
  const bulk = "Bulk text ".repeat(200);
  await type(instantTab, "#message", bulk, true);
  const instant = await observed(value => value.values.message === bulk && value.submits === 1);
  const bulkInputs = instant.events.filter(event => event.type === "input" && event.target === "message");
  assert(bulkInputs.length === 1, "The service did not forward instant mode to the browser runtime.");
  checks.push({ check: "instant service setting preserves bulk fill and Enter", inputEvents: bulkInputs.length });
  await call("profile_release");
  console.log(JSON.stringify({ result: "passed", profileId, checks, report: join(output, "report.json") }, null, 2));
} catch (error) {
  process.exitCode = 1;
  checks.push({ check: "typing acceptance", error: String(error) });
  console.error(String(error));
} finally {
  await client?.close().catch(() => {});
  if (started) await command("stop", profileId).catch(error => { process.exitCode = 1; checks.push({ check: "explicit stop", error: String(error) }); });
  server.stop(true);
  writeFileSync(join(output, "report.json"), JSON.stringify({ result: process.exitCode ? "failed" : "passed", profileId, checks }, null, 2), { mode: 0o600 });
}
