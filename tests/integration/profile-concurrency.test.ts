import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processStart, type Running } from "../../src/runtime/profile-process.ts";
import { UPSTREAM_VERSION } from "../../src/versions.ts";
import { fixtureLauncher } from "../helpers/geoip-fixture.ts";
import { createMockPackage } from "../helpers/mock-package.ts";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "stelz-concurrency-"));
  const packageFixture = createMockPackage(home);
  const sockets = Array.from({ length: 3 }, () => Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }));
  const profiles = sockets.map((socket, index) => ({ id: `concurrent-${index}`, port: socket.port! }));
  for (const socket of sockets) socket.stop(true);
  mkdirSync(join(home, "profiles"));
  writeFileSync(join(home, "profiles.json"), JSON.stringify({ profiles }));
  const upstream = join(home, "runtime", `camofox-${UPSTREAM_VERSION}`);
  mkdirSync(upstream, { recursive: true });
  mkdirSync(join(upstream, "plugins/local-profile"), { recursive: true });
  writeFileSync(join(upstream, "plugins/local-profile/index.js"), packageFixture.plugin);
  writeFileSync(join(home, "runtime/versions.json"), "{}");
  writeFileSync(join(upstream, "server.js"), `
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const dir = process.env.STELZ_PROFILE_DIR, id = process.env.STELZ_PROFILE_ID;
const running = JSON.parse(fs.readFileSync(path.join(dir, 'running.json'), 'utf8'));
const state = { profileId: id, phase: 'starting', instanceId: 'browser-' + running.instanceId };
fs.writeFileSync(path.join(dir, 'launch-environment.json'), JSON.stringify(Object.fromEntries(
  ['PROXY_HOST', 'PROXY_PORT', 'PROXY_PROTOCOL', 'STELZ_MODE', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'].filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]))));
fs.appendFileSync(path.join(process.env.STELZ_HOME, 'launches.jsonl'), JSON.stringify({ id, server: process.pid, supervisor: process.ppid, instanceId: running.instanceId }) + '\\n');
const save = () => fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(state));
save();
const server = http.createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/health') { res.end(JSON.stringify({ browserRunning: true })); return; }
  if (req.url === '/tabs') {
    const hold = path.join(process.env.STELZ_HOME, 'hold-' + id);
    if (fs.existsSync(hold)) {
      fs.writeFileSync(path.join(process.env.STELZ_HOME, 'waiting-' + id), '');
      while (fs.existsSync(hold)) await new Promise(resolve => setTimeout(resolve, 10));
    }
    const candidate = JSON.stringify({ version: 2, engineSha256: 'a'.repeat(64), config: { 'navigator.userAgent': 'fixture' } });
    const sha256 = crypto.createHash('sha256').update(candidate).digest('hex'), transactionId = crypto.randomUUID();
    const name = '.fingerprint-' + transactionId + '.candidate', file = path.join(dir, name);
    fs.writeFileSync(file, candidate, { mode: 0o600, flag: 'wx' });
    const info = fs.statSync(file);
    fs.writeFileSync(path.join(dir, 'fingerprint-transaction.json'), JSON.stringify({ version: 1, id: transactionId,
      owner: { profileId: id, attemptId: running.instanceId, browserInstanceId: state.instanceId,
        configurationHash: running.configurationHash, serverPid: process.pid }, before: null, candidate, sha256,
      publication: { name, dev: info.dev, ino: info.ino } }), { mode: 0o600 });
    state.pinSha256 = sha256; state.startupPrepared = true; save();
    res.end(JSON.stringify({ tabId: 'blank', url: 'about:blank' })); return;
  }
  if (req.url === '/local-profile/startup-ack') { state.phase = 'ready'; save(); res.end(JSON.stringify(state)); return; }
  if (req.url === '/local-profile/stop') {
    res.end(JSON.stringify({ stopping: true })); setTimeout(stop, 10); return;
  }
  res.end(JSON.stringify(state));
}).listen(Number(process.env.CAMOFOX_PORT), '127.0.0.1');
function stop() { state.phase = 'stopped'; save(); server.close(() => process.exit(0)); }
process.on('SIGTERM', stop);
`);
  const record = (id: string): Running => JSON.parse(readFileSync(join(home, "profiles", id, "running.json"), "utf8"));
  async function command(action: string, id: string, overrides: Record<string, string> = {}) {
    const child = Bun.spawn([process.execPath, "--no-env-file", packageFixture.cli, action, id], {
      env: { ...process.env, STELZ_HOME: home, ...overrides }, stdout: "pipe", stderr: "pipe",
    });
    const timeout = setTimeout(() => child.kill("SIGTERM"), 15000);
    try {
      const [code, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, out, error };
    } finally { clearTimeout(timeout); }
  }
  return { home, profiles, record, command,
    launches: () => readFileSync(join(home, "launches.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)),
    async dispose() {
      for (const p of profiles) {
        if (!existsSync(join(home, "profiles", p.id, "running.json"))) continue;
        const result = await command("stop", p.id);
        const saved = record(p.id);
        if ((saved.serverPid && processStart(saved.serverPid) === saved.serverStart) || (saved.pid > 1 && processStart(saved.pid) === saved.supervisorStart))
          throw Error(`Test processes remain recorded in ${home}: ${result.error}`);
      }
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("three profiles start concurrently with an unrelated orphan", async () => {
  const f = fixture();
  const removed = join(f.home, "profiles/removed"); mkdirSync(removed);
  const orphan = JSON.stringify({ version: 2, pid: 2147483647, supervisorStart: "dead", serverPid: process.pid,
    serverStart: processStart(process.pid), serverState: "started", instanceId: "removed", configurationHash: "old" });
  writeFileSync(join(removed, "running.json"), orphan);
  try {
    const results = await Promise.all(f.profiles.map(p => f.command("start", p.id)));
    for (const result of results) expect(result, result.error).toMatchObject({ code: 0 });
    const records = f.profiles.map(p => f.record(p.id));
    expect(new Set(records.map(r => r.instanceId)).size).toBe(3);
    expect(new Set(records.map(r => r.serverPid)).size).toBe(3);
    for (const record of records) {
      expect(processStart(record.pid)).toBe(record.supervisorStart);
      expect(processStart(record.serverPid!)).toBe(record.serverStart);
    }
    expect(f.launches()).toHaveLength(3);
    expect(readFileSync(join(removed, "running.json"), "utf8")).toBe(orphan);
  } finally { await f.dispose(); }
}, 45000);

test("racing starts reserve one supervisor, server, and lifetime for a profile", async () => {
  const f = fixture(), id = f.profiles[0]!.id;
  try {
    const results = await Promise.all(Array.from({ length: 8 }, () => f.command("start", id)));
    for (const result of results) expect(result, result.error).toMatchObject({ code: 0 });
    const record = f.record(id);
    expect(f.launches()).toEqual([{ id, server: record.serverPid, supervisor: record.pid, instanceId: record.instanceId }]);
    const browserInstances = new Set(results.map(result => JSON.parse(result.out).instanceId));
    const initialized = JSON.parse(readFileSync(join(f.home, "profiles", id, "initialized.json"), "utf8"));
    expect(initialized.instanceId).toBe(record.instanceId);
    expect(initialized.browserInstanceId).toBe(`browser-${record.instanceId}`);
    expect(browserInstances).toEqual(new Set([initialized.browserInstanceId]));
    const repeated = await f.command("start", id);
    expect(repeated.code).toBe(0);
    expect(JSON.parse(repeated.out).instanceId).toBe(initialized.browserInstanceId);
    expect(f.record(id)).toEqual(record);
    expect(f.launches()).toHaveLength(1);
  } finally { await f.dispose(); }
}, 45000);

test("a stalled profile startup does not hold admission for another profile", async () => {
  const f = fixture(), slow = f.profiles[0]!, fast = f.profiles[1]!;
  const hold = join(f.home, `hold-${slow.id}`), waiting = join(f.home, `waiting-${slow.id}`);
  writeFileSync(hold, "");
  let slowStart: ReturnType<typeof f.command> | undefined;
  try {
    slowStart = f.command("start", slow.id);
    const deadline = Date.now() + 10000;
    while (!existsSync(waiting) && Date.now() < deadline) await Bun.sleep(20);
    expect(existsSync(waiting)).toBe(true);
    const result = await f.command("start", fast.id);
    expect(result, result.error).toMatchObject({ code: 0 });
    expect(JSON.parse(result.out).phase).toBe("ready");
    expect(existsSync(join(f.home, "profiles", slow.id, "fingerprint.json"))).toBe(false);
    rmSync(hold);
    const completed = await slowStart;
    expect(completed, completed.error).toMatchObject({ code: 0 });
  } finally {
    rmSync(hold, { force: true });
    if (slowStart) await slowStart;
    await f.dispose();
  }
}, 45000);

test("stopping a stalled startup leaves admission available to another profile", async () => {
  const f = fixture(), slow = f.profiles[0]!, fast = f.profiles[1]!;
  const hold = join(f.home, `hold-${slow.id}`), waiting = join(f.home, `waiting-${slow.id}`);
  writeFileSync(hold, "");
  let start: ReturnType<typeof f.command> | undefined, stop: ReturnType<typeof f.command> | undefined;
  try {
    start = f.command("start", slow.id);
    const deadline = Date.now() + 10000;
    while (!existsSync(waiting) && Date.now() < deadline) await Bun.sleep(20);
    expect(existsSync(waiting)).toBe(true);
    stop = f.command("stop", slow.id);
    const stopped = join(f.home, "profiles", slow.id, "status.json");
    const stopDeadline = Date.now() + 10000;
    while ((!existsSync(stopped) || JSON.parse(readFileSync(stopped, "utf8")).phase !== "stopped") && Date.now() < stopDeadline)
      await Bun.sleep(20);
    expect(JSON.parse(readFileSync(stopped, "utf8")).phase).toBe("stopped");
    const other = await f.command("start", fast.id);
    expect(other, other.error).toMatchObject({ code: 0 });
    rmSync(hold);
    await Promise.all([start, stop]);
  } finally {
    rmSync(hold, { force: true });
    await Promise.allSettled([start, stop].filter((value): value is Promise<Awaited<ReturnType<typeof f.command>>> => !!value));
    await f.dispose();
  }
}, 45000);

test("supervisors discard ambient proxy variables and forward only validated profile routing", async () => {
  const f = fixture(), [direct, proxy] = f.profiles;
  fixtureLauncher(f.home);
  writeFileSync(join(f.home, "browser"), "fixture browser");
  try {
    writeFileSync(join(f.home, "profiles.json"), JSON.stringify({ profiles: [direct, { ...proxy, proxyEnv: "ENV_TEST_PROXY" }] }));
    writeFileSync(join(f.home, "secrets.env"), "ENV_TEST_PROXY=https://fixture-user:fixture-password@configured.test:9443\n");
    const ambient = Object.fromEntries(["PROXY_HOST", "PROXY_PORT", "PROXY_PROTOCOL", "STELZ_MODE", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
      "http_proxy", "https_proxy", "all_proxy", "no_proxy"].map(name => [name, "untrusted-value"]));
    ambient.CAMOUFOX_EXECUTABLE = join(f.home, "browser");
    ambient.NO_PROXY = ambient.no_proxy = "127.0.0.1,localhost";
    for (const p of [direct!, proxy!]) {
      const result = await f.command("start", p.id, ambient);
      expect(result, result.error).toMatchObject({ code: 0 });
    }
    const environment = (id: string) => JSON.parse(readFileSync(join(f.home, "profiles", id, "launch-environment.json"), "utf8"));
    expect(environment(direct!.id)).toEqual({});
    expect(environment(proxy!.id)).toEqual({ PROXY_HOST: "configured.test", PROXY_PORT: "9443", PROXY_PROTOCOL: "https" });
  } finally { await f.dispose(); }
}, 45000);
