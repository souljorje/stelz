import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { setImmediate } from "node:timers/promises";
import { profileIpProbeMain, type ProbeProxyAuth } from "../../src/browser/ip-probe.ts";

async function harness(probeOptions: { proxyAuth?: ProbeProxyAuth; challenge?: (listener: (details: Record<string, unknown>) => unknown, url: URL) => void } = {}) {
  const endpoint = "http://127.0.0.1:9378/local-profile/network-bridge";
  let request: unknown = { id: "request-1", provider: "ipify" }, bridgeError = false;
  let providerError = false, status = 200, body = '{"ip":"198.51.100.10"}';
  let tick: (() => Promise<void>) | undefined;
  const posts: Record<string, any>[] = [], network: { url: URL; options: RequestInit }[] = [];
  let auth: (details: Record<string, unknown>) => unknown;
  runInNewContext(`(${profileIpProbeMain.toString()})(config)`, {
    config: { instanceId: "lifetime-a", endpoint, accessKey: "private-service-key", proxyAuth: probeOptions.proxyAuth }, URL, AbortSignal,
    browser: new Proxy({ runtime: { getURL: () => "moz-extension://private-addon/" }, webRequest: { onAuthRequired: {
      addListener(fn: typeof auth, filter: unknown, extra: unknown) {
        auth = fn;
        assert.deepEqual(JSON.parse(JSON.stringify(filter)), { urls: ["https://api.ipify.org/*", "https://www.cloudflare.com/*"] });
        assert.deepEqual(Array.from(extra as string[]), ["blocking"]);
      },
    } } }, { get(target, key) {
      if (key in target) return target[key as keyof typeof target];
      throw Error("IP verification must not use visible windows or tabs.");
    } }),
    setTimeout: (fn: () => Promise<void>) => { tick = fn; },
    fetch: async (url: string | URL, options: RequestInit) => {
      if (String(url) === endpoint) {
        posts.push(JSON.parse(String(options.body)));
        assert.equal(options.redirect, "error");
        assert.equal((options.headers as Record<string, string>).Authorization, "Bearer private-service-key");
        if (bridgeError) throw Error("private bridge error");
        return { ok: true, json: async () => ({ request }) };
      }
      network.push({ url: new URL(url), options });
      // Authentication occurs while the background fetch is still active.
      probeOptions.challenge?.(auth!, new URL(url));
      if (providerError) throw Error("private network error");
      return { ok: status === 200, text: async () => body };
    },
  });
  await setImmediate();
  return { posts, network, async tick() { await tick!(); await setImmediate(); },
    command(value: unknown) { request = value; }, bridgeFailure(value: boolean) { bridgeError = value; },
    response(value: { status?: number; body?: string; failed?: boolean }) {
      status = value.status ?? 200; body = value.body ?? body; providerError = !!value.failed;
    } };
}

test("background requests use Firefox fetch without pages, redirects, cookies, or service credentials", async () => {
  const h = await harness();
  assert.equal(h.network.length, 1);
  const { url, options } = h.network[0]!;
  assert.equal(url.hostname, "api.ipify.org"); assert.equal(url.searchParams.get("_"), "request-1");
  assert.equal(options.cache, "no-store"); assert.equal(options.credentials, "omit");
  assert.equal(options.redirect, "error"); assert.equal(options.headers, undefined);
  assert.ok(options.signal instanceof AbortSignal);
  h.command(undefined); await h.tick();
  assert.deepEqual(h.posts.at(-1), { instanceId: "lifetime-a", result: { id: "request-1", body: '{"ip":"198.51.100.10"}' } });
});

test("bridge retries retain results without replaying completed provider requests", async () => {
  const h = await harness();
  h.bridgeFailure(true); await h.tick(); await h.tick();
  assert.equal(h.network.length, 1);
  assert.deepEqual(h.posts.at(-1)!.result, h.posts.at(-2)!.result);
  h.bridgeFailure(false); await h.tick(); await h.tick();
  assert.equal(h.network.length, 1);
  h.command({ id: "request-2", provider: "cloudflare" }); await h.tick();
  assert.equal(h.network.length, 2); assert.equal(h.network[1]!.url.hostname, "www.cloudflare.com");
});

for (const value of [{ failed: true }, { status: 503 }, { body: "private".repeat(1000) }]) {
  test(`background failures return a bounded failure marker: ${Object.keys(value).join()}`, async () => {
    const h = await harness(); h.response(value);
    h.command({ id: "request-2", provider: "cloudflare" }); await h.tick();
    h.command(undefined); await h.tick();
    assert.deepEqual(h.posts.at(-1)!.result, { id: "request-2", failed: true });
  });
}

test("the add-on refuses arbitrary endpoints and malformed request IDs", async () => {
  const h = await harness();
  for (const request of [{ id: "request-2", provider: "https://private.invalid" }, { id: "request-3", provider: "__proto__" },
    { id: "x".repeat(65), provider: "ipify" }, { id: 1, provider: "ipify" }]) {
    h.command(request); await h.tick();
  }
  assert.equal(h.network.length, 1);
});

test("only the current private probe can authenticate to the configured proxy, once per request", async () => {
  let probes = 0;
  const h = await harness({ proxyAuth: { host: "proxy.test", port: 3128, username: "test-user", password: "test-password" },
    challenge(listener, url) {
      probes++;
      const details = { requestId: "network-id", url: url.href, originUrl: "moz-extension://private-addon/_generated_background_page.html",
        tabId: -1, isProxy: true, challenger: { host: "proxy.test", port: 3128 } };
      const check = (change: Record<string, unknown>) => JSON.parse(JSON.stringify(listener({ ...details, ...change })));
      assert.deepEqual(check({ tabId: 1 }), {});
      assert.deepEqual(check({ originUrl: "https://api.ipify.org/" }), {});
      assert.deepEqual(check({ originUrl: "moz-extension://another-addon/" }), {});
      assert.deepEqual(check({ originUrl: undefined }), {});
      assert.deepEqual(check({ url: "https://api.ipify.org/?_another_request" }), {});
      assert.deepEqual(check({ isProxy: false }), { cancel: true });
      assert.deepEqual(check({ challenger: { host: "other.test", port: 3128 } }), { cancel: true });
      assert.deepEqual(check({ challenger: { host: "proxy.test", port: 3129 } }), { cancel: true });
      assert.deepEqual(check({}), { authCredentials: { username: "test-user", password: "test-password" } });
      assert.deepEqual(check({}), { cancel: true });
    } });
  h.command({ id: "request-2", provider: "cloudflare" }); await h.tick();
  assert.equal(probes, 2);
  assert.ok(h.network.every(request => request.options.headers === undefined));
  assert.ok(!JSON.stringify(h.posts).includes("test-password"));
});
