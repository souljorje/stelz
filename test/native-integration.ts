// Requires the real installed Camoufox browser. No model or harness is used.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fixture } from "./fixture.ts";
import { compareObservations, type Observation } from "./observations.ts";

const root = resolve(import.meta.dir, "..");
mkdirSync(join(root, ".state"), { recursive: true });
const home = mkdtempSync(join(root, ".state/native-acceptance-"));
const cli = join(root, "dist/cli.js");
const env: Record<string, string> = { STELZ_HOME: home };
for (const key of ["PATH", "HOME", "LANG", "TMPDIR", "CAMOUFOX_EXECUTABLE"]) if (process.env[key]) env[key] = process.env[key]!;
const clients: Client[] = [], report: Record<string, unknown>[] = [];
let site: Awaited<ReturnType<typeof fixture>> | undefined;
function assert(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
async function command(...args: string[]) {
  const child = Bun.spawn([Bun.which("bun")!, "--no-env-file", cli, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw Error(`${args.join(" ")}: ${err || out}`);
}
async function connect(id: string) {
  const client = new Client({ name: "native-acceptance", version: "1.0.0" }); clients.push(client);
  await client.connect(new StdioClientTransport({ command: Bun.which("bun")!, args: ["--no-env-file", cli, "mcp", "--profile", id], env }));
  await call(client, "profile_acquire"); return client;
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  const text = (result.content as Array<{ type: string; text?: string }>).filter(c => c.type === "text").map(c => c.text).join("\n");
  if (result.isError) throw Error(text);
  return JSON.parse(text) as Record<string, unknown>;
}
async function observation(id: string): Promise<Observation> {
  for (let n = 0; n < 200; n++) {
    const value = site?.observations.get(id); if (value) return value;
    await Bun.sleep(50);
  }
  throw Error(`No complete browser observation received for ${id}`);
}
async function stored(client: Client, tabId: string, id: string) {
  for (let n = 0; n < 30; n++) {
    const value = await call(client, "camofox_snapshot", { tabId });
    if (String(value.snapshot).includes(`Storage marker: ${id}`)) return;
    await Bun.sleep(100);
  }
  throw Error(`Cookie/localStorage/IndexedDB marker did not persist for ${id}`);
}
try {
  console.log(`Explicit direct-development native-profile test. Evidence: ${home}`);
  await command("init");
  const ids = ["profile-01", "profile-02"];
  writeFileSync(join(home, "profiles.json"), JSON.stringify({ maxActive: 2,
    profiles: ids.map((id, i) => ({ id, port: 9571 + i, mode: "direct", storage: "native" })) }));
  await command("setup"); site = await fixture(9510);
  await Promise.all(ids.map(id => command("start", id)));
  const before: Record<string, Observation> = {}, pins: Record<string, string> = {};
  for (const id of ids) {
    const client = await connect(id);
    const tab = await call(client, "camofox_create_tab", { url: `http://127.0.0.1:9510/?capture=before-${id}` });
    const tabId = String(tab.tabId);
    await call(client, "camofox_type", { tabId, selector: "#marker", text: id });
    await call(client, "camofox_click", { tabId, selector: "#save" }); await stored(client, tabId, id);
    before[id] = await observation(`before-${id}`);
    pins[id] = readFileSync(join(home, "profiles", id, "fingerprint.json"), "utf8");
    assert(existsSync(join(home, "profiles", id, "browser-data", "cookies.sqlite")), "Native Firefox profile was not created");
    await client.close();
  }
  await command("stop", "all"); await command("start", "all");
  for (const id of ids) {
    const client = await connect(id);
    const tab = await call(client, "camofox_create_tab", { url: `http://127.0.0.1:9510/?capture=after-${id}` });
    await stored(client, String(tab.tabId), id);
    const after = await observation(`after-${id}`), comparison = compareObservations(before[id]!, after);
    assert(readFileSync(join(home, "profiles", id, "fingerprint.json"), "utf8") === pins[id], "Saved fingerprint changed");
    report.push({ profile: id, before: before[id], after, ...comparison, nativeStoragePersisted: true });
    assert(comparison.stableDifferences.length === 0, `Observable profile changed: ${comparison.stableDifferences.join(", ")}`);
    await client.close();
  }
  report.push({ check: "Native storage isolation and observable profile continuity", result: "passed" });
} catch (error) { report.push({ check: "Native acceptance", result: "failed", error: String(error) }); process.exitCode = 1; }
finally {
  for (const client of clients) await client.close().catch(() => {});
  await command("stop", "all").catch(() => {}); site?.stop();
  writeFileSync(join(home, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
