import { expect, test } from "bun:test";
import { parseEnv } from "node:util";
import {
  assertDistinctExits, assertFreshVerificationCache, assertNoFallback, assertProxyRoute, assertRoutingCoverage,
  proxyEndpoints, proxyRedactor, proxyTestConfiguration, PROXY_PROFILE_IDS,
  type ProxyLifetime,
} from "../helpers/proxy-acceptance-helpers.ts";
import { assertRelayTraffic, networkProbe, probeExit, proxyRelay } from "../helpers/proxy-network-fixture.ts";

const inputs = {
  PROXY_TEST_URL: "http://first-user:p%40ss%253Aword@first.invalid:8111",
  PROXY_TEST_SECOND_URL: "http://second-user:second%2Fsecret@second.invalid:8222",
};
const exits = ["198.51.100.10", "203.0.113.20"] as const;

test("both URL variables are required; expected IP pins are optional and independent", () => {
  expect(() => proxyEndpoints({ PROXY_TEST_URL: inputs.PROXY_TEST_URL })).toThrow("PROXY_TEST_SECOND_URL");
  expect(() => proxyEndpoints({ PROXY_TEST_SECOND_URL: inputs.PROXY_TEST_SECOND_URL })).toThrow("PROXY_TEST_URL");
  const endpoints = proxyEndpoints({ ...inputs, PROXY_TEST_SECOND_EXPECTED_IP: exits[1] });
  expect(endpoints[0].expectedIP).toBeUndefined(); expect(endpoints[1].expectedIP).toBe(exits[1]);
  expect(proxyEndpoints({ ...inputs, PROXY_TEST_EXPECTED_IP: exits[0] })[0].expectedIP).toBe(exits[0]);
});

test("reject unsafe URLs and invalid credentials without including either secret", () => {
  for (const value of ["garbage-private-input", "https://host.invalid", "socks5://host.invalid", "http://host.invalid/path",
    "http://host.invalid?secret=hidden", "http://host.invalid#hidden", "http://user:bad%xx@host.invalid",
    "http://user:bad%0aheader@host.invalid", "http://host.invalid\n", "http://host.invalid\\path"]) {
    expect(() => proxyEndpoints({ ...inputs, PROXY_TEST_SECOND_URL: value })).toThrow("PROXY_TEST_SECOND_URL");
    try { proxyEndpoints({ ...inputs, PROXY_TEST_SECOND_URL: value }); }
    catch (error) { expect(String(error)).not.toContain(value); expect(String(error)).not.toContain("first-user"); }
  }
  expect(() => proxyEndpoints({ ...inputs, PROXY_TEST_EXPECTED_IP: "not-an-ip" })).toThrow("PROXY_TEST_EXPECTED_IP");
  expect(() => proxyEndpoints({ ...inputs, PROXY_TEST_SECOND_EXPECTED_IP: "2001:db8::1%scope" })).toThrow("PROXY_TEST_SECOND_EXPECTED_IP");
});

test("canonical duplicate routes and equal expected exits cannot pass as distinct proxies", () => {
  expect(() => proxyEndpoints({ PROXY_TEST_URL: "http://route:pass@HOST.invalid:80", PROXY_TEST_SECOND_URL: "http://%72oute:pass@host.invalid/" })).toThrow("distinct");
  expect(() => proxyEndpoints({ ...inputs, PROXY_TEST_EXPECTED_IP: exits[0], PROXY_TEST_SECOND_EXPECTED_IP: exits[0] })).toThrow("must differ");
  // Providers can select separate exits with credentials on one gateway.
  expect(proxyEndpoints({ PROXY_TEST_URL: "http://route-one:pass@host.invalid", PROXY_TEST_SECOND_URL: "http://route-two:pass@host.invalid" })).toHaveLength(2);
  expect(() => assertDistinctExits([exits[0], exits[0]])).toThrow("same exit IP");
});

test("configuration gives two fixed profiles separate relay and expected-IP references", () => {
  const urls = ["http://first-user:password@127.0.0.1:10111/", "http://second-user:password@127.0.0.1:10112/"] as const;
  const { settings, secrets } = proxyTestConfiguration("proxy", urls, exits, [10211, 10212]);
  expect(settings.maxActive).toBe(2); expect(settings.profiles.map(p => p.id)).toEqual([...PROXY_PROFILE_IDS]);
  const values = parseEnv(secrets);
  settings.profiles.forEach((profile, index) => {
    expect(profile.storage).toBe("native"); expect(values[profile.proxyEnv]).toBe(urls[index]);
    expect(values[profile.expectedIPEnv]).toBe(exits[index]);
  });
  expect(settings.profiles[0]!.proxyEnv).not.toBe(settings.profiles[1]!.proxyEnv);
  expect(settings.profiles[0]!.expectedIPEnv).not.toBe(settings.profiles[1]!.expectedIPEnv);
  expect(JSON.stringify(settings)).not.toContain("password");
  const direct = proxyTestConfiguration("direct", urls, exits, [10211, 10212]);
  expect(parseEnv(direct.secrets).TEST_PROXY_1_EXPECTED_IP).toBe(""); expect(parseEnv(direct.secrets).TEST_PROXY_2_EXPECTED_IP).toBe("");
  expect(() => proxyTestConfiguration("proxy", [urls[0], urls[0]], exits, [10211, 10212])).toThrow("own relay");
});

test("redact both upstream URLs, relay URLs, encoded/decoded credentials and Basic auth", () => {
  const redact = proxyRedactor(Object.values(inputs));
  const sensitive = [
    ...Object.values(inputs), ...Object.values(inputs).map(value => new URL(value).href),
    "first-user", "second-user", "p%40ss%253Aword", "p@ss%3Aword", "second%2Fsecret", "second/secret",
    Buffer.from("first-user:p@ss%3Aword").toString("base64"),
    "http://first-user:p%40ss%253Aword@127.0.0.1:12345/",
  ];
  for (const value of sensitive) expect(redact(`Failure: ${value}`)).not.toContain(value);
  const output = JSON.stringify({ error: sensitive.join(" | "), nested: [{ username: "second-user", password: "second/secret" }] },
    (_key, value: unknown) => typeof value === "string" ? redact(value) : value);
  expect(() => JSON.parse(output)).not.toThrow();
  for (const value of sensitive) expect(output).not.toContain(value);
  const special = proxyRedactor(["http://quoted-user:p%22%5Cword@host.invalid/"]);
  expect(special('Error: p"\\word')).toBe("Error: [redacted]");
  expect(redact("HTTP status 502; exit 198.51.100.10")).toBe("HTTP status 502; exit 198.51.100.10");
});

test("routing assertions reject crossed routes, direct fallback, drift and incomplete evidence", () => {
  expect(assertProxyRoute(0, exits[0], exits, ["192.0.2.44"])).toBe(exits[0]);
  expect(() => assertProxyRoute(0, exits[1], exits)).toThrow("other profile");
  expect(() => assertProxyRoute(1, "192.0.2.44", exits, ["192.0.2.44"])).toThrow("direct exit");
  expect(() => assertProxyRoute(1, "192.0.2.55", exits)).toThrow("stable expected");
  expect(() => assertProxyRoute(1, undefined, exits)).toThrow("IP address");
  expect(() => assertNoFallback({ outcome: "success", ip: "192.0.2.44" })).toThrow();
  expect(() => assertNoFallback({ outcome: "success", ip: exits[0] })).toThrow();
  expect(() => assertNoFallback({ outcome: "invalid-response" })).toThrow();
  assertNoFallback({ outcome: "network-error" }); assertNoFallback({ outcome: "http-error" });
});

test("require three samples for each profile in three different completed lifetimes", () => {
  const evidence = (): ProxyLifetime[] => [1, 2, 3].map(n => ({
    instances: [`first-${n}`, `second-${n}`], samples: [[exits[0], exits[0], exits[0]], [exits[1], exits[1], exits[1]]],
  }));
  assertRoutingCoverage(evidence(), exits);
  expect(() => assertRoutingCoverage(evidence().slice(0, 2), exits)).toThrow("three explicit");
  const short = evidence(); short[1]!.samples[1].pop();
  expect(() => assertRoutingCoverage(short, exits)).toThrow("three independent");
  const crossed = evidence(); crossed[2]!.samples[0][1] = exits[1];
  expect(() => assertRoutingCoverage(crossed, exits)).toThrow("other profile");
  const reused = evidence(); reused[2]!.instances = reused[0]!.instances;
  expect(() => assertRoutingCoverage(reused, exits)).toThrow("distinct service instances");
});

test("cached-fault proof requires an unchanged successful check that is still within TTL", () => {
  const time = Date.parse("2026-01-01T00:00:00.000Z"), checkedAt = new Date(time).toISOString();
  const ready = { phase: "ready", fixedIpVerified: true, checkedAt, verificationIntervalMs: 120000,
    verificationStatus: "verified", verificationFresh: true };
  expect(assertFreshVerificationCache(ready, ready, time + 15000)).toBe(15000);
  expect(() => assertFreshVerificationCache(ready, ready, time + 120000)).toThrow("cache lifetime");
  expect(() => assertFreshVerificationCache(ready, ready, time - 1)).toThrow("cache lifetime");
  expect(() => assertFreshVerificationCache(ready, { ...ready, phase: "verification_failed" }, time + 1)).toThrow("unchanged");
  expect(() => assertFreshVerificationCache(ready, { ...ready, verificationFresh: false }, time + 1)).toThrow("unchanged");
  expect(() => assertFreshVerificationCache(ready, { ...ready, checkedAt: new Date(time + 1).toISOString() }, time + 2)).toThrow("unchanged");
});

test("two local relays route independently, survive the other's failure and recover on the same ports", async () => {
  const upstreams = exits.map(ip => Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ip }) }));
  const relays = upstreams.map(server => proxyRelay(new URL(`http://127.0.0.1:${server.port}`)));
  const request = async (index: number) => {
    // Open a fresh connection for each relay fault probe.
    const response = await fetch(`http://network-probe.invalid/?nonce=${crypto.randomUUID()}`, {
      proxy: relays[index]!.url(), signal: AbortSignal.timeout(1000), keepalive: false,
    });
    return (await response.json() as { ip: string }).ip;
  };
  try {
    for (const relay of relays) await relay.start();
    const urls = relays.map(relay => relay.url()); expect(urls[0]).not.toBe(urls[1]);
    expect(await request(0)).toBe(exits[0]); expect(await request(1)).toBe(exits[1]);
    for (const failedIndex of [0, 1]) {
      const healthyIndex = 1 - failedIndex, traffic = relays[healthyIndex]!.traffic();
      await relays[failedIndex]!.stop();
      await expect(request(failedIndex)).rejects.toThrow();
      expect(await request(healthyIndex)).toBe(exits[healthyIndex]);
      assertRelayTraffic(traffic, relays[healthyIndex]!.traffic());
      await relays[failedIndex]!.start(); expect(relays[failedIndex]!.url()).toBe(urls[failedIndex]);
      expect(await request(failedIndex)).toBe(exits[failedIndex]);
    }
  } finally {
    for (const relay of relays) await relay.stop();
    for (const server of upstreams) server.stop(true);
  }
}, 10000);

test("relay evidence requires traffic in both directions", () => {
  expect(() => assertRelayTraffic({ sent: 10, received: 20 }, { sent: 11, received: 20 })).toThrow();
  expect(() => assertRelayTraffic({ sent: 10, received: 20 }, { sent: 10, received: 21 })).toThrow();
  assertRelayTraffic({ sent: 10, received: 20 }, { sent: 11, received: 21 });
});

test("localhost probe assigns fresh one-use jobs and accepts only the matching channel and nonce", async () => {
  const probe = networkProbe(), channel = probe.channel(), other = probe.channel();
  const route = (path: string, url = channel.url) => { const target = new URL(url); target.pathname = path; return target; };
  const next = async () => (await fetch(route("/next"))).json() as Promise<{ id: string } | null>;
  const post = (body: unknown, url = channel.url) => fetch(route("/result", url), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    expect(await next()).toBeNull();
    const page = await (await fetch(channel.url)).text();
    const script = /<script type="module">([\s\S]*)<\/script>/.exec(page)![1]!;
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    expect(() => new AsyncFunction(script)).not.toThrow();
    const pending = channel.sample(), job = (await next())!;
    expect(job.id).toMatch(/^[\da-f-]{36}$/);
    expect(await next()).toBeNull();
    expect((await post({ id: "stale", result: { outcome: "success", ip: exits[0] } })).status).toBe(400);
    expect((await post({ id: job.id, result: { outcome: "success", ip: exits[0] } }, other.url)).status).toBe(400);
    expect((await post({ id: job.id, result: { outcome: "success", ip: exits[0], error: "discard-this-field" } })).status).toBe(204);
    expect(await pending).toEqual({ outcome: "success", ip: exits[0] });
    expect((await post({ id: job.id, result: { outcome: "network-error" } })).status).toBe(400);
    const second = channel.sample(), secondJob = (await next())!; expect(secondJob.id).not.toBe(job.id);
    await post({ id: secondJob.id, result: { outcome: "network-error" } });
    expect(await second).toEqual({ outcome: "network-error" });
  } finally { probe.stop(); }
});

test("a missing browser report is an acceptance failure, never proof of no fallback", async () => {
  const probe = networkProbe(20);
  try { await expect(probe.channel().sample()).rejects.toThrow("did not report"); }
  finally { probe.stop(); }
});

test("independent IP observation falls back on provider failure but never hides a valid mismatched exit", async () => {
  const urls: string[] = [];
  const fallback = await probeExit(async (url, init) => {
    urls.push(url); expect(init.cache).toBe("no-store");
    if (new URL(url).hostname === "api.ipify.org") throw Error("Primary unavailable");
    return { ok: true, text: async () => `fl=abc\nip=${exits[1]}\nloc=ZZ\n` };
  }, "fallback-nonce");
  expect(fallback).toEqual({ outcome: "success", ip: exits[1], provider: "cloudflare" });
  expect(urls).toHaveLength(2); expect(urls.every(url => url.includes("fallback-nonce"))).toBe(true);
  let attempts = 0;
  const mismatch = await probeExit(async () => { attempts++; return { ok: true, text: async () => JSON.stringify({ ip: exits[1] }) }; }, "mismatch");
  expect(attempts).toBe(1); expect(mismatch.outcome).toBe("success");
  expect(() => assertProxyRoute(0, mismatch.outcome === "success" ? mismatch.ip : undefined, exits)).toThrow("other profile");
  attempts = 0;
  const failed = await probeExit(async () => { attempts++; throw Error("Network unavailable"); }, "both-down");
  expect(attempts).toBe(2); assertNoFallback(failed);
  const invalid = await probeExit(async () => ({ ok: true, text: async () => "not an IP response" }), "invalid");
  expect(invalid.outcome).toBe("invalid-response"); expect(() => assertNoFallback(invalid)).toThrow();
});
