import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { createIpVerification, DEFAULT_IP_CHECK_INTERVAL_MS, parseIpCheckInterval } from "../../src/browser/ip-verification.ts";

test("IP verification intervals default to two minutes and reject unbounded or invalid values", () => {
  assert.equal(parseIpCheckInterval(undefined), DEFAULT_IP_CHECK_INTERVAL_MS);
  assert.equal(parseIpCheckInterval("0"), 0);
  assert.equal(parseIpCheckInterval("60000"), 60_000);
  assert.equal(parseIpCheckInterval("120000"), 120_000);
  for (const value of ["", "-1", "120001", "Infinity", "NaN", "1.5", "1e3", " 1000", "01"]) {
    assert.throws(() => parseIpCheckInterval(value), /integer from 0 to 120000/);
  }
});

function harness(expected = "198.51.100.10", timeout = 1000) {
  const instanceId = "browser-a", verifier = createIpVerification(instanceId, expected, timeout);
  const requests: string[] = [], ids: string[] = [];
  const responses = new Map<string, { body?: string; fail?: boolean }>();
  const poll = (result?: unknown) => verifier.exchange({ instanceId, result });
  async function check() {
    let done = false;
    const work = verifier.check().finally(() => { done = true; });
    void work.catch(() => {});
    while (!done) {
      const request = poll().request;
      if (request) {
        requests.push(request.provider); ids.push(request.id);
        const response = responses.get(request.provider);
        poll(response?.fail ? { id: request.id, failed: true } : { id: request.id, body: response?.body ?? '{"ip":"198.51.100.10"}' });
      }
      await setImmediate();
    }
    return work;
  }
  return { instanceId, verifier, requests, ids, responses, check, poll };
}

test("fresh browser add-on checks need no visible page and use separate request IDs", async () => {
  const h = harness();
  assert.equal(await h.check(), "198.51.100.10");
  assert.equal(await h.check(), "198.51.100.10");
  assert.deepEqual(h.requests, ["ipify", "ipify"]);
  assert.notEqual(h.ids[0], h.ids[1]);
  assert.deepEqual(h.poll(), {});
  await h.verifier.close();
});

for (const response of [{ fail: true }, { body: "invalid" }, { body: "null" }, { body: '{"ip":123}' }]) {
  test(`a failed primary provider falls back to an independent browser request: ${JSON.stringify(response)}`, async () => {
    const h = harness("2001:db8::1");
    h.responses.set("ipify", response);
    h.responses.set("cloudflare", { body: "fl=123\nip=2001:db8::1\nts=123\n" });
    assert.equal(await h.check(), "2001:db8::1");
    assert.equal(await h.check(), "2001:db8::1");
    assert.deepEqual(h.requests, ["ipify", "cloudflare", "cloudflare"]);
    await h.verifier.close();
  });
}

test("a valid unexpected exit fails immediately without searching for another provider", async () => {
  const h = harness();
  h.responses.set("ipify", { body: '{"ip":"203.0.113.1"}' });
  await assert.rejects(h.check(), /does not match/);
  assert.deepEqual(h.requests, ["ipify"]);
  assert.deepEqual(h.poll(), {});
});

test("provider failures leave no pending request and allow an explicit new check", async () => {
  const h = harness();
  for (const provider of ["ipify", "cloudflare"]) h.responses.set(provider, { fail: true });
  await assert.rejects(h.check(), { message: "Browser exit IP verification failed at all configured providers" });
  assert.deepEqual(h.poll(), {});
  h.responses.clear();
  assert.equal(await h.check(), "198.51.100.10");
  await h.verifier.close();
});

test("the bridge rejects foreign lifetimes and malformed responses without settling its current request", async () => {
  const h = harness(), work = h.verifier.check();
  const request = h.poll().request!;
  for (const value of [null, { instanceId: "other" }, { instanceId: h.instanceId, unexpected: true },
    { instanceId: h.instanceId, result: { id: request.id, body: "x".repeat(4097) } },
    { instanceId: h.instanceId, result: { id: request.id, body: "private", failed: true } }]) {
    assert.throws(() => h.verifier.exchange(value), { message: "Invalid browser network response." });
  }
  h.poll({ id: "old-request", body: '{"ip":"203.0.113.1"}' });
  assert.equal(h.poll().request!.id, request.id);
  h.poll({ id: request.id, body: '{"ip":"198.51.100.10"}' });
  assert.equal(await work, "198.51.100.10");
});

test("missing background replies fail closed and shutdown cancels only the pending verification", async () => {
  const h = harness("198.51.100.10", 5);
  await assert.rejects(h.verifier.check(), /all configured providers/);
  assert.deepEqual(h.poll(), {});
  const pending = h.verifier.check();
  await assert.rejects(h.verifier.check(), /already pending/);
  const cancelled = assert.rejects(pending, /stopped/);
  await h.verifier.close(); await cancelled;
  assert.deepEqual(h.poll(), {});
  await assert.rejects(h.verifier.check(), /stopped/);
  assert.throws(() => harness("not-an-IP"), /IPv4 or IPv6/);
});
