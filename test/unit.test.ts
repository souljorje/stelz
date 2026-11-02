import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proxyEnvironment, type Profile } from "../src/config.ts";
import { lock } from "../src/runtime.ts";
const p: Profile = { id: "unit", port: 9471, mode: "proxy", proxyEnv: "STELZ_UNIT_PROXY" };
const folder = mkdtempSync(join(tmpdir(), "stelz-unit-"));
afterAll(() => { delete process.env.STELZ_UNIT_PROXY; rmSync(folder, { recursive: true, force: true }); });
test("missing proxy fails closed and does not expose secrets", () => { delete process.env.STELZ_UNIT_PROXY; expect(() => proxyEnvironment(p)).toThrow("never falls back to direct"); });
test("explicit direct ignores inherited proxy settings", () => { process.env.STELZ_UNIT_PROXY = "http://secret:password@host:9999"; expect(proxyEnvironment({ ...p, mode: "direct" })).toEqual({}); });
test("HTTP authentication is decoded exactly once by upstream", () => { process.env.STELZ_UNIT_PROXY = "http://u%40name:p%253Ass@127.0.0.1:8888"; const v = proxyEnvironment(p); expect(decodeURIComponent(v.PROXY_USERNAME!)).toBe("u@name"); expect(decodeURIComponent(v.PROXY_PASSWORD!)).toBe("p%3Ass"); expect(v.PROXY_STRATEGY).toBe("round_robin"); });
test("unsupported protocols and SOCKS authentication are rejected", () => {
  for (const url of ["socks4://host:1080", "socks5://user:secret@host:1080", "http://host:8888/path", "not-a-url"]) {
    process.env.STELZ_UNIT_PROXY = url; expect(() => proxyEnvironment(p)).toThrow();
    try { proxyEnvironment(p); } catch (e) { expect(String(e)).not.toContain("user:secret"); }
  }
});
test("default HTTP proxy port is accepted", () => { process.env.STELZ_UNIT_PROXY = "http://host:80"; expect(proxyEnvironment(p).PROXY_PORT).toBe("80"); });
test("profile actions serialize without sharing concurrent access", async () => {
  const path = join(folder, "action.lock"); let active = 0, max = 0;
  await Promise.all(Array.from({ length: 8 }, () => lock(path, async () => { active++; max = Math.max(max, active); await Bun.sleep(5); active--; })));
  expect(max).toBe(1);
});
