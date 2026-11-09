import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createControlRegistry } from "../../src/mcp/control-registry.ts";
import { initializedFingerprint } from "../../src/browser/fingerprint-transaction.ts";
import { processStart } from "../../src/runtime/profile-process.ts";
import { UPSTREAM_VERSION } from "../../src/versions.ts";
import { ROOT } from "../../src/paths.ts";
import { createMockPackage } from "../helpers/mock-package.ts";

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "stelz-gateway-")), pkg = createMockPackage(directory);
  const portServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = portServer.port!; portServer.stop(true);
  const profile = join(directory, "profiles/test"), upstream = join(directory, `runtime/camofox-${UPSTREAM_VERSION}`);
  mkdirSync(profile, { recursive: true }); mkdirSync(join(upstream, "plugins/local-profile"), { recursive: true });
  mkdirSync(join(upstream, "mcp/lib"), { recursive: true });
  // The compiled plugin resolves the launcher from the runtime, as setup links it.
  symlinkSync(join(ROOT, "node_modules"), join(upstream, "node_modules"), "dir");
  writeFileSync(join(directory, "profiles.json"), JSON.stringify({ profiles: [{ id: "test", port }] }));
  writeFileSync(join(directory, "runtime/versions.json"), "{}");
  writeFileSync(join(profile, "access-key"), "test-key");
  const output = join(directory, "compiled");
  const built = await Bun.build({ entrypoints: [join(ROOT, "src/browser/plugin.ts")], target: "node", format: "esm",
    packages: "external", outdir: output, naming: "plugin.js" });
  if (!built.success) throw Error(built.logs.join("\n"));
  const compiled = readFileSync(join(output, "plugin.js"));
  writeFileSync(join(pkg.packageRoot, "dist/plugin.js"), compiled);
  writeFileSync(join(upstream, "plugins/local-profile/index.js"), compiled);
  const binary = join(directory, "browser"); writeFileSync(binary, "fixture browser");
  writeFileSync(join(upstream, "mcp/lib/tool-contracts.mjs"), `
    export const TOOL_DEFS = [{ name: 'camofox_snapshot', description: 'snapshot', inputSchema: { type: 'object', required: ['tabId'] } }];
    export async function runTool() { return globalThis.__gatewayAction(); }
    export function adaptResponse(_spec, payload) { return [{ type: 'text', text: JSON.stringify(payload) }]; }
  `);
  const plugin = pathToFileURL(join(upstream, "plugins/local-profile/index.js")).href;
  writeFileSync(join(upstream, "server.js"), `
    const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
    const { EventEmitter } = require('node:events');
    const directory = process.env.STELZ_PROFILE_DIR, routes = new Map(), events = new EventEmitter();
    const app = { get(path, ...handlers) { routes.set('GET ' + path, handlers); }, post(path, ...handlers) { routes.set('POST ' + path, handlers); } };
    const auth = () => (req, res, next) => req.headers.authorization === 'Bearer ' + process.env.CAMOFOX_ACCESS_KEY
      ? next() : res.status(401).json({ error: 'Unauthorized' });
    const page = Object.assign(new EventEmitter(), { url: () => 'about:blank' });
    const context = Object.assign(new EventEmitter(), { pages: () => [page], async close() {
      fs.writeFileSync(path.join(directory, 'context-closed'), 'closed'); context.emit('close');
    } });
    globalThis.__gatewayAction = async () => {
      fs.writeFileSync(path.join(directory, 'action-started'), 'started');
      while (!fs.existsSync(path.join(directory, 'action-finished'))) await new Promise(resolve => setTimeout(resolve, 10));
      return { spec: {}, payload: { completed: true } };
    };
    const emit = async (name, value) => Promise.all(events.listeners(name).map(fn => fn(value)));
    let server, shutdownStarted = false;
    function shutdown() { if (shutdownStarted) return; shutdownStarted = true; events.emit('server:shutdown'); server.close(() => process.exit(0)); }
    (async () => {
      const { register } = await import(${JSON.stringify(plugin)});
      await register(app, { auth, events }, { actionTimeoutMs: 100, verifyFingerprint: async () => {}, shutdown });
      await emit('browser:launching', { options: { env: { CAMOU_CONFIG_1: JSON.stringify({ 'navigator.userAgent': 'fixture' }) }, firefoxUserPrefs: {} } });
      server = http.createServer(async (req, res) => {
        const response = { status(code) { res.statusCode = code; return response; }, json(value) {
          res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value));
        } };
        if (req.url === '/health') return response.json({ browserRunning: true });
        if (req.url === '/tabs' && req.method === 'POST') {
          for await (const _chunk of req) { /* Drain the bootstrap body. */ }
          await emit('session:creating', { userId: 'test', contextOptions: {} });
          await emit('session:created', { userId: 'test', context });
          return response.json({ tabId: '79bed5c4-d5b8-4369-9d13-b159451ece91', url: page.url() });
        }
        let text = ''; for await (const chunk of req) text += chunk;
        const request = { headers: req.headers, body: text ? JSON.parse(text) : undefined };
        const handlers = routes.get(req.method + ' ' + req.url);
        if (!handlers) return response.status(404).json({ error: 'Not found' });
        let index = 0; const next = () => handlers[index++]?.(request, response, next);
        try { await next(); } catch (error) { if (!res.writableEnded) response.status(500).json({ error: String(error) }); }
      }).listen(Number(process.env.CAMOFOX_PORT), '127.0.0.1');
      process.on('SIGTERM', shutdown);
    })().catch(error => { console.error(error); process.exit(1); });
  `);
  const env = { ...process.env, STELZ_HOME: directory, CAMOUFOX_EXECUTABLE: binary };
  async function command(action: string) {
    const child = Bun.spawn([process.execPath, "--no-env-file", pkg.cli, action, "test"], { env, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGTERM"), 15000);
    try { const [code, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, out, error }; } finally { clearTimeout(timer); }
  }
  const url = `http://127.0.0.1:${port}`;
  async function request(action: string, body?: Record<string, unknown>, authorized = true) {
    const response = await fetch(`${url}/local-profile/${action}`, { method: body ? "POST" : "GET",
      headers: { ...(authorized ? { Authorization: "Bearer test-key" } : {}), "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { code: response.status, value: await response.json() as Record<string, unknown> };
  }
  return { directory, profile, command, request, url, async dispose() {
    writeFileSync(join(profile, "action-finished"), "finish");
    if (existsSync(join(profile, "running.json"))) {
      const saved = JSON.parse(readFileSync(join(profile, "running.json"), "utf8"));
      await command("stop");
      if (saved.serverPid && processStart(saved.serverPid) === saved.serverStart || saved.pid && processStart(saved.pid) === saved.supervisorStart)
        throw Error(`Owned test service remains recorded: ${directory}`);
    }
    rmSync(directory, { recursive: true, force: true });
  } };
}

for (const mode of ["release", "disconnect"] as const) test(`the HTTP gateway permits ${mode} cleanup after a terminal block`, async () => {
  const f = await fixture();
  try {
    const start = await f.command("start");
    expect(start, start.error).toMatchObject({ code: 0 });
    const status = (await f.request("status")).value;
    const running = JSON.parse(readFileSync(join(f.profile, "running.json"), "utf8"));
    const journalFile = join(f.profile, "fingerprint-transaction.json"), original = readFileSync(journalFile, "utf8");
    const owner = { profileId: "test", attemptId: running.instanceId, browserInstanceId: String(status.instanceId),
      configurationHash: running.configurationHash, serverPid: running.serverPid };
    for (const [field, value] of [["profileId", "another-profile"], ["browserInstanceId", "another-browser"],
      ["attemptId", "another-attempt"], ["configurationHash", "different"], ["serverPid", 1]] as const) {
      const altered = JSON.parse(original); altered.owner[field] = value; writeFileSync(journalFile, JSON.stringify(altered));
      expect(initializedFingerprint(f.profile, owner, String(status.pinSha256))).toBe(false);
      expect((await f.request("acquire", { profileId: "test", instanceId: status.instanceId, id: "foreign", pid: process.pid, label: "test" })).code).toBe(409);
    }
    writeFileSync(journalFile, original);
    expect(initializedFingerprint(f.profile, owner, String(status.pinSha256))).toBe(true);
    const binding = { profileId: "test", instanceId: String(status.instanceId) };
    const registry = createControlRegistry({ bind: async () => binding, assertCurrent: () => {}, ended: () => false,
      async request(_binding, action, body) {
        const result = await f.request(action, body);
        if (result.code !== 200) throw Error(String(result.value.error));
        return result.value;
      } });
    const acquired = await registry.acquire("test", "gateway-test");
    const action = registry.run("test", acquired.controlHandle, "tool", { name: "camofox_snapshot",
      args: { tabId: "79bed5c4-d5b8-4369-9d13-b159451ece91" } }).catch(error => error);
    expect(String(await action)).toContain("time limit");
    expect(existsSync(join(f.profile, "action-started"))).toBe(true);
    const blocked = (await f.request("status")).value;
    expect(blocked.phase).toBe("blocked");
    expect((await f.request("release", { profileId: "test", instanceId: status.instanceId, controllerId: "foreign" }, false)).code).toBe(401);
    for (const identity of [{ profileId: "other", instanceId: status.instanceId }, { profileId: "test", instanceId: "stale" }])
      expect((await f.request("release", { ...identity, controllerId: "foreign" })).code).toBe(409);
    expect((await f.request("release", { profileId: "test", instanceId: status.instanceId, controllerId: "foreign" })).code).toBe(200);
    expect((await f.request("status")).value.controller).toBeTruthy();
    expect((await f.request("acquire", { ...binding, id: "next", pid: process.pid, label: "test" })).code).toBe(409);
    expect((await f.request("tool", { ...binding, controllerId: "foreign", name: "camofox_snapshot", args: {} })).code).toBe(409);
    let settled = false;
    const cleanup = (mode === "release" ? registry.release("test", acquired.controlHandle) : registry.close())
      .then(value => { settled = true; return value; });
    await Bun.sleep(150);
    expect(settled).toBe(false);
    expect(existsSync(join(f.profile, "context-closed"))).toBe(false);
    writeFileSync(join(f.profile, "action-finished"), "finish");
    await cleanup;
    const after = (await f.request("status")).value;
    expect(after.phase).toBe("blocked"); expect(after.controller).toBeNull();
    expect(existsSync(join(f.profile, "context-closed"))).toBe(false);
    expect(JSON.parse(readFileSync(join(f.profile, "running.json"), "utf8")).instanceId).toBe(running.instanceId);
  } finally { await f.dispose(); }
}, 45000);
