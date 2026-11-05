import { isIP } from "node:net";

export type Pair<T> = readonly [T, T];
export const PROXY_PROFILE_IDS = ["profile-01", "profile-02"] as const;
export type ProxyEndpoint = { url: URL; expectedIP?: string };

export function assert(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}

export function proxyEndpoints(env: Record<string, string | undefined>): Pair<ProxyEndpoint> {
  const endpoints = [
    ["PROXY_TEST_URL", "PROXY_TEST_EXPECTED_IP"],
    ["PROXY_TEST_SECOND_URL", "PROXY_TEST_SECOND_EXPECTED_IP"],
  ].map(([urlName, ipName]) => {
    let url: URL;
    try {
      const raw = env[urlName!];
      if (!raw || /[\s\\]/.test(raw)) throw Error();
      url = new URL(raw);
      if (url.protocol !== "http:" || !url.hostname || url.pathname !== "/" || url.search || url.hash) throw Error();
      for (const field of [url.username, url.password]) {
        if (/[\x00-\x1f\x7f]/.test(decodeURIComponent(field))) throw Error();
      }
    } catch { throw Error(`Set a valid HTTP proxy in ${urlName}. Private inputs are hidden.`); }
    const expectedIP = env[ipName!] || undefined;
    assert(!expectedIP || !!isIP(expectedIP) && !expectedIP.includes("%"), `${ipName} must be an IPv4 or IPv6 address. Private inputs are hidden.`);
    return { url, expectedIP };
  }) as unknown as Pair<ProxyEndpoint>;
  const identity = ({ url }: ProxyEndpoint) => JSON.stringify([
    url.hostname, url.port || "80", decodeURIComponent(url.username), decodeURIComponent(url.password),
  ]);
  assert(identity(endpoints[0]) !== identity(endpoints[1]), "Supply two distinct proxy endpoints or credential routes.");
  assert(!endpoints[0].expectedIP || endpoints[0].expectedIP !== endpoints[1].expectedIP,
    "The two expected proxy exit IPs must differ.");
  return endpoints;
}

// Apply this to every output string, including strings inside report objects.
export function proxyRedactor(values: readonly (string | undefined)[]) {
  const secrets = new Set<string>();
  const add = (value: string) => {
    if (!value) return;
    secrets.add(value);
    secrets.add(JSON.stringify(value).slice(1, -1));
    secrets.add(value.replace(/%[\da-f]{2}/gi, match => match.toLowerCase()));
    secrets.add(value.replace(/%[\da-f]{2}/gi, match => match.toUpperCase()));
  };
  for (const raw of values) {
    if (!raw) continue;
    add(raw);
    try {
      const url = new URL(raw);
      add(url.href); add(url.href.replace(/\/$/, ""));
      for (const field of [url.username, url.password]) {
        add(field);
        try { const decoded = decodeURIComponent(field); add(decoded); add(encodeURIComponent(decoded)); } catch {}
      }
      try { add(Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64")); } catch {}
    } catch {}
  }
  const alternatives = [...secrets].sort((a, b) => b.length - a.length).map(value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(["https?://[^\\s\"'<>]+", ...alternatives].join("|"), "g");
  return (value: string) => value.replace(pattern, "[redacted]");
}

export function proxyTestConfiguration(mode: "direct" | "proxy", urls: Pair<string>, expected: Pair<string>, ports: Pair<number>) {
  assert(urls[0] !== urls[1], "Each profile requires its own relay URL.");
  assert(ports[0] !== ports[1], "Each profile requires its own service port.");
  const profiles = PROXY_PROFILE_IDS.map((id, i) => ({
    id, port: ports[i]!, mode, storage: "native",
    proxyEnv: `TEST_PROXY_${i + 1}_URL`, expectedIPEnv: `TEST_PROXY_${i + 1}_EXPECTED_IP`,
  }));
  const secrets = profiles.map((p, i) => `${p.proxyEnv}=${JSON.stringify(urls[i])}\n${p.expectedIPEnv}=${mode === "proxy" ? expected[i] : ""}\n`).join("");
  return { settings: { profiles }, secrets };
}

export function exitIP(value: unknown): string {
  assert(typeof value === "string" && !!isIP(value) && !value.includes("%"), "The independent network probe did not return an IP address.");
  return value;
}

export function assertDistinctExits(expected: Pair<string>) {
  expected.forEach(exitIP);
  assert(expected[0] !== expected[1], "Both proxies returned the same exit IP; distinct routing is unproven.");
}

export function assertProxyRoute(index: number, observed: unknown, expected: Pair<string>, direct: readonly string[] = []) {
  assert(index === 0 || index === 1, "Unknown test profile.");
  assertDistinctExits(expected);
  const ip = exitIP(observed);
  assert(!direct.includes(ip), "A proxied browser used a direct exit IP.");
  assert(ip !== expected[1 - index], "A browser used the other profile's proxy exit IP.");
  assert(ip === expected[index], "A browser exit IP differs from its stable expected IP pin.");
  return ip;
}

export type ProbeResult = ({ outcome: "success"; ip: string } | { outcome: "network-error" | "http-error" | "invalid-response" }) & {
  provider?: string; webRTCEnabled?: boolean;
};
export function assertNoFallback(result: ProbeResult) {
  assert(result.outcome === "network-error" || result.outcome === "http-error",
    "The browser network probe did not prove failure of the disconnected proxy route.");
}

export function assertFreshVerificationCache(before: Record<string, unknown>, after: Record<string, unknown>, now = Date.now(), cacheMs = 120_000) {
  assert(before.verificationIntervalMs === cacheMs && after.verificationIntervalMs === cacheMs, "The service did not apply the test verification cache interval.");
  assert(before.verificationStatus === "verified" && after.verificationStatus === "verified" && before.verificationFresh === true
    && after.verificationFresh === true && after.phase === "ready" && after.checkedAt === before.checkedAt && after.fixedIpVerified === true,
    "The relay fault was not observed inside an unchanged successful verification cache.");
  const age = now - Date.parse(String(before.checkedAt));
  assert(age >= 0 && age < cacheMs, "The browser fault probe exceeded the verification cache lifetime.");
  return age;
}

export type ProxyLifetime = { instances: Pair<string>; samples: Pair<string[]> };
export function assertRoutingCoverage(lifetimes: readonly ProxyLifetime[], expected: Pair<string>) {
  assertDistinctExits(expected);
  assert(lifetimes.length >= 3, "At least three explicit proxy start/stop lifetimes are required.");
  const instances = new Set<string>();
  for (const lifetime of lifetimes) {
    for (const index of [0, 1]) {
      const instance = lifetime.instances[index];
      assert(typeof instance === "string" && !!instance && !instances.has(instance), "Proxy lifetimes must use distinct service instances.");
      instances.add(instance);
      const samples = lifetime.samples[index]!;
      assert(samples.length >= 3, "Each profile requires three independent network samples within each proxy lifetime.");
      for (const sample of samples) assertProxyRoute(index, sample, expected);
    }
  }
}
