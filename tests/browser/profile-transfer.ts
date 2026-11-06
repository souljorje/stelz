// Exercise ZIP portability with synthetic local data in a new, owned service home.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fixture } from "../helpers/fixture.ts";
import { assertTestHome, createTestHome } from "../helpers/test-home.ts";
import { unusedPorts } from "../helpers/ports.ts";

const root = resolve(import.meta.dir, "../.."), home = createTestHome("transfer-native", join(root, ".state"));
const cli = process.env.STELZ_TEST_CLI || join(root, "dist/cli.js");
const env: Record<string, string> = { STELZ_HOME: home };
for (const key of ["PATH", "HOME", "LANG", "TMPDIR", "CAMOUFOX_EXECUTABLE"]) if (process.env[key]) env[key] = process.env[key]!;
const clients = new Set<Client>(), active = new Set<string>();
const marker = "portable-synthetic-session", source = "transfer-source";
let site: Awaited<ReturnType<typeof fixture>> | undefined;
function assert(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
async function command(...args: string[]) {
  assertTestHome(home);
  const child = Bun.spawn([process.execPath, "--no-env-file", cli, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw Error(`${args[0]} ${args[1] ?? ""}: ${err || out}`);
  return out;
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
  const text = (response.content as { type: string; text?: string }[]).filter(item => item.type === "text").map(item => item.text).join("\n");
  if (response.isError) throw Error(text);
  return JSON.parse(text) as Record<string, unknown>;
}
async function connect(id: string) {
  const client = new Client({ name: "profile-transfer-acceptance", version: "1.0.0" }); clients.add(client);
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--no-env-file", cli, "mcp", "--profile", id], env }));
  await call(client, "profile_status"); await call(client, "profile_acquire"); await call(client, "camofox_list_tabs");
  return client;
}
async function release(client: Client) { await call(client, "profile_release"); await client.close(); clients.delete(client); }
async function observe(name: string) {
  for (let index = 0; index < 200; index++) {
    const value = site?.observations.get(name);
    if (value) return value;
    await Bun.sleep(50);
  }
  throw Error("The local storage observation did not arrive.");
}
async function requireMarker(client: Client, tabId: string) {
  for (let index = 0; index < 100; index++) {
    const snapshot = await call(client, "camofox_snapshot", { tabId });
    if (String(snapshot.snapshot).includes(`Storage marker: ${marker}`)) return;
    await Bun.sleep(50);
  }
  throw Error("The saved storage marker is missing.");
}
let passed = false;
try {
  await command("init"); await command("setup"); site = await fixture(0);
  await command("profile", "create", source, "--direct", "--json");
  active.add(source); await command("start", source);
  const original = await connect(source);
  const tabId = String((await call(original, "camofox_create_tab", { url: site.url })).tabId);
  await call(original, "camofox_snapshot", { tabId });
  await call(original, "camofox_type", { tabId, selector: "#marker", text: marker });
  await call(original, "camofox_snapshot", { tabId });
  await call(original, "camofox_click", { tabId, selector: "#save" });
  await requireMarker(original, tabId);
  await release(original); await command("stop", source); active.delete(source);
  const profilePath = (id: string, path: string) => join(home, "profiles", id, path);
  const pin = readFileSync(profilePath(source, "fingerprint.json"));
  const accessKey = readFileSync(profilePath(source, "access-key"), "utf8");
  const cookieBytes = readFileSync(profilePath(source, "browser-data/cookies.sqlite"));
  const secondId = "transfer-second";
  const config = JSON.parse(readFileSync(join(home, "profiles.json"), "utf8"));
  config.profiles.push({ id: secondId, port: (await unusedPorts(1))[0]!, storage: "native" });
  writeFileSync(join(home, "profiles.json"), JSON.stringify(config));
  const archive = join(home, "roundtrip.stelz-profiles.zip");
  await command("profile", "export", source, secondId, "--output", archive, "--json");
  const result = JSON.parse(await command("profile", "import", archive, "--json"));
  const copied = result.profiles.find((p: { sourceId: string }) => p.sourceId === source).id as string;
  assert(copied !== source, "Import did not create a separate copy.");
  assert(readFileSync(profilePath(copied, "fingerprint.json")).equals(pin), "Import changed the fingerprint pin.");
  assert(readFileSync(profilePath(copied, "browser-data/cookies.sqlite")).equals(cookieBytes), "Import changed the saved cookie database.");
  const statuses = JSON.parse(await command("status", copied));
  assert(statuses.phase === "stopped", "Import started a browser implicitly.");
  active.add(copied); await command("start", copied);
  const imported = await connect(copied);
  const copiedTab = String((await call(imported, "camofox_create_tab", { url: site.url + "/?capture=imported-copy" })).tabId);
  await requireMarker(imported, copiedTab);
  const observation = await observe("imported-copy");
  const storage = observation.storage as { cookie: string; localStorage: string; indexedDB: string };
  assert(storage.cookie.split(";").some(value => value.trim() === `profile=${marker}`), "Imported cookies did not persist.");
  assert(storage.localStorage === marker, "Imported localStorage did not persist.");
  assert(storage.indexedDB === marker, "Imported IndexedDB did not persist.");
  assert(readFileSync(profilePath(copied, "fingerprint.json")).equals(pin), "Starting the imported profile changed its fingerprint.");
  assert(readFileSync(profilePath(copied, "access-key"), "utf8") !== accessKey, "Import reused the source service key.");
  const copiedConfig = JSON.parse(readFileSync(join(home, "profiles.json"), "utf8")).profiles.find((p: { id: string }) => p.id === copied);
  let windowsConnected = false;
  for (let index = 0; index < 100; index++) {
    const response = await fetch(`http://127.0.0.1:${copiedConfig.port}/local-profile/windows`, {
      headers: { Authorization: `Bearer ${readFileSync(profilePath(copied, "access-key"), "utf8").trim()}` },
    });
    const inventory = await response.json() as { available: boolean; windows: { title: string }[] };
    if (response.ok && inventory.available && inventory.windows.some(window => window.title.startsWith(`[${copied}]`))) { windowsConnected = true; break; }
    await Bun.sleep(100);
  }
  assert(windowsConnected, "The imported browser did not reconnect its window controls to the copied profile.");
  await release(imported); await command("stop", copied); active.delete(copied);
  passed = true;
  const report = { result: "passed", home, archive, source, imported: copied, importedCount: result.profiles.length,
    checks: ["batch copy", "stopped import", "cookie database bytes", "live cookies", "localStorage", "IndexedDB", "fingerprint bytes", "fresh access key", "copied window controls"] };
  mkdirSync(join(root, ".state/profile-transfer"), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, ".state/profile-transfer/report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(report));
} finally {
  for (const client of clients) { try { await client.close(); } catch {} }
  for (const id of active) { try { await command("stop", id); } catch {} }
  await site?.stop();
  if (!passed) console.error(`Profile transfer evidence: ${home}`);
}
