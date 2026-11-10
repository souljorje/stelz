// Real acceptance against one saved archive. Private proxy inputs never enter reports.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { installPackage } from "./install.ts";
import { packageArguments, assertArchiveUnchanged } from "../../scripts/package-archive.ts";
import { suppliedProxyEndpoints, proxyRedactor } from "../helpers/proxy-acceptance-helpers.ts";
import { proxyRelay } from "../helpers/proxy-network-fixture.ts";
import { routeProfileTools } from "../helpers/mcp-client.ts";
import { assertSingleStartupWindow } from "../helpers/startup-window.ts";

const { archive } = packageArguments(process.argv.slice(2), []);
if (!archive || !process.env.PROXY_TEST_ENV || !process.env.CAMOUFOX_EXECUTABLE) throw Error("Supply --archive, PROXY_TEST_ENV, and CAMOUFOX_EXECUTABLE.");
const secrets = parseEnv(readFileSync(process.env.PROXY_TEST_ENV, "utf8"));
const endpoints = suppliedProxyEndpoints(secrets), redact = proxyRedactor([secrets.PROXY_TEST_URL, secrets.PROXY_TEST_SECOND_URL]);
// The package suite passes its installation, so one archive installation serves every installed check.
const installed: Awaited<ReturnType<typeof installPackage>> = process.env.STELZ_TEST_INSTALLATION
  ? JSON.parse(readFileSync(process.env.STELZ_TEST_INSTALLATION, "utf8")) : await installPackage(archive, { native: true, keep: true });
const env = { ...installed.env, CAMOUFOX_EXECUTABLE: process.env.CAMOUFOX_EXECUTABLE };
const LIFETIMES = 3;
const ids = ["location-a", "location-b", "location-c"], active = new Set<string>(), clients: Client[] = [];
const file = (id: string, name: string) => join(installed.home, "profiles", id, name);
const phase = (id: string) => { try { return JSON.parse(readFileSync(file(id, "status.json"), "utf8")).phase; } catch { return "stopped"; } };
const traffic: { profile: string; phase: string; host: string; time: string }[] = [];
const relays = ids.map((id, index) => proxyRelay(endpoints[index % endpoints.length]!.url,
  host => traffic.push({ profile: id, phase: phase(id), host, time: new Date().toISOString() })));
const observations = new Map<string, { timezone: string; locale: string; language: string; languages: string[]; marker: string | null; permission: string }>();
const localRequests: { profile: string; phase: string; path: string }[] = [];
const site = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url), id = url.searchParams.get("profile")!;
  if (!ids.includes(id)) return new Response("Unknown fixture", { status: 404 });
  localRequests.push({ profile: id, phase: phase(id), path: url.pathname });
  if (request.method === "POST") { observations.set(id, await request.json() as never); return new Response(null, { status: 204 }); }
  return new Response(`<!doctype html><title>Location acceptance</title><style>body{min-height:200vh}</style><p>Local location and storage fixture</p><script type="module">
    const id=new URL(location).searchParams.get('profile'), marker=localStorage.getItem('profile');localStorage.setItem('profile',id);
    const value={timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,locale:Intl.DateTimeFormat().resolvedOptions().locale,language:navigator.language,languages:[...navigator.languages],marker,permission:(await navigator.permissions.query({name:'geolocation'})).state};
    await fetch('/observed?profile='+id,{method:'POST',body:JSON.stringify(value)});
    </script>`, { headers: { "Content-Type": "text/html", "Cache-Control": "no-store" } });
} });
async function command(...args: string[]) {
  const child = Bun.spawn([installed.executable, ...args], { cwd: installed.cwd, env, stdout: "pipe", stderr: "pipe" });
  const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw Error(redact(`${args[0]} failed: ${error}`));
  return out && args[0] !== "setup" ? JSON.parse(out) : undefined;
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  const text = (response.content as { type: string; text?: string }[]).filter(v => v.type === "text").map(v => v.text).join("\n");
  if (response.isError) throw Error(redact(text));
  return JSON.parse(text);
}
const evidence: Record<string, unknown>[] = [], pins = new Map<string, string>();
const strata = { "fresh-proxy": 0, "saved-valid-proxy": 0 };
try {
  await command("setup", "--yes");
  const dataBefore = readFileSync(join(installed.home, "runtime/geoip/manifest.json"), "utf8");
  await command("setup", "--yes");
  assert.equal(readFileSync(join(installed.home, "runtime/geoip/manifest.json"), "utf8"), dataBefore);
  for (let i = 0; i < ids.length; i++) {
    await relays[i]!.start();
    // Private one-time inputs use an environment variable, not process arguments.
    const key = `LOCATION_PROXY_${i}`;
    Object.assign(env, { [key]: relays[i]!.url() });
    await command("profile", "create", ids[i]!, "--proxy-env", key, "--json");
    delete (env as Record<string, string>)[key];
  }
  for (let lifetime = 0; lifetime < LIFETIMES; lifetime++) {
    for (const id of ids) {
      const preflight = await command("recheck", id, "--json");
      const preflightIp = JSON.parse(readFileSync(file(id, "location.json"), "utf8")).prepared.ip;
      assert.equal(preflight.location.status, "ready"); assert.equal(preflight.location.browserStarted, false);
      assert.equal(phase(id), "stopped");
      const priorPin = existsSync(file(id, "fingerprint.json")) ? readFileSync(file(id, "fingerprint.json"), "utf8") : undefined;
      assert.equal(priorPin === undefined, lifetime === 0, `${id}: expected an absent initial pin and an existing pin on restart`);
      if (priorPin !== undefined) assert.equal(priorPin, pins.get(id), `${id}: saved pin changed before restart`);
      const stratum = priorPin === undefined ? "fresh-proxy" : "saved-valid-proxy";
      const trafficBefore = traffic.length, localBefore = localRequests.length;
      active.add(id);
      const started = await command("start", id, "--json");
      assert.equal(started.phase, "ready"); assert.equal(started.location.browser, "passed");
      assert.equal(started.location.geolocation, "configured");
      assert.equal(localRequests.length, localBefore, "A restored fixture page requested traffic before Ready");
      const client = routeProfileTools(new Client({ name: "location-acceptance", version: "1" }), id); clients.push(client);
      await client.connect(new StdioClientTransport({ command: installed.bun, args: ["--no-env-file", installed.installedCli, "mcp"], env, stderr: "pipe" }));
      await call(client, "profile_acquire");
      const tabs = await call(client, "camofox_list_tabs"); await assertSingleStartupWindow(installed.home, id, tabs);
      const tabId = tabs.tabs[0].tabId;
      observations.delete(id);
      await call(client, "camofox_navigate", { tabId, url: `http://127.0.0.1:${site.port}/?profile=${id}` });
      await call(client, "camofox_snapshot", { tabId });
      await call(client, "camofox_scroll", { tabId, direction: "down", amount: 100 });
      await call(client, "camofox_snapshot", { tabId });
      for (let n = 0; n < 100 && !observations.has(id); n++) await Bun.sleep(50);
      const observed = observations.get(id)!; assert(observed);
      assert.equal(observed.timezone, started.location.timezone);
      const normalized = (locale: string) => new Intl.Locale(locale).maximize().baseName;
      for (const locale of [observed.locale, observed.language, observed.languages[0]!]) assert.equal(normalized(locale), normalized(started.location.language));
      assert.notEqual(observed.permission, "granted");
      assert.equal(observed.marker, lifetime ? id : null);
      const fingerprint = readFileSync(file(id, "fingerprint.json"), "utf8");
      if (priorPin !== undefined) assert.equal(fingerprint, priorPin); else pins.set(id, fingerprint);
      evidence.push({ id, lifetime, stratum, scroll: "passed", preflightIp, browserExitIp: started.exitIp, preflight: preflight.location, verified: started.location, observed,
        startupTraffic: traffic.slice(trafficBefore), restoredFixtureRequestsBeforeReady: localRequests.length - localBefore - 2 });
      strata[stratum]++;
      await call(client, "profile_release"); await client.close(); clients.splice(clients.indexOf(client), 1);
    }
    for (const id of [...active]) { await command("stop", id); active.delete(id); }
    console.log(`Measured proxy lifetime ${lifetime + 1}/${LIFETIMES} for ${ids.length} profiles.`);
  }
  assert.equal(strata["fresh-proxy"], ids.length);
  assert.equal(strata["saved-valid-proxy"], ids.length * (LIFETIMES - 1));
  const differentTimezones = new Set(evidence.map(item => (item.verified as { timezone: string }).timezone)).size > 1;
  assertArchiveUnchanged(installed.candidate);
  const report = { result: "passed", archive, sha256: installed.candidate.sha256, home: installed.home, prefix: installed.prefix,
    platform: process.platform, arch: process.arch, bun: Bun.version, dataset: JSON.parse(dataBefore), differentTimezones,
    experiment: { lifetimesPerProfile: LIFETIMES, maximumActiveBrowsers: ids.length }, strata, evidence,
    trafficLimit: "Proxy CONNECT destinations and restored local-page requests were observed. TLS contents, OS traffic, and all Firefox background traffic are not isolated." };
  writeFileSync(join(installed.home, "location-acceptance.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ result: report.result, report: join(installed.home, "location-acceptance.json"), sha256: report.sha256, strata }));
} catch (error) {
  writeFileSync(join(installed.home, "location-acceptance-failure.json"), JSON.stringify({ error: redact(String(error)), strata, evidence, traffic, localRequests }, null, 2), { mode: 0o600 });
  console.error(redact(String(error))); process.exitCode = 1;
} finally {
  for (const client of clients) await client.close().catch(() => {});
  for (const id of active) await command("stop", id).catch(error => console.error(redact(String(error))));
  for (const relay of relays) await relay.stop(); site.stop(true);
}
