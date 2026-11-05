import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { processStart, type Running } from "../../packages/stelz/src/runtime/profile-process.ts";
import { UPSTREAM_VERSION } from "../../packages/stelz/src/versions.ts";
import { ROOT } from "../../packages/stelz/src/paths.ts";

const cli = resolve(import.meta.dir, "../../packages/stelz/src/cli/cli.ts");
function fixture(legacy = false) {
  const home = mkdtempSync(join(tmpdir(), "stelz-concurrency-"));
  const sockets = Array.from({ length: 3 }, () => Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }));
  const profiles = sockets.map((socket, index) => ({ id: `concurrent-${index}`, port: socket.port! }));
  for (const socket of sockets) socket.stop(true);
  mkdirSync(join(home, "profiles"));
  writeFileSync(join(home, "profiles.json"), JSON.stringify({ ...(legacy ? { maxActive: 1 } : {}), profiles }));
  const upstream = join(home, "runtime", `camofox-${UPSTREAM_VERSION}`);
  mkdirSync(upstream, { recursive: true });
  mkdirSync(join(upstream, "plugins/local-profile"), { recursive: true });
  writeFileSync(join(upstream, "plugins/local-profile/index.js"), readFileSync(join(ROOT, "dist/plugin.js")));
  writeFileSync(join(home, "runtime/versions.json"), "{}");
  writeFileSync(join(upstream, "server.js"), `
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const dir = process.env.STELZ_PROFILE_DIR, id = process.env.STELZ_PROFILE_ID;
const running = JSON.parse(fs.readFileSync(path.join(dir, 'running.json'), 'utf8'));
const state = { profileId: id, phase: 'ready', instanceId: running.instanceId };
fs.writeFileSync(path.join(dir, 'launch-environment.json'), JSON.stringify(Object.fromEntries(
  ['PROXY_HOST', 'PROXY_PORT', 'PROXY_PROTOCOL', 'STELZ_MODE', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'].filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]))));
fs.appendFileSync(path.join(process.env.STELZ_HOME, 'launches.jsonl'), JSON.stringify({ id, server: process.pid, supervisor: process.ppid, instanceId: running.instanceId }) + '\\n');
const save = () => fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(state));
save();
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
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
    const child = Bun.spawn([process.execPath, "--no-env-file", cli, action, id], {
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

test("three profiles start concurrently despite legacy maxActive and an unrelated orphan", async () => {
  const f = fixture(true);
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
    expect(JSON.parse(readFileSync(join(f.home, "profiles.json"), "utf8")).maxActive).toBe(1);
  } finally { await f.dispose(); }
}, 45000);

test("racing starts reserve one supervisor, server, and lifetime for a profile", async () => {
  const f = fixture(), id = f.profiles[0]!.id;
  try {
    const results = await Promise.all(Array.from({ length: 8 }, () => f.command("start", id)));
    for (const result of results) expect(result, result.error).toMatchObject({ code: 0 });
    const record = f.record(id);
    expect(f.launches()).toEqual([{ id, server: record.serverPid, supervisor: record.pid, instanceId: record.instanceId }]);
    expect(new Set(results.map(result => JSON.parse(result.out).instanceId))).toEqual(new Set([record.instanceId]));
    expect((await f.command("start", id)).code).toBe(0);
    expect(f.record(id)).toEqual(record);
    expect(f.launches()).toHaveLength(1);
  } finally { await f.dispose(); }
}, 45000);

test("supervisors discard ambient proxy variables and forward only validated profile routing", async () => {
  const f = fixture(), [direct, proxy] = f.profiles;
  try {
    writeFileSync(join(f.home, "profiles.json"), JSON.stringify({ profiles: [direct, { ...proxy, proxyEnv: "ENV_TEST_PROXY" }] }));
    writeFileSync(join(f.home, "secrets.env"), "ENV_TEST_PROXY=https://fixture-user:fixture-password@configured.test:9443\n");
    const ambient = Object.fromEntries(["PROXY_HOST", "PROXY_PORT", "PROXY_PROTOCOL", "STELZ_MODE", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
      "http_proxy", "https_proxy", "all_proxy", "no_proxy"].map(name => [name, "untrusted-value"]));
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
