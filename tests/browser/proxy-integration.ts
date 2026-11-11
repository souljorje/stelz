// Live acceptance only. The offline tests do not import or execute this file.
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { dedicatedProxyInputs } from "../helpers/dedicated-proxy.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fixture } from "../helpers/fixture.ts";
import { compareObservations, type Observation } from "../helpers/observations.ts";
import {
  assert, assertDistinctExits, assertFreshVerificationCache, assertNoFallback, assertProxyRoute, assertRoutingCoverage, exitIP,
  proxyRedactor, proxyTestConfiguration, suppliedProxyEndpoints, PROXY_PROFILE_IDS as ids,
  type Pair, type ProbeResult, type ProxyLifetime,
} from "../helpers/proxy-acceptance-helpers.ts";
import { assertRelayTraffic, networkProbe, probeExit, proxyRelay } from "../helpers/proxy-network-fixture.ts";
import { unusedPorts } from "../helpers/ports.ts";
import { routeProfileTools } from "../helpers/mcp-client.ts";
import { assertSingleStartupWindow } from "../helpers/startup-window.ts";
import { createTestHome } from "../helpers/test-home.ts";

const root = resolve(import.meta.dir, "../.."), cli = process.env.STELZ_TEST_CLI || join(root, "src/cli/cli.ts");
const CACHE_MS = 120_000;
const clients: Client[] = [], owned = new Set<string>(), report: unknown[] = [];
const relays: ReturnType<typeof proxyRelay>[] = [];
const env: Record<string, string> = { STELZ_IP_CHECK_INTERVAL_MS: String(CACHE_MS) };
for (const key of ["PATH", "HOME", "LANG", "TMPDIR", "CAMOUFOX_EXECUTABLE"]) if (process.env[key]) env[key] = process.env[key]!;
let home: string | undefined, site: Awaited<ReturnType<typeof fixture>> | undefined;
let probe: ReturnType<typeof networkProbe> | undefined, shared = false;
let redact = proxyRedactor([process.env.PROXY_TEST_URL, process.env.PROXY_TEST_SECOND_URL]);
// One supplied route serves both relays. Relay evidence then identifies each route; exit IPs cannot.

async function command(...args: string[]) {
  const child = Bun.spawn([Bun.which("bun")!, "--no-env-file", cli, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw Error(redact(`${args.join(" ")}: ${err || out}`));
}
async function tool(client: Client, name: string, args: Record<string, unknown> = {}) {
  return client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await tool(client, name, args);
  const text = (result.content as Array<{ type: string; text?: string }>).filter(value => value.type === "text").map(value => value.text).join("\n");
  if (result.isError) throw Error(redact(`MCP ${name} rejected: ${text}`));
  return JSON.parse(text) as Record<string, unknown>;
}
async function rejected(client: Client, name: string) {
  // A broken transport must fail acceptance, rather than count as policy rejection.
  assert((await tool(client, name)).isError === true, `MCP ${name} unexpectedly succeeded.`);
}
async function client(id: string) {
  const value = routeProfileTools(new Client({ name: "two-proxy-acceptance", version: "1.0.0" }), id); clients.push(value);
  const transport = new StdioClientTransport({
    command: Bun.which("bun")!, args: ["--no-env-file", cli, "mcp"], env, stderr: "pipe",
  });
  // The SDK otherwise inherits stderr and could print upstream credentials.
  transport.stderr?.on("data", () => {});
  await value.connect(transport);
  const status = await call(value, "profile_status"); await call(value, "profile_acquire");
  await assertSingleStartupWindow(home!, id, status.phase === "ready" ? await call(value, "camofox_list_tabs") : undefined);
  report.push({ check: "Startup leaves only one blank native window", profile: id, phase: status.phase, result: "passed" });
  return value;
}
async function closeClients() {
  for (const value of clients.splice(0)) {
    await call(value, "profile_release").catch(() => {});
    await value.close().catch(() => {});
  }
}
async function startProfiles() {
  for (const id of ids) { owned.add(id); await command("start", id); }
}
async function stopProfiles() {
  const failures: string[] = [];
  for (const id of [...owned]) {
    try { await command("stop", id); owned.delete(id); }
    catch (error) { failures.push(redact(String(error))); }
  }
  assert(failures.length === 0, failures.join("\n"));
}
const profileFile = (id: string, name: string) => join(home!, "profiles", id, name);
const running = () => ids.map(id => readFileSync(profileFile(id, "running.json"), "utf8")) as unknown as Pair<string>;
function unchanged(instances: Pair<string>) {
  for (const index of [0, 1]) assert(running()[index] === instances[index], "A network check or relay fault replaced a browser service.");
}
async function capture(c: Client, id: string, stage: string, fixturePort: number, initialize = false): Promise<Observation> {
  const key = `${stage}-${id}`;
  const tab = await call(c, "camofox_create_tab", { url: `http://127.0.0.1:${fixturePort}/?capture=${key}` });
  await call(c, "camofox_snapshot", { tabId: tab.tabId });
  if (initialize) {
    await call(c, "camofox_type", { tabId: tab.tabId, selector: "#marker", text: id });
    await call(c, "camofox_snapshot", { tabId: tab.tabId });
    await call(c, "camofox_click", { tabId: tab.tabId, selector: "#save" });
  }
  let stored = false;
  for (let n = 0; n < 30; n++) {
    const snapshot = await call(c, "camofox_snapshot", { tabId: tab.tabId });
    if (String(snapshot.snapshot).includes(`Storage marker: ${id}`)) { stored = true; break; }
    await Bun.sleep(100);
  }
  assert(stored, "The profile's cookie/localStorage/IndexedDB marker is missing or belongs to another profile.");
  for (let n = 0; n < 200; n++) {
    const sample = site!.observations.get(key); if (sample) return sample;
    await Bun.sleep(100);
  }
  throw Error("A complete browser fingerprint and network observation is missing.");
}
async function verified(c: Client, index: number, expected: Pair<string>, direct: readonly string[]) {
  await call(c, "profile_recheck");
  const status = await call(c, "profile_status");
  assert(status.phase === "ready" && status.fixedIpVerified === true && status.expectedIp === expected[index], "Fresh recheck did not verify the profile's own expected IP pin.");
  assert(status.verificationStatus === "verified" && status.verificationRequired === true && status.verificationFresh === true,
    "Fresh recheck did not expose a current verified health result.");
  assertProxyRoute(index, status.exitIp, expected, direct, shared);
  assert(status.verificationIntervalMs === CACHE_MS, "The service did not apply the two-minute verification cache interval.");
  assert(typeof status.checkedAt === "string" && Number.isFinite(Date.parse(status.checkedAt)), "Fresh verification has no timestamp.");
  return status;
}
function successful(result: ProbeResult, index: number, expected: Pair<string>, direct: readonly string[]) {
  assert(result.outcome === "success", "The independent browser fetch failed on an available proxy route.");
  assert(result.webRTCEnabled === false, "WebRTC remains enabled behind a proxy.");
  return assertProxyRoute(index, result.ip, expected, direct, shared);
}
async function openProbe(c: Client) {
  const channel = probe!.channel();
  const tab = await call(c, "camofox_create_tab", { url: channel.url });
  await call(c, "camofox_snapshot", { tabId: tab.tabId });
  return channel;
}
try {
  const secrets = dedicatedProxyInputs(process.env.PROXY_TEST_ENV, "acceptance");
  const raw = [secrets.PROXY_TEST_URL, secrets.PROXY_TEST_SECOND_URL];
  redact = proxyRedactor([...raw, process.env.PROXY_TEST_URL, process.env.PROXY_TEST_SECOND_URL]);
  const supplied = suppliedProxyEndpoints(secrets); shared = supplied.length === 1;
  const endpoints = shared ? [supplied[0]!, supplied[0]!] : supplied;
  const hostnameFixtures = ids.map(() => ({ nonce: crypto.randomUUID() }));
  const hostnameRequests: { profile: string; hostname: string }[] = [];
  for (const [index, endpoint] of endpoints.entries()) {
    const relay = proxyRelay(endpoint.url, hostname => {
      if (hostnameFixtures.some(fixture => hostname === `${fixture.nonce}.invalid`))
        hostnameRequests.push({ profile: ids[index]!, hostname });
    }, hostnameFixtures[index]!);
    relays.push(relay); await relay.start();
  }
  const relayURLs = relays.map(relay => relay.url()) as unknown as Pair<string>;
  redact = proxyRedactor([...raw, ...relayURLs, process.env.PROXY_TEST_URL, process.env.PROXY_TEST_SECOND_URL]);
  assert(new URL(relayURLs[0]).port !== new URL(relayURLs[1]).port, "Profiles share a test relay.");
  const expected: [string, string] = ["", ""];
  for (const index of [0, 1]) {
    for (let sample = 0; sample < 2; sample++) {
      const traffic = relays[index]!.traffic();
      const result = await probeExit((url, init) => fetch(url, { ...init, proxy: relayURLs[index] }), crypto.randomUUID());
      assert(result.outcome === "success", "A supplied proxy failed preflight at both IP providers.");
      const ip = exitIP(result.ip);
      assert(!endpoints[index]!.expectedIP || endpoints[index]!.expectedIP === ip, "A proxy preflight exit differs from its supplied expected IP.");
      if (!sample) expected[index] = endpoints[index]!.expectedIP || ip;
      assert(ip === expected[index], "A supplied proxy changed its exit IP during preflight.");
      assertRelayTraffic(traffic, relays[index]!.traffic());
      report.push({ check: "Proxy preflight sample", profile: ids[index], result });
    }
  }
  if (shared) report.push({ check: "Two distinct exit IPs", result: "unexecuted", reason: "One proxy route was supplied." });
  else assertDistinctExits(expected);
  report.push({ check: shared ? "Two relays to one HTTP proxy route" : "Two distinct HTTP proxy routes", endpointsSupplied: supplied.length, independentRelays: 2,
    profiles: ids.map((profile, index) => ({ profile, exitIp: expected[index], pinSource: endpoints[index]!.expectedIP ? "supplied" : "preflight" })) });

  home = createTestHome("proxy-acceptance", join(root, ".state")); env.STELZ_HOME = home;
  console.log(redact(`Two-proxy acceptance. Evidence: ${home}`));
  const [firstPort, secondPort, fixturePort] = await unusedPorts(3);
  const configure = (mode: "direct" | "proxy", pins: Pair<string>) => {
    assert(owned.size === 0, "Stop owned profiles before changing test configuration.");
    const config = proxyTestConfiguration(mode, relayURLs, pins, [firstPort!, secondPort!]);
    writeFileSync(join(home!, "profiles.json"), JSON.stringify(config.settings), { mode: 0o600 });
    writeFileSync(join(home!, "secrets.env"), config.secrets, { mode: 0o600 });
  };
  configure("direct", ["", ""]); await command("setup", "--yes");
  site = await fixture(fixturePort!); probe = networkProbe();
  await startProfiles();
  const pins: Record<string, string> = {}, before: Record<string, Observation> = {}, proxied: Record<string, Observation> = {};
  for (const id of ids) {
    const c = await client(id), sample = await capture(c, id, "direct", fixturePort!, true);
    const channel = await openProbe(c), result = await channel.sample();
    assert(result.outcome === "success", "Both independent IP providers failed for the direct baseline.");
    before[id] = { ...sample, exitIp: exitIP(result.ip), webRTCEnabled: result.webRTCEnabled };
    pins[id] = readFileSync(profileFile(id, "fingerprint.json"), "utf8");
    report.push({ check: "Direct baseline", profile: id, sample: before[id] });
  }
  const direct = ids.map(id => exitIP(before[id]!.exitIp));
  for (const index of [0, 1]) assertProxyRoute(index, expected[index], expected, direct, shared);
  await closeClients(); await stopProfiles(); configure("proxy", expected);
  const lifetimes: ProxyLifetime[] = [];
  for (let lifetime = 1; lifetime <= 3; lifetime++) {
    await startProfiles();
    const instances = running();
    const instanceIDs = instances.map(value => JSON.parse(value).instanceId as string) as unknown as Pair<string>;
    const active: Client[] = [], channels: ReturnType<typeof probe.channel>[] = [];
    const samples: [string[], string[]] = [[], []];
    for (const index of [0, 1]) {
      const id = ids[index]!, c = await client(id); active.push(c);
      await verified(c, index, expected, direct);
      await assertSingleStartupWindow(home!, id, await call(c, "camofox_list_tabs"));
      if (lifetime === 1) {
        const nonce = hostnameFixtures[index]!.nonce, hostname = `${nonce}.invalid`;
        const tab = await call(c, "camofox_create_tab", { url: `http://${hostname}/` });
        const snapshot = await call(c, "camofox_snapshot", { tabId: tab.tabId });
        assert(String(snapshot.snapshot).includes(`Proxy hostname nonce: ${nonce}`), "The browser did not display its relay's hostname nonce.");
        const requests = hostnameRequests.filter(request => request.hostname === hostname);
        assert(requests.length > 0 && requests.every(request => request.profile === id), "The unresolved hostname did not reach only the correct profile's relay.");
        report.push({ check: "HTTP absolute-URI hostname delegation", profile: id, hostname, result: "passed",
          scope: "This request succeeded without requiring local DNS resolution. This does not prove absence of OS or browser DNS leaks." });
        await call(c, "camofox_close_tab", { tabId: tab.tabId });
      }
      const channel = await openProbe(c); channels.push(channel);
      const observed = await capture(c, id, `proxy-${lifetime}`, fixturePort!), result = await channel.sample();
      const sample = { ...observed, exitIp: successful(result, index, expected, direct), webRTCEnabled: result.webRTCEnabled };
      assert(readFileSync(profileFile(id, "fingerprint.json"), "utf8") === pins[id], "The saved device pin changed during a proxy transition or restart.");
      const comparison = compareObservations(lifetime === 1 ? before[id]! : proxied[id]!, sample);
      const differences = comparison.stableDifferences.filter(key => lifetime !== 1 || !["languages", "timezone"].includes(key));
      report.push({ check: "Native storage and device continuity", lifetime, profile: id, sample, ...comparison,
        result: differences.length ? "failed" : "passed" });
      assert(differences.length === 0, `Observable device drift: ${differences.join(", ")}`);
      if (lifetime === 1) proxied[id] = sample;
    }
    for (let round = 1; round <= 3; round++) {
      for (const index of [0, 1]) {
        const traffic = relays[index]!.traffic();
        await verified(active[index]!, index, expected, direct);
        const result = await channels[index]!.sample();
        samples[index]!.push(successful(result, index, expected, direct));
        assertRelayTraffic(traffic, relays[index]!.traffic()); unchanged(instances);
        report.push({ check: "Independent browser exit sample", lifetime, round, profile: ids[index], sampledAt: new Date().toISOString(), result });
      }
      if (round < 3) await Bun.sleep(1000);
    }
    if (lifetime === 3) {
      // Cut each relay separately. The first probes deliberately run BEFORE a
      // recheck, while both profiles still hold fresh successful cached checks.
      for (const failedIndex of [0, 1]) {
        const healthyIndex = 1 - failedIndex;
        const cached = await Promise.all(active.map((c, index) => verified(c, index, expected, direct)));
        await relays[failedIndex]!.stop();
        const healthyTraffic = relays[healthyIndex]!.traffic();
        const results = await Promise.all(channels.map(channel => channel.sample()));
        assertNoFallback(results[failedIndex]!); successful(results[healthyIndex]!, healthyIndex, expected, direct);
        assertRelayTraffic(healthyTraffic, relays[healthyIndex]!.traffic());
        const cacheEvidence = [];
        for (const index of [0, 1]) {
          const status = await call(active[index]!, "profile_status");
          const ageMs = assertFreshVerificationCache(cached[index]!, status, Date.now(), CACHE_MS);
          cacheEvidence.push({ profile: ids[index], phase: status.phase, checkedAt: status.checkedAt, ageMs });
        }
        unchanged(instances);
        report.push({ check: "Single relay failure inside a fresh verification cache", lifetime,
          failedProfile: ids[failedIndex], healthyProfile: ids[healthyIndex], cacheMs: CACHE_MS, cacheEvidence,
          failedProbe: results[failedIndex], healthyProbe: results[healthyIndex], noDirectFallback: true });

        await rejected(active[failedIndex]!, "profile_recheck");
        const status = await call(active[failedIndex]!, "profile_status");
        assert(status.phase === "verification_failed" && status.exitIp === null && status.fixedIpVerified === false,
          "Explicit recheck did not invalidate the failed proxy's cached verification.");
        await rejected(active[failedIndex]!, "camofox_list_tabs");
        await verified(active[healthyIndex]!, healthyIndex, expected, direct);
        successful(await channels[healthyIndex]!.sample(), healthyIndex, expected, direct);
        await call(active[healthyIndex]!, "camofox_list_tabs"); unchanged(instances);
        report.push({ check: "Explicit recheck blocks only the failed profile", failedProfile: ids[failedIndex], result: "passed" });

        await relays[failedIndex]!.start();
        await verified(active[failedIndex]!, failedIndex, expected, direct);
        successful(await channels[failedIndex]!.sample(), failedIndex, expected, direct);
        await call(active[failedIndex]!, "camofox_list_tabs"); unchanged(instances);
        report.push({ check: "Explicit recheck restores the original browser after relay recovery", profile: ids[failedIndex], result: "passed" });
      }
    }
    await closeClients(); await stopProfiles();
    // Add evidence only after both explicit stop commands complete successfully.
    lifetimes.push({ instances: instanceIDs, samples });
  }
  assertRoutingCoverage(lifetimes, expected, shared);
  report.push({ check: shared ? "Stable expected exit across three explicit proxy start/stop lifetimes"
    : "Distinct stable exits across three explicit proxy start/stop lifetimes", lifetimes, result: "passed" });

  // A mismatched expected IP pin must block BOTH otherwise functional routes. Preflight rejects it before launch.
  // Two routes swap their known-good pins. A shared route uses a documentation address, which is never an exit.
  configure("proxy", shared ? ["203.0.113.1", "203.0.113.1"] : [expected[1], expected[0]]);
  for (const id of ids) {
    const failure = await command("start", id).then(() => { owned.add(id); return ""; }, (error: unknown) => String(error));
    assert(failure.includes("does not match the configured expected IP"), "A mismatched expected IP did not block Start.");
    report.push({ check: shared ? "A wrong expected IP pin blocks Start" : "The other proxy's expected IP pin blocks Start", profile: id, result: "passed" });
  }
} catch (error) {
  report.push({ check: "Two-proxy acceptance", result: "failed", error: redact(String(error)) }); process.exitCode = 1;
} finally {
  await closeClients();
  try { await stopProfiles(); } catch (error) {
    report.push({ check: "Owned profile cleanup", result: "failed", error: redact(String(error)) }); process.exitCode = 1;
  }
  try { probe?.stop(); site?.stop(); }
  finally {
    for (const relay of relays) await relay.stop().catch(() => {});
    if (home) rmSync(join(home, "secrets.env"), { force: true });
  }
  const output = JSON.stringify(report, (_key, value: unknown) => typeof value === "string" ? redact(value) : value, 2);
  if (home) writeFileSync(join(home, "report.json"), output, { mode: 0o600 });
  console.log(output);
}
