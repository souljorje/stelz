// Headed input acceptance through tab_type in a disposable profile.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { TypingMode } from "../../src/browser/typing.ts";
import { assertTestHome, createTestHome } from "../helpers/test-home.ts";
import { fixture, type InputSample } from "../helpers/fixture.ts";
import { parseToolText, routeProfileTools } from "../helpers/mcp-client.ts";
import { useRuntimeCache } from "../helpers/runtime-cache.ts";

/** The smoke suite lends one disposable profile and retains lifecycle ownership. A direct run creates and stops its own profile. */
export async function runTyping(shared?: { home: string; profileId: string; cli: string; site: Awaited<ReturnType<typeof fixture>> }) {
  const root = resolve(import.meta.dir, "../.."), cli = shared?.cli || process.env.STELZ_TEST_CLI || join(root, "src/cli/cli.ts");
  const profileId = shared?.profileId ?? "typing-check";
  const home = shared ? assertTestHome(shared.home) : createTestHome("typing-acceptance");
  const configPath = join(home, "profiles.json");
  const originalConfig = shared ? readFileSync(configPath, "utf8") : undefined;
  const reportPath = join(home, shared ? "typing-report.json" : "report.json");
  let failure: unknown, tabId: string | undefined;
  const env: Record<string, string> = { STELZ_HOME: home };
  for (const name of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR", "CAMOUFOX_EXECUTABLE"])
    if (process.env[name]) env[name] = process.env[name]!;
  type Sample = InputSample;
  let client: Client | undefined, started = false;
  // The typing fields are on the fixture page. The page reports their state after each input.
  const site = shared?.site ?? await fixture(0);
  const began = performance.now(), checks: Array<{ check: string; [key: string]: unknown }> = [], push = checks.push.bind(checks);
  checks.push = entry => push({ ...entry, atSeconds: Math.round((performance.now() - began) / 1000) });
  function assert(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
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
    return parseToolText(text) as Record<string, unknown>;
  }
  async function observed(predicate: (value: Sample) => boolean) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (site.input.sample && predicate(site.input.sample)) return site.input.sample;
      await Bun.sleep(20);
    }
    throw Error("The browser did not report the expected input state.");
  }
  async function type(tabId: string, selector: string, text: string, options: { mode?: TypingMode; pressEnter?: boolean } = {}) {
    await call("tab_snapshot", { tabId });
    await call("tab_type", { tabId, selector, text, ...options });
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
    if (!shared) {
      writeFileSync(configPath, JSON.stringify({ profiles: [{ id: profileId, port, storage: "native" }] }), { mode: 0o600 });
      // A direct run takes the browser and location data from the cache of the smoke suite.
      Object.assign(env, useRuntimeCache(home)); await command("setup", "--yes"); delete env.STELZ_RUNTIME;
      started = true;
      await command("start", profileId);
    }
    await connect();
    const tools = await client!.listTools();
    const schema = tools.tools.find(tool => tool.name === "tab_type")!.inputSchema;
    assert(JSON.stringify((schema.properties!.mode as { enum: string[] }).enum) === JSON.stringify(["balanced", "keyboard", "instant"]), "The typing mode overrides are missing.");
    site.input.sample = undefined;
    tabId = String((await call("tab_create", { url: site.url })).tabId);
    const instanceId = (await call("profile_status")).instanceId;
    async function reset() {
      site.input.sample = undefined;
      await call("tab_navigate", { tabId, url: site.url });
      await observed(value => value.values.message === "old value");
    }
    async function setDefault(mode: TypingMode) {
      assertTestHome(home);
      const config = JSON.parse(readFileSync(configPath, "utf8")) as { profiles: Array<{ id: string; typingMode?: TypingMode }> };
      const profile = config.profiles.find(value => value.id === profileId);
      assert(profile, "The typing test profile is missing from its disposable home.");
      profile.typingMode = mode;
      writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    }
    for (const [id, value, expected] of [
      ["message", "e\u0301 👨‍👩‍👧‍👦 ქ", "e\u0301 👨‍👩‍👧‍👦 ქ"],
      ["message", "a\nb", "ab"],
      ["multiline", "a\r\nb\rc", "a\nb\nc"],
      ["editable", "Edit me.", "Edit me."], ["number", "12.5", "12.5"], ["date", "2026-11-03", "2026-11-03"],
      ["message", "", ""],
    ] as const) {
      await type(tabId, `#${id}`, value, { mode: "balanced" });
      // No value has Enter as a key, so the form stays unsubmitted.
      await observed(sample => sample.values[id] === expected && sample.submits === 0);
    }
    checks.push({ check: "Unicode, a newline that does not submit, multiline, contenteditable, number, date, and empty input" });
    await reset();
    const bulk = "Bulk text 👋\n".repeat(1500);
    await type(tabId, "#multiline", bulk, { mode: "balanced" });
    const automaticBulk = await observed(value => value.values.multiline === bulk);
    assert(automaticBulk.events.filter(event => event.type === "input" && event.target === "multiline").length === 1, "Long balanced input did not select bulk entry before editing.");
    checks.push({ check: "balanced enters long text with one bulk fill", characters: bulk.length });

    await reset();
    // Keyboard mode must pace past the 10-second budget of balanced mode. This text takes about 15 seconds.
    const keys = "typing with variable gaps ".repeat(5);
    await setDefault("instant");
    await type(tabId, "#message", keys, { mode: "keyboard", pressEnter: true });
    const keyboard = await observed(value => value.values.message === keys && value.submits === 1);
    keyboardEvents(keyboard, keys);
    const keyEvents = keyboard.events.filter(event => event.type === "keydown" && event.target === "message");
    assert(keyEvents.at(-1)!.at - keyEvents[0]!.at > 10_000, "Keyboard input did not exercise typing beyond 10 seconds.");
    const inputs = keyboard.events.filter(event => event.type === "input" && event.target === "message");
    assert(inputs.length >= keys.length, "Keyboard mode did not enter text character by character.");
    const gaps = inputs.slice(2).map((event, i) => event.at - inputs[i + 1]!.at);
    assert(Math.max(...gaps) - Math.min(...gaps) > 20, "Typing intervals did not vary.");
    // The helper checks the message field. Also reject an extra Enter on another element.
    assert(keyboard.events.filter(event => event.type === "keydown" && event.key === "Enter").length === 1, "Enter was not pressed exactly once across the page.");
    checks.push({ check: "keyboard override of an instant default: paced replacement of long text, varied timing, trusted key events, one Enter", characters: keys.length,
      minIntervalMs: Math.round(Math.min(...gaps)), maxIntervalMs: Math.round(Math.max(...gaps)) });

    for (const mode of ["instant", "balanced"] as const) {
      await setDefault(mode); await reset();
      await type(tabId, "#message", "Live", { pressEnter: true });
      const state = await observed(value => value.values.message === "Live" && value.submits === 1);
      const count = state.events.filter(event => event.type === "input" && event.target === "message").length;
      assert(mode === "instant" ? count === 1 : count >= "Live".length, `${mode} profile default did not apply live.`);
    }
    checks.push({ check: "instant and balanced profile defaults apply live" });
    const final = await call("profile_status");
    assert(final.phase === "ready" && final.instanceId === instanceId, "Typing mode changes replaced or blocked the running browser.");
    checks.push({ check: "same browser, tab, MCP connection, and controller remain usable without restart" });

  } catch (error) {
    failure = error;
    checks.push({ check: "typing acceptance", error: String(error) });
  } finally {
    const cleanup = async (check: string, action: () => unknown) => {
      try { await action(); } catch (error) { failure ??= error; checks.push({ check, error: String(error) }); }
    };
    if (originalConfig !== undefined) await cleanup("restore profile configuration", () => writeFileSync(configPath, originalConfig, { mode: 0o600 }));
    if (client) {
      if (tabId) await cleanup("close typing fixture tab", () => call("tab_close", { tabId }));
      await cleanup("release typing control", () => call("profile_release"));
      await cleanup("disconnect typing client", () => client!.close());
    }
    if (started) await cleanup("explicit stop", () => command("stop", profileId));
    if (!shared) site.stop();
    writeFileSync(reportPath, JSON.stringify({ result: failure ? "failed" : "passed", profileId, shared: !!shared, checks }, null, 2), { mode: 0o600 });
  }
  if (failure) throw failure;
  console.log(JSON.stringify({ result: "passed", profileId, shared: !!shared, report: reportPath }));
  return checks;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) {
    console.log("Use: bun tests/browser/typing.ts\nThe check creates and stops its own temporary profile.");
  } else {
    if (args.length) throw Error("Use: bun tests/browser/typing.ts. Existing profiles are not supported.");
    await runTyping();
  }
}
