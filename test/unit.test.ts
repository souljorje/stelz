import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proxyEnvironment, type Profile } from "../src/config.ts";
import { lock } from "../src/runtime.ts";
import { ControllerLease } from "../src/controller.ts";
const p: Profile = { id: "unit", port: 9471, mode: "proxy", proxyEnv: "STELZ_UNIT_PROXY" };
const folder = mkdtempSync(join(tmpdir(), "stelz-unit-"));
afterAll(() => { delete process.env.STELZ_UNIT_PROXY; rmSync(folder, { recursive: true, force: true }); });
test("missing proxy rejects launch", () => { delete process.env.STELZ_UNIT_PROXY; expect(() => proxyEnvironment(p)).toThrow("Direct fallback is disabled"); });
test("direct mode ignores proxy credentials", () => { process.env.STELZ_UNIT_PROXY = "http://secret:password@host:9999"; expect(proxyEnvironment({ ...p, mode: "direct" })).toEqual({}); });
test("upstream decodes HTTP credentials once", () => { process.env.STELZ_UNIT_PROXY = "http://u%40name:p%253Ass@127.0.0.1:8888"; const v = proxyEnvironment(p); expect(decodeURIComponent(v.PROXY_USERNAME!)).toBe("u@name"); expect(decodeURIComponent(v.PROXY_PASSWORD!)).toBe("p%3Ass"); });
test("unsupported proxy forms fail without credentials in errors", () => {
  for (const url of ["socks4://host:1080", "socks5://user:secret@host:1080", "http://host:8888/path", "not-a-url"]) {
    process.env.STELZ_UNIT_PROXY = url; expect(() => proxyEnvironment(p)).toThrow();
    try { proxyEnvironment(p); } catch (e) { expect(String(e)).not.toContain("user:secret"); }
  }
});
test("HTTP default port is supported", () => { process.env.STELZ_UNIT_PROXY = "http://host:80"; expect(proxyEnvironment(p).PROXY_PORT).toBe("80"); });
test("lifecycle operations serialize", async () => {
  let active = 0, max = 0;
  await Promise.all(Array.from({ length: 8 }, () => lock(join(folder, "action.lock"), async () => { active++; max = Math.max(max, active); await Bun.sleep(5); active--; })));
  expect(max).toBe(1);
});
const a = { id: "connection-a", pid: 10, label: "Client A" }, b = { id: "connection-b", pid: 20, label: "Client B" };
test("one identity rejects a second controller until release", async () => {
  const lease = new ControllerLease(() => true); lease.acquire(a);
  expect(() => lease.acquire(b)).toThrow("active controller");
  await lease.release(a.id); expect(lease.acquire(b).acquired).toBe(true);
  await expect(lease.run(a.id, async () => 1)).rejects.toThrow("Acquire");
});
test("handoff waits for active and queued actions", async () => {
  const lease = new ControllerLease(() => true); lease.acquire(a);
  let finish!: () => void;
  const action = lease.run(a.id, () => new Promise<void>(resolve => { finish = resolve; }));
  await Bun.sleep(0);
  let queuedFinished = false;
  const queued = lease.run(a.id, async () => { queuedFinished = true; });
  const release = lease.release(a.id);
  expect(() => lease.acquire(b)).toThrow("active controller");
  await expect(lease.run(a.id, async () => 1)).rejects.toThrow("Acquire");
  finish(); await action; await queued; await release;
  expect(queuedFinished).toBe(true);
  expect(lease.acquire(b).acquired).toBe(true);
});
test("a dead controller cannot hand off an action still running in the service", async () => {
  let alive = true; const lease = new ControllerLease(() => alive); lease.acquire(a);
  let finish!: () => void;
  const action = lease.run(a.id, () => new Promise<void>(resolve => { finish = resolve; }));
  await Bun.sleep(0); alive = false;
  expect(() => lease.acquire(b)).toThrow("active controller");
  finish(); await action;
  expect(lease.acquire(b).acquired).toBe(true);
});
test("an action failure releases the service queue", async () => {
  const lease = new ControllerLease(() => true); lease.acquire(a);
  await expect(lease.run(a.id, async () => { throw Error("action failed"); })).rejects.toThrow("action failed");
  await lease.release(a.id); expect(lease.acquire(b).acquired).toBe(true);
});
