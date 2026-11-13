// Headed input acceptance through camofox_type in a disposable profile.
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { TypingMode } from "../../src/browser/typing.ts";
import { assertTestHome, createTestHome } from "../helpers/test-home.ts";
import { routeProfileTools } from "../helpers/mcp-client.ts";

const root = resolve(import.meta.dir, "../.."), cli = process.env.STELZ_TEST_CLI || join(root, "src/cli/cli.ts");
const args = process.argv.slice(2);
if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) {
  console.log("Use: bun run test:typing\nThe check creates and stops its own temporary profile.");
  process.exit(0);
}
if (args.length) throw Error("Use: bun run test:typing. Existing profiles are not supported.");
const profileId = "typing-check", output = createTestHome("typing-acceptance", join(root, ".state")), home = output;
const env: Record<string, string> = { STELZ_HOME: home };
for (const name of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR", "CAMOUFOX_EXECUTABLE"])
  if (process.env[name]) env[name] = process.env[name]!;
type Event = { type: string; target: string; key: string; trusted: boolean; at: number };
type Sample = { generation: number; sequence: number; values: Record<string, string>; events: Event[]; submits: number };
let sample: Sample | undefined, client: Client | undefined, started = false;
let generation = 0;
const checks: Array<{ check: string; [key: string]: unknown }> = [];
function assert(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  if (new URL(request.url).pathname === "/sample" && request.method === "POST") {
    const next = await request.json() as Sample;
    if (next.generation === generation && (!sample || next.sequence > sample.sequence)) sample = next;
    return new Response(null, { status: 204 });
  }
  if (new URL(request.url).pathname !== "/") return new Response(null, { status: 204 });
  generation++;
  return new Response(`<!doctype html><meta charset="utf-8"><title>stelz typing acceptance</title>
<style>body{font:20px system-ui;padding:30px}label,div,button{display:block;margin:16px}input,textarea{font:inherit}#editable{border:1px solid;padding:10px}</style>
<h1>Typing acceptance</h1><form><label>Message <input id="message" value="old value"></label><button>Submit message</button></form>
<label>Multiline <textarea id="multiline">old value</textarea></label>
<div id="editable" contenteditable="true" role="textbox" aria-label="Editable message">old value</div>
<label>Number <input id="number" type="number" value="1"></label>
<label>Password <input id="password" type="password"></label>
<label>Date <input id="date" type="date" value="2026-01-01"></label>
<p id="status">Ready</p><script>
const events = []; let submits = 0, sequence = 0, timer;
function publish() {
  const values = Object.fromEntries(['message','multiline','editable','number','date','password'].map(id => {
    const el = document.getElementById(id); return [id, el.value === undefined ? el.textContent : el.value];
  }));
  document.getElementById('status').textContent = 'Submissions: ' + submits;
  fetch('/sample', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({generation:${generation},sequence:++sequence,values,events,submits})});
}
for (const type of ['input','beforeinput','keydown','keypress','keyup']) document.addEventListener(type, event => {
  events.push({type,target:event.target.id,key:event.key||'',trusted:event.isTrusted,at:performance.now()});
  clearTimeout(timer); timer = setTimeout(publish, 50);
});
document.querySelector('form').onsubmit = event => { event.preventDefault(); submits++; publish(); };
publish();
</script>`, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
} });
const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = reservation.port;
reservation.stop(true);
async function command(...args: string[]) {
  assertTestHome(home);
  const child = Bun.spawn([process.execPath, "--no-env-file", cli, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw Error(`${args[0]}: ${err || out}`);
  return out;
}
async function connect() {
  client = routeProfileTools(new Client({ name: "typing-acceptance", version: "1.0.0" }), profileId);
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: ["--no-env-file", cli, "mcp"], env, stderr: "inherit" }));
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
async function type(tabId: string, selector: string, text: string, options: { mode?: TypingMode; pressEnter?: boolean } = {}) {
  await call("camofox_snapshot", { tabId });
  await call("camofox_type", { tabId, selector, text, ...options });
  await call("camofox_snapshot", { tabId });
}
function keyboardEvents(value: Sample, text: string) {
  const events = value.events.filter(event => event.target === "message");
  const down = events.filter(event => event.type === "keydown");
  let entered = "";
  for (const event of down) {
    if (event.key === "Backspace") entered = entered.slice(0, -1);
    else if (event.key.length === 1) entered += event.key;
  }
  assert(entered === text, "Keyboard events did not produce the requested ASCII text after corrections.");
  const printable = down.filter(event => event.key.length === 1).map(event => event.key).join("");
  for (const kind of ["keydown", "keypress", "keyup"]) {
    // Clearing an existing field can also emit Delete. Check printable keys separately.
    const keys = events.filter(event => event.type === kind && event.key.length === 1);
    assert(keys.map(event => event.key).join("") === printable, `${kind} did not match the typed ASCII keys.`);
  }
  assert(events.every(event => event.trusted), "Input events were not browser-generated.");
  assert(events.filter(event => event.type === "keydown" && event.key === "Enter").length === 1, "Enter was not pressed exactly once.");
}
try {
  writeFileSync(join(home, "profiles.json"), JSON.stringify({ profiles: [
    { id: profileId, port, storage: "native" },
  ] }), { mode: 0o600 });
  await command("setup", "--yes");
  started = true;
  await command("start", profileId); await connect();
  const tools = await client!.listTools();
  const schema = tools.tools.find(tool => tool.name === "camofox_type")!.inputSchema;
  assert(JSON.stringify((schema.properties!.mode as { enum: string[] }).enum) === JSON.stringify(["balanced", "keyboard", "instant"]), "The typing mode overrides are missing.");
  const tabId = String((await call("camofox_create_tab", { url: `http://127.0.0.1:${server.port}` })).tabId);
  const instanceId = (await call("profile_status")).instanceId;
  async function reset() {
    sample = undefined;
    await call("camofox_navigate", { tabId, url: `http://127.0.0.1:${server.port}` });
    await observed(value => value.values.message === "old value");
  }
  async function setDefault(mode: TypingMode) {
    assertTestHome(home);
    writeFileSync(join(home, "profiles.json"), JSON.stringify({ profiles: [
      { id: profileId, port, storage: "native", typingMode: mode },
    ] }), { mode: 0o600 });
  }
  const text = "Paced typing, with pauses.";
  await type(tabId, "#message", text, { pressEnter: true });
  const paced = await observed(value => value.values.message === text && value.submits === 1);
  const inputs = paced.events.filter(event => event.type === "input" && event.target === "message");
  const gaps = inputs.slice(2).map((event, i) => event.at - inputs[i + 1]!.at);
  assert(inputs.length >= text.length, "Paced typing did not produce per-character input events.");
  keyboardEvents(paced, text);
  assert(Math.max(...gaps) - Math.min(...gaps) > 20, "Typing intervals did not vary.");
  assert(paced.events.filter(event => event.type === "keydown" && event.key === "Enter").length === 1, "Enter was not pressed exactly once.");
  checks.push({ check: "paced replacement, varied timing, browser-generated events, one Enter", inputEvents: inputs.length,
    minIntervalMs: Math.round(Math.min(...gaps)), maxIntervalMs: Math.round(Math.max(...gaps)) });
  for (const [id, value, expected] of [
    ["message", "Cafe\u0301 👨‍👩‍👧‍👦 ქართული", "Cafe\u0301 👨‍👩‍👧‍👦 ქართული"],
    ["message", "one\ntwo", "onetwo"],
    ["multiline", "one\r\ntwo\rthree", "one\ntwo\nthree"],
    ["editable", "Editable words.", "Editable words."], ["number", "12.5", "12.5"], ["date", "2026-11-03", "2026-11-03"],
    ["password", "alpha bravo", "alpha bravo"],
    ["message", "", ""],
  ] as const) {
    await type(tabId, `#${id}`, value, { mode: "balanced" });
    await observed(sample => sample.values[id] === expected && sample.submits === 1);
  }
  checks.push({ check: "Unicode, single-line normalization, multiline, contenteditable, number, date, and empty input" });
  await reset();
  const bulk = "Bulk text 👋\n".repeat(1500);
  await type(tabId, "#multiline", bulk, { mode: "balanced" });
  const automaticBulk = await observed(value => value.values.multiline === bulk);
  assert(automaticBulk.events.filter(event => event.type === "input" && event.target === "multiline").length === 1, "Long balanced input did not select bulk entry before editing.");
  checks.push({ check: "balanced enters long text with one bulk fill", characters: bulk.length });

  await reset();
  const keys = "typing with variable gaps ".repeat(9);
  await setDefault("instant");
  await type(tabId, "#message", keys, { mode: "keyboard", pressEnter: true });
  const keyboard = await observed(value => value.values.message === keys && value.submits === 1);
  keyboardEvents(keyboard, keys);
  const keyEvents = keyboard.events.filter(event => event.type === "keydown" && event.target === "message");
  assert(keyEvents.at(-1)!.at - keyEvents[0]!.at > 10_000, "Keyboard input did not exercise typing beyond 10 seconds.");
  assert(keyboard.events.filter(event => event.type === "input" && event.target === "message").length >= keys.length, "Keyboard mode did not enter text character by character.");
  checks.push({ check: "keyboard override emits trusted keydown, keypress, keyup and input for long text, one Enter", characters: keys.length });

  await reset();
  await setDefault("keyboard");
  await type(tabId, "#message", "Instant short text", { mode: "instant", pressEnter: true });
  const instant = await observed(value => value.values.message === "Instant short text" && value.submits === 1);
  const bulkInputs = instant.events.filter(event => event.type === "input" && event.target === "message");
  assert(bulkInputs.length === 1, "Instant override did not use one bulk fill.");
  assert(instant.events.filter(event => event.type === "keydown").map(event => event.key).join("") === "Enter", "Instant entry sent character key events or duplicate Enter.");
  checks.push({ check: "instant override enters short text in bulk, one Enter", inputEvents: bulkInputs.length });

  for (const mode of ["keyboard", "instant", "balanced"] as const) {
    await setDefault(mode); await reset();
    await type(tabId, "#message", "Live default", { pressEnter: true });
    const state = await observed(value => value.values.message === "Live default" && value.submits === 1);
    const count = state.events.filter(event => event.type === "input" && event.target === "message").length;
    assert(mode === "instant" ? count === 1 : count >= "Live default".length, `${mode} profile default did not apply live.`);
  }
  await setDefault("instant"); await reset();
  await type(tabId, "#message", "Balanced override", { mode: "balanced", pressEnter: true });
  const override = await observed(value => value.values.message === "Balanced override" && value.submits === 1);
  keyboardEvents(override, "Balanced override");
  checks.push({ check: "all profile defaults apply live; explicit balanced overrides instant default" });
  const final = await call("profile_status");
  assert(final.phase === "ready" && final.instanceId === instanceId, "Typing mode changes replaced or blocked the running browser.");
  checks.push({ check: "same browser, tab, MCP connection, and controller remain usable without restart" });
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
