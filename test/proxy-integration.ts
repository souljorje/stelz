// Real proxy acceptance. Credentials come from a private file or environment.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer, connect as connectSocket, type Socket } from "node:net";
import { parseEnv } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fixture } from "./fixture.ts";
import { compareObservations, type Observation } from "./observations.ts";

const secrets = process.env.PROXY_TEST_ENV ? parseEnv(readFileSync(process.env.PROXY_TEST_ENV, "utf8")) : process.env;
let proxyURL: URL;
try { proxyURL = new URL(secrets.PROXY_TEST_URL || ""); }
catch { throw Error("Set a valid PROXY_TEST_URL in the private env file. Credentials are hidden."); }
if (proxyURL.protocol !== "http:") throw Error("This acceptance test requires an HTTP proxy");
const root = resolve(import.meta.dir, ".."); mkdirSync(join(root, ".state"), { recursive: true });
const home = mkdtempSync(join(root, ".state/proxy-acceptance-")), cli = join(root, "dist/cli.js");
const ids = ["profile-01", "profile-02"], clients: Client[] = [], report: unknown[] = [];
const env: Record<string, string> = { STELZ_HOME: home };
for (const key of ["PATH", "HOME", "LANG", "TMPDIR", "CAMOUFOX_EXECUTABLE"]) if (process.env[key]) env[key] = process.env[key]!;
let site: Awaited<ReturnType<typeof fixture>> | undefined;
const sockets = new Set<Socket>();
const relay = createServer(incoming => {
  const upstream = connectSocket(Number(proxyURL.port || 80), proxyURL.hostname);
  for (const socket of [incoming, upstream]) { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); }
  incoming.on("error", () => upstream.destroy()); upstream.on("error", () => incoming.destroy());
  incoming.pipe(upstream).pipe(incoming);
});
function assert(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
async function command(...args: string[]) {
  const child = Bun.spawn([Bun.which("bun")!, "--no-env-file", cli, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw Error(`${args.join(" ")}: ${err || out}`);
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const value = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  if (value.isError) throw Error(`MCP ${name} rejected`);
  return JSON.parse((value.content as Array<{ type: string; text?: string }>).filter(v => v.type === "text").map(v => v.text).join("\n")) as Record<string, unknown>;
}
async function client(id: string) {
  const value = new Client({ name: "proxy-acceptance", version: "1.0.0" }); clients.push(value);
  await value.connect(new StdioClientTransport({ command: Bun.which("bun")!, args: ["--no-env-file", cli, "mcp", "--profile", id], env }));
  await call(value, "profile_acquire"); return value;
}
function configuration(mode: "direct" | "proxy", expected: string) {
  writeFileSync(join(home, "profiles.json"), JSON.stringify({ maxActive: 2, profiles: ids.map((id, i) => ({ id, port: 9771 + i, mode, storage: "native", proxyEnv: "TEST_PROXY_URL", expectedIPEnv: "TEST_EXPECTED_IP" })) }));
  const address = relay.address(); assert(address && typeof address !== "string", "Proxy relay is unavailable");
  const url = new URL(proxyURL); url.hostname = "127.0.0.1"; url.port = String(address.port);
  writeFileSync(join(home, "secrets.env"), `TEST_PROXY_URL=${url.href}\nTEST_EXPECTED_IP=${expected}\n`, { mode: 0o600 });
}
const profileFile = (id: string, name: string) => join(home, "profiles", id, name);
async function capture(c: Client, id: string, stage: string, initialize = false): Promise<Observation> {
  const key = `${stage}-${id}`;
  const tab = await call(c, "camofox_create_tab", { url: `http://127.0.0.1:9710/?network=1&capture=${key}` });
  await call(c, "camofox_snapshot", { tabId: tab.tabId });
  if (initialize) {
    await call(c, "camofox_type", { tabId: tab.tabId, selector: "#marker", text: id });
    await call(c, "camofox_snapshot", { tabId: tab.tabId });
    await call(c, "camofox_click", { tabId: tab.tabId, selector: "#save" });
  }
  let stored = false;
  for (let n = 0; n < 10; n++) {
    const snapshot = await call(c, "camofox_snapshot", { tabId: tab.tabId });
    if (String(snapshot.snapshot).includes(`Storage marker: ${id}`)) { stored = true; break; }
    await Bun.sleep(100);
  }
  assert(stored, "Native storage marker is missing");
  for (let n = 0; n < 100; n++) {
    const sample = site!.observations.get(key); if (sample) return sample;
    await Bun.sleep(100);
  }
  throw Error("Browser network observation is missing");
}
async function closeClients() { for (const c of clients.splice(0)) await c.close().catch(() => {}); }
try {
  console.log(`Real proxy acceptance. Evidence: ${home}`);
  await new Promise<void>(resolve => relay.listen(0, "127.0.0.1", resolve));
  const ip = await (await fetch("https://api.ipify.org?format=json", { proxy: proxyURL.href, signal: AbortSignal.timeout(20000) })).json() as { ip: string };
  assert(!secrets.PROXY_TEST_EXPECTED_IP || secrets.PROXY_TEST_EXPECTED_IP === ip.ip, "Proxy preflight exit differs from expected IP");
  const geo = await (await fetch(`https://ipwho.is/${ip.ip}`, { signal: AbortSignal.timeout(20000) })).json() as { success: boolean; country_code: string };
  assert(geo.success && geo.country_code === "US", "Proxy exit did not geolocate to the US");
  report.push({ check: "Supplied HTTP proxy", exitIp: ip.ip, country: geo.country_code, endpointsSupplied: 1 });
  await command("init"); configuration("direct", ""); await command("setup"); site = await fixture(9710);
  await Promise.all(ids.map(id => command("start", id)));
  const pins: Record<string, string> = {}, before: Record<string, Observation> = {}, proxied: Record<string, Observation> = {};
  for (const id of ids) { const c = await client(id); before[id] = await capture(c, id, "direct", true); pins[id] = readFileSync(profileFile(id, "fingerprint.json"), "utf8"); }
  await closeClients(); await command("stop", "all"); configuration("proxy", ip.ip);
  for (const stage of ["proxy", "proxy-restart"]) {
    await Promise.all(ids.map(id => command("start", id)));
    for (const id of ids) {
      const c = await client(id), sample = await capture(c, id, stage);
      assert(sample.exitIp === ip.ip, "Browser exit IP changed"); assert(sample.webRTCEnabled === false, "WebRTC remains enabled behind the proxy");
      assert(sample.exitIp !== before[id]!.exitIp, "Proxy used the direct exit IP");
      assert(readFileSync(profileFile(id, "fingerprint.json"), "utf8") === pins[id], "Device pin changed during proxy transition");
      const comparison = compareObservations(stage === "proxy" ? before[id]! : proxied[id]!, sample);
      const differences = comparison.stableDifferences.filter(key => stage !== "proxy" || !["languages", "timezone"].includes(key));
      assert(differences.length === 0, `Device drift: ${differences.join(", ")}`);
      if (stage === "proxy") proxied[id] = sample;
      report.push({ check: stage, profile: id, sample, ...comparison });
    }
    await closeClients(); await command("stop", "all");
  }
  configuration("proxy", "192.0.2.1");
  await command("start", ids[0]!);
  const mismatch = await client(ids[0]!);
  assert((await call(mismatch, "profile_status")).phase === "verification_failed", "Mismatched expected IP did not block the profile");
  let rejected = false;
  try { await call(mismatch, "camofox_list_tabs"); } catch { rejected = true; }
  assert(rejected, "Mismatched expected IP permitted browser actions");
  await closeClients();
  await command("stop", "all");
  report.push({ check: "Mismatched expected IP blocks browser actions", result: "passed" });
  configuration("proxy", ip.ip); await Promise.all(ids.map(id => command("start", id)));
  const active = await Promise.all(ids.map(client));
  const instances = ids.map(id => readFileSync(profileFile(id, "running.json"), "utf8"));
  const address = relay.address();
  assert(address && typeof address !== "string", "Proxy relay is unavailable");
  const relayPort = address.port;
  const relayClosed = new Promise<void>(resolve => relay.close(() => resolve()));
  for (const socket of sockets) socket.destroy();
  await relayClosed;
  await Promise.all(active.map(async (c, i) => {
    let blocked = false; try { await call(c, "camofox_list_tabs"); } catch { blocked = true; }
    assert(blocked, "Browser action succeeded after proxy loss");
    const status = await call(c, "profile_status"); assert(status.phase === "verification_failed", "Proxy loss did not block the profile");
    assert(readFileSync(profileFile(ids[i]!, "running.json"), "utf8") === instances[i], "Proxy loss replaced the browser service");
  }));
  report.push({ check: "Live proxy loss blocks both profiles without direct fallback or replacement", result: "passed" });
  await new Promise<void>(resolve => relay.listen(relayPort, "127.0.0.1", resolve));
  await Promise.all(active.map(async (c, i) => {
    await call(c, "profile_recheck");
    await call(c, "camofox_list_tabs");
    assert(readFileSync(profileFile(ids[i]!, "running.json"), "utf8") === instances[i], "Recheck replaced the browser service");
  }));
  report.push({ check: "Explicit recheck restores control after proxy recovery", result: "passed" });
} catch (error) {
  let message = String(error);
  for (const secret of [proxyURL.href, proxyURL.username, proxyURL.password, decodeURIComponent(proxyURL.username), decodeURIComponent(proxyURL.password)].filter(Boolean)) message = message.replaceAll(secret, "[redacted]");
  report.push({ check: "Proxy acceptance", result: "failed", error: message }); process.exitCode = 1;
} finally {
  await closeClients(); await command("stop", "all").catch(() => {}); site?.stop();
  relay.close(); for (const socket of sockets) socket.destroy();
  rmSync(join(home, "secrets.env"), { force: true });
  writeFileSync(join(home, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
