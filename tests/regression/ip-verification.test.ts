import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { createIpVerification, DEFAULT_IP_CHECK_INTERVAL_MS, parseIpCheckInterval, type Probe } from "../../packages/stelz/src/browser/ip-verification.ts";

test("IP verification intervals default to two minutes and reject unbounded or invalid values", () => {
  assert.equal(parseIpCheckInterval(undefined), DEFAULT_IP_CHECK_INTERVAL_MS);
  assert.equal(parseIpCheckInterval("0"), 0);
  assert.equal(parseIpCheckInterval("60000"), 60_000);
  assert.equal(parseIpCheckInterval("120000"), 120_000);
  for (const value of ["", "-1", "120001", "Infinity", "NaN", "1.5", "1e3", " 1000", "01"]) {
    assert.throws(() => parseIpCheckInterval(value), /integer from 0 to 120000/);
  }
});

function harness(expected = "198.51.100.10") {
  const session = {};
  let href = "";
  let created = 0, closed = 0;
  const navigations: string[] = [], requests: string[] = [];
  const responses = new Map<string, { status?: number; body?: string; fail?: boolean }>();
  const probe: Probe = {
    async goto(url) { href = url; navigations.push(new URL(url).hostname); },
    async evaluate<T>(fn: (endpoint: string) => Promise<T>, endpoint: string): Promise<T> {
      assert.equal(endpoint, href);
      return runInNewContext(`(${fn.toString()})(endpoint)`, {
        URL, Date, AbortSignal, endpoint,
        fetch: async (url: URL, options: { cache: string; signal: AbortSignal }) => {
          requests.push(url.hostname);
          assert.equal(options.cache, "no-store");
          assert.ok(url.searchParams.has("_"));
          assert.ok(options.signal instanceof AbortSignal);
          const response = responses.get(url.hostname);
          if (response?.fail) throw Error("secret upstream error that must not escape");
          return { ok: (response?.status ?? 200) === 200,
            text: async () => response?.body ?? '{"ip":"198.51.100.10"}' };
        },
      }) as Promise<T>;
    },
    async close() {},
  };
  const ctx = {
    sessions: new Map<string, unknown>([["profile-01", session]]),
    async createLeasedPage(value: unknown) { assert.equal(value, session); created++; return { page: probe, lease: "lease" }; },
    async closeLeasedPage(value: unknown, page: Probe, lease: unknown) {
      assert.equal(value, session); assert.equal(page, probe); assert.equal(lease, "lease"); closed++;
    },
  };
  return { verifier: createIpVerification(ctx, "profile-01", expected), ctx, responses, requests, navigations,
    counts: () => ({ created, closed }) };
}

test("successful checks reuse a leased page in the selected browser context", async () => {
  const h = harness();
  try {
    assert.equal(await h.verifier.check(), "198.51.100.10");
    assert.equal(await h.verifier.check(), "198.51.100.10");
    assert.deepEqual(h.navigations, ["api.ipify.org"]);
    assert.deepEqual(h.requests, ["api.ipify.org", "api.ipify.org"]);
    assert.deepEqual(h.counts(), { created: 1, closed: 0 });
  } finally { await h.verifier.close(); }
  assert.deepEqual(h.counts(), { created: 1, closed: 1 });
});

for (const response of [{ fail: true }, { status: 503 }, { body: "invalid" }, { body: "null" }, { body: '{"ip":123}' }]) {
  test(`a failed primary provider falls back to independent browser-side trace: ${JSON.stringify(response)}`, async () => {
    const h = harness("2001:db8::1");
    h.responses.set("api.ipify.org", response);
    h.responses.set("www.cloudflare.com", { body: "fl=123\nip=2001:db8::1\nts=123\n" });
    try {
      assert.equal(await h.verifier.check(), "2001:db8::1");
      assert.equal(await h.verifier.check(), "2001:db8::1");
      assert.deepEqual(h.requests, ["api.ipify.org", "www.cloudflare.com", "www.cloudflare.com"]);
      assert.deepEqual(h.navigations, ["api.ipify.org", "www.cloudflare.com"]);
    } finally { await h.verifier.close(); }
  });
}

test("a valid unexpected exit fails immediately without searching for another provider", async () => {
  const h = harness();
  h.responses.set("api.ipify.org", { body: '{"ip":"203.0.113.1"}' });
  await assert.rejects(h.verifier.check(), /does not match/);
  assert.deepEqual(h.requests, ["api.ipify.org"]);
  assert.deepEqual(h.counts(), { created: 1, closed: 1 });
});

test("all provider failures close the probe, hide upstream errors and allow an explicit new check", async () => {
  const h = harness();
  for (const host of ["api.ipify.org", "www.cloudflare.com"]) h.responses.set(host, { fail: true });
  await assert.rejects(h.verifier.check(), { message: "Browser exit IP verification failed at all configured providers" });
  assert.deepEqual(h.counts(), { created: 1, closed: 1 });
  h.responses.clear();
  assert.equal(await h.verifier.check(), "198.51.100.10");
  await h.verifier.close();
  assert.deepEqual(h.counts(), { created: 2, closed: 2 });
});

test("missing browser sessions and invalid expected addresses fail before network requests", async () => {
  const h = harness();
  h.ctx.sessions.clear();
  await assert.rejects(h.verifier.check(), /session is unavailable/);
  assert.deepEqual(h.requests, []);
  assert.throws(() => harness("not-an-IP"), /IPv4 or IPv6/);
});
