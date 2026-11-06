import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proxyEnvironment, validateSettings, type Profile } from "../../src/profiles/config.ts";
import { lock } from "../../src/runtime/runtime.ts";
import { createControllerLease } from "../../src/mcp/controller.ts";
const p: Profile = { id: "unit", port: 9471, proxyEnv: "STELZ_UNIT_PROXY" };
const folder = mkdtempSync(join(tmpdir(), "stelz-unit-"));
afterAll(() => { delete process.env.STELZ_UNIT_PROXY; rmSync(folder, { recursive: true, force: true }); });
test("init creates an empty catalog and preserves existing profiles", async () => {
  const home = join(folder, "defaults");
  const script = `import { initialize, settings, proxyEnvironment } from ${JSON.stringify(join(import.meta.dir, "../../src/profiles/config.ts"))}; initialize(); console.log(JSON.stringify(settings().profiles.map(p => ({storage:p.storage,proxy:proxyEnvironment(p)}))));`;
  const initialize = async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], { env: { ...process.env, STELZ_HOME: home }, stdout: "pipe", stderr: "pipe" });
    const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code) throw Error(error);
    return JSON.parse(output);
  };
  expect(await initialize()).toEqual([]);
  const config = JSON.stringify({ profiles: [{ id: "existing", port: 9474, storage: "native", proxyEnv: "INIT_TEST_PROXY" }] });
  const secrets = "# existing credentials\nINIT_TEST_PROXY=http://proxy.test:8080\n";
  writeFileSync(join(home, "profiles.json"), config);
  writeFileSync(join(home, "secrets.env"), secrets);
  await initialize();
  expect(readFileSync(join(home, "profiles.json"), "utf8")).toBe(config);
  expect(readFileSync(join(home, "secrets.env"), "utf8")).toBe(secrets);
});
test("catalogs have no profile count limit", () => {
  const profiles = Array.from({ length: 1001 }, (_, i) => ({ id: `browser-${i}`, port: 9475 + i }));
  expect(validateSettings({ profiles }).profiles).toHaveLength(1001);

  expect(() => validateSettings({ profiles: {} })).toThrow("profiles array");
  expect(() => validateSettings({ profiles: [...profiles, profiles[0]] })).toThrow("unique");
});
test("catalog validation accepts only current fields and native storage", () => {
  for (const catalog of [{ identities: [] }, { profiles: [], maxActive: 1 }])
    expect(() => validateSettings(catalog)).toThrow("only profiles");
  for (const extra of [{ mode: "direct" }, { mode: "proxy" }, { storage: "checkpoint" }, { unexpected: true }])
    expect(() => validateSettings({ profiles: [{ ...p, ...extra }] })).toThrow();
  expect(validateSettings({ profiles: [{ ...p, storage: "native" }] }).profiles).toHaveLength(1);
});
test("missing proxy rejects launch", () => { delete process.env.STELZ_UNIT_PROXY; expect(() => proxyEnvironment(p)).toThrow("Direct fallback is disabled"); });
test("mode-free profiles infer routing only from their own proxy reference", () => {
  const direct = { id: "direct", port: 9472 };
  expect(validateSettings({ profiles: [direct, p] }).profiles).toEqual([direct, p]);
  const names = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "PROXY_HOST", "STELZ_MODE"];
  const previous = names.map(name => process.env[name]);
  try {
    for (const name of names) process.env[name] = "unrelated-proxy";
    expect(proxyEnvironment(direct)).toEqual({});
    process.env.STELZ_UNIT_PROXY = "https://user:password@host:9443";
    expect(proxyEnvironment(p)).toMatchObject({ PROXY_HOST: "host", PROXY_PORT: "9443", PROXY_PROTOCOL: "https" });
  } finally {
    names.forEach((name, index) => previous[index] === undefined ? delete process.env[name] : process.env[name] = previous[index]);
  }
});
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
test("one profile rejects a second controller until release", async () => {
  const lease = createControllerLease(() => true); lease.acquire(a);
  expect(() => lease.acquire(b)).toThrow("active controller");
  await lease.release(a.id); expect(lease.acquire(b).acquired).toBe(true);
  await expect(lease.run(a.id, async () => 1)).rejects.toThrow("Acquire");
});
test("handoff waits for active and queued actions", async () => {
  const lease = createControllerLease(() => true); lease.acquire(a);
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
  let alive = true; const lease = createControllerLease(() => alive); lease.acquire(a);
  let finish!: () => void;
  const action = lease.run(a.id, () => new Promise<void>(resolve => { finish = resolve; }));
  await Bun.sleep(0); alive = false;
  expect(() => lease.acquire(b)).toThrow("active controller");
  finish(); await action;
  expect(lease.acquire(b).acquired).toBe(true);
});
test("an action failure releases the service queue", async () => {
  const lease = createControllerLease(() => true); lease.acquire(a);
  await expect(lease.run(a.id, async () => { throw Error("action failed"); })).rejects.toThrow("action failed");
  await lease.release(a.id); expect(lease.acquire(b).acquired).toBe(true);
});
