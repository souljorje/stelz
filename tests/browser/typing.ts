// Real key events through tab_type, in a profile and browser of its own. tests/browser/smoke.ts runs it beside its other checks.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { TypingMode } from "../../src/browser/typing.ts";
import { assertTestHome } from "../helpers/test-home.ts";
import { useEphemeralProfilePort } from "../helpers/ports.ts";
import type { fixture, InputSample } from "../helpers/fixture.ts";
import { parseToolText, routeProfileTools } from "../helpers/mcp-client.ts";

/** Create, start, and stop the typing profile in a test home that setup prepared. The typing fields are on the fixture page. */
export async function runTyping({ home, cli, site, env }: { home: string; cli: string; site: Awaited<ReturnType<typeof fixture>>; env: Record<string, string> }) {
  const profileId = "typing-check", configPath = join(assertTestHome(home), "profiles.json");
  let failure: unknown, client: Client | undefined, started = false;
  // Each page load has its own input key, so a check reads the reports of its own document.
  let key = "", loads = 0;
  type Sample = InputSample;
  const began = performance.now(), checks: Array<{ check: string; [key: string]: unknown }> = [], push = checks.push.bind(checks);
  checks.push = entry => push({ ...entry, atSeconds: Math.round((performance.now() - began) / 1000) });
  function assert(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
  async function command(...args: string[]) {
    const child = Bun.spawn([process.execPath, "--no-env-file", cli, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code) throw Error(`${args[0]}: ${err || out}`);
    return out;
  }
  async function call(name: string, args: Record<string, unknown> = {}) {
    const response = await client!.callTool({ name, arguments: args }, undefined, { timeout: 65_000 });
    const text = (response.content as Array<{ type: string; text?: string }>).filter(block => block.type === "text").map(block => block.text).join("\n");
    if (response.isError) throw Error(`${name}: ${text}`);
    return parseToolText(text) as Record<string, unknown>;
  }
  async function observed(predicate: (value: Sample) => boolean) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const sample = site.input.get(key);
      if (sample && predicate(sample)) return sample;
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
    await command("profile", "create", profileId, "--direct", "--json");
    await useEphemeralProfilePort(home, profileId);
    started = true;
    await command("start", profileId);
    client = routeProfileTools(new Client({ name: "typing-acceptance", version: "1.0.0" }), profileId);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--no-env-file", cli, "mcp"], env, stderr: "inherit" }));
    await call("profile_acquire");
    const schema = (await client.listTools()).tools.find(tool => tool.name === "tab_type")!.inputSchema;
    assert(JSON.stringify((schema.properties!.mode as { enum: string[] }).enum) === JSON.stringify(["balanced", "keyboard", "instant"]), "The typing mode overrides are missing.");
    const tabId = ((await call("tab_list")).tabs as { tabId: string }[])[0]!.tabId, instanceId = (await call("profile_status")).instanceId;
    async function reset() {
      key = `typing-${++loads}`;
      await call("tab_navigate", { tabId, url: `${site.url}/?input=${key}` });
      await observed(value => value.values.message === "old value");
    }
    /** Change the typing mode of this profile only. The rename replaces the catalog at once, beside the other checks that read it. */
    function setDefault(mode: TypingMode) {
      const config = JSON.parse(readFileSync(configPath, "utf8")) as { profiles: Array<{ id: string; typingMode?: TypingMode }> };
      const profile = config.profiles.find(value => value.id === profileId);
      assert(profile, "The typing test profile is missing from its disposable home.");
      profile.typingMode = mode;
      writeFileSync(`${configPath}.typing`, JSON.stringify(config), { mode: 0o600 });
      renameSync(`${configPath}.typing`, configPath);
    }
    await reset();
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
    setDefault("instant");
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
      setDefault(mode); await reset();
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
    if (client) await cleanup("disconnect typing client", () => client!.close());
    if (started) await cleanup("explicit stop", () => command("stop", profileId));
    writeFileSync(join(home, "typing-report.json"), JSON.stringify({ result: failure ? "failed" : "passed", profileId, checks }, null, 2), { mode: 0o600 });
  }
  if (failure) throw failure;
  return checks;
}
