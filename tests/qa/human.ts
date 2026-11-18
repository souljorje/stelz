// Requires a person at the visible browser, twice: one click while MCP actions are paused, then closing the window.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fixture } from "../helpers/fixture.ts";
import { unusedPorts } from "../helpers/ports.ts";
import { parseToolText, routeProfileTools } from "../helpers/mcp-client.ts";
import { saveRuntimeCache, useRuntimeCache } from "../helpers/runtime-cache.ts";
import { createTestHome } from "../helpers/test-home.ts";
const root = resolve(import.meta.dir, "../..");
const home = createTestHome("human-acceptance"), cli = process.env.STELZ_TEST_CLI || join(root, "src/cli/cli.ts"), id = "human-01";
const env: Record<string, string> = { STELZ_HOME: home };
for (const key of ["PATH", "HOME", "LANG", "TMPDIR", "CAMOUFOX_EXECUTABLE"]) if (process.env[key]) env[key] = process.env[key]!;
const report: unknown[] = [], client = routeProfileTools(new Client({ name: "human-acceptance", version: "1.0.0" }), id);
let site: Awaited<ReturnType<typeof fixture>> | undefined;
const profileFile = (name: string) => readFileSync(join(home, "profiles", id, name), "utf8");
function assert(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
async function command(...args: string[]) {
  const p = Bun.spawn([Bun.which("bun")!, "--no-env-file", cli, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code) throw Error(`${args.join(" ")}: ${err || out}`);
  return out;
}
async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  if (result.isError) throw Error(`MCP ${name} rejected`);
  return parseToolText((result.content as Array<{ type: string; text?: string }>).filter(v => v.type === "text").map(v => v.text).join("\n")) as Record<string, unknown>;
}
try {
  const ports = await unusedPorts(2);
  writeFileSync(join(home, "profiles.json"), JSON.stringify({ profiles: [{ id, port: ports[0]!, storage: "native" }] }), { mode: 0o600 });
  // A package run seeds the home from its installation. A source run keeps the browser and location data between runs.
  const seeded = !!process.env.STELZ_TEST_SEED_HOME;
  Object.assign(env, await useRuntimeCache(home));
  await command("setup", "--yes"); delete env.STELZ_RUNTIME;
  if (!seeded) saveRuntimeCache(home);
  site = await fixture(ports[1]!); await command("start", id);
  await client.connect(new StdioClientTransport({ command: Bun.which("bun")!, args: ["--no-env-file", cli, "mcp"], env }));
  await call("profile_acquire");
  // The page goes in the startup tab, so the profile has one window to click in and to close.
  const tabId = (await call("tab_list") as { tabs: { tabId: string }[] }).tabs[0]!.tabId;
  await call("tab_navigate", { tabId, url: `${site.url}/?profile=human-check&manual=takeover` });
  await call("tab_snapshot", { tabId });
  await call("tab_scroll", { tabId, direction: "down", amount: 400 });
  await call("tab_snapshot", { tabId });
  const instance = profileFile("running.json"), pin = profileFile("fingerprint.json");
  await call("profile_pause");
  assert((await client.callTool({ name: "tab_list", arguments: {} })).isError, "Paused profile allowed browser actions");
  console.log(`STEP 1 OF 2: Click "Human confirmation" in the window "Camoufox acceptance fixture — human-check". Evidence: ${home}`);
  for (const deadline = Date.now() + 15 * 60 * 1000; !site.manualConfirmations.has("takeover") && Date.now() < deadline;) await Bun.sleep(250);
  assert(site.manualConfirmations.get("takeover")?.trusted, "No human confirmation arrived before the deadline");
  assert((await call("profile_status")).phase === "paused", "Profile resumed before human confirmation");
  await call("profile_resume");
  assert(String((await call("tab_snapshot", { tabId })).snapshot).includes("Human confirmation received"), "Human action is absent from the resumed page");
  await call("tab_scroll", { tabId, direction: "up", amount: 100 });
  assert(profileFile("running.json") === instance, "Manual intervention replaced the browser service");
  assert(profileFile("fingerprint.json") === pin, "Manual intervention changed the device pin");
  report.push({ check: "Human interaction while paused, followed by MCP resume in the same browser and tab", result: "passed", tabId });
  await call("profile_release"); await client.close();
  console.log("STEP 2 OF 2: Close that browser window.");
  for (const deadline = Date.now() + 5 * 60 * 1000;;) {
    const phase = JSON.parse(await command("status", id)).phase;
    assert(phase !== "unclean", "Closing the browser left an unclean lifetime.");
    if (phase === "stopped") break;
    assert(Date.now() < deadline, "Window closure did not stop the profile within the deadline.");
    await Bun.sleep(250);
  }
  const instanceId = JSON.parse(instance).instanceId;
  assert(JSON.parse(profileFile("stopped.json")).instanceId === instanceId, "The window closure left no clean-stop receipt.");
  const restarted = JSON.parse(await command("start", id));
  assert(restarted.phase === "ready" && JSON.parse(profileFile("running.json")).instanceId !== instanceId && profileFile("fingerprint.json") === pin,
    "Explicit restart did not preserve the profile and create a new lifetime.");
  report.push({ check: "A closed browser window stops the profile cleanly, and an explicit start makes a new lifetime with the saved fingerprint", result: "passed" });
} catch (error) { report.push({ check: "Human acceptance", result: "failed", error: String(error) }); process.exitCode = 1; }
finally {
  await client.close().catch(() => {}); await command("stop", "all").catch(() => {}); site?.stop();
  writeFileSync(join(home, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 }); console.log(JSON.stringify(report, null, 2));
  console.log("Report: " + join(home, "report.json"));
}
