import { afterEach, expect, test } from "bun:test";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import type { Profile } from "../../packages/stelz/src/profiles/config.ts";

const root = resolve(import.meta.dir, "../.."), homes: string[] = [];
const modelPath = join(root, "packages/stelz/src/api/ui-model.ts"), runtimePath = join(root, "packages/stelz/src/runtime/runtime.ts");
type Fixture = { home: string; state: string; config: string; secrets: string; profiles: Profile[] };
function fixture(profiles: Profile[] = [{ id: "test", port: 19471, mode: "direct", storage: "native" }], secrets = "# private configuration\n", initialized = true): Fixture {
  const home = mkdtempSync(join(tmpdir(), "stelz-ui-model-"));
  homes.push(home);
  const state = join(home, "profiles"), config = join(home, "profiles.json"), secretFile = join(home, "secrets.env");
  if (initialized) {
    mkdirSync(state, { recursive: true });
    for (const p of profiles) mkdirSync(join(state, p.id), { recursive: true });
    writeFileSync(config, JSON.stringify({ maxActive: 2, profiles: profiles }), { mode: 0o600 });
    writeFileSync(secretFile, secrets, { mode: 0o600 });
  }
  return { home, state, config, secrets: secretFile, profiles };
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

async function run(f: Fixture, body: string, env: Record<string, string> = {}, prelude = "") {
  // Import in a new process: config.ts captures STELZ_HOME at module load.
  const script = `import * as fs from "node:fs";
import { join } from "node:path";
${prelude}
const { createUiModel, redactUiText } = await import(${JSON.stringify(modelPath)});
const runtime = await import(${JSON.stringify(runtimePath)});
const home = process.env.STELZ_HOME, model = createUiModel();
try {
  const value = await (async () => { ${body} })();
  console.log(JSON.stringify({ ok: true, value }));
} catch (error) { console.log(JSON.stringify({ ok: false, status: error.status, message: error.message })); }`;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
    cwd: root, env: { ...process.env, STELZ_HOME: f.home, CAMOUFOX_EXECUTABLE: join(f.home, "no-browser"), ...env }, stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw Error(stderr || stdout || `UI model test process exited ${code}.`);
  return JSON.parse(stdout.trim());
}
function tree(folder: string): unknown[] {
  return readdirSync(folder).sort().map(name => {
    const file = join(folder, name), info = lstatSync(file);
    return [name, info.mode, info.mtimeMs, info.isDirectory() ? tree(file) : readFileSync(file, "utf8")];
  });
}
const withRevision = `const revision = (await model.snapshot()).profiles[0].network.revision;`;
const withCatalogRevision = `const revision = (await model.snapshot()).catalogRevision;`;

test("the UI creates named profiles with optional proxies and omits legacy capacity metadata", async () => {
  const f = fixture([], "# keep this comment\nUNRELATED='literal # value'\n");
  const result = await run(f, `
    const initial = await model.snapshot();
    const first = await model.createProfile({ id: 'work', revision: initial.catalogRevision });
    const second = await model.createProfile({ id: 'personal', revision: (await model.snapshot()).catalogRevision,
      proxyUrl: 'http://private-reader:private-password@proxy.test:8080', expectedIp: '2001:db8::9' });
    await model.createProfile({ id: 'spare', revision: (await model.snapshot()).catalogRevision });
    return { first, second, initial, snapshot: await model.snapshot() };
  `);
  expect(result.ok).toBe(true);
  expect(result.value.initial.profiles).toEqual([]);
  expect(result.value.initial).not.toHaveProperty("maxActive");
  expect(result.value.snapshot).not.toHaveProperty("maxActive");
  expect(result.value.first).toMatchObject({ id: "work", phase: "stopped", mode: "direct", storage: "native", configurationError: null });
  expect(result.value.first.network).toMatchObject({ proxyConfigured: false, expectedIp: "" });
  expect(result.value.second).toMatchObject({ id: "personal", phase: "stopped", mode: "proxy", storage: "native", configurationError: null });
  expect(result.value.second.network).toMatchObject({ proxyDisplay: "http://proxy.test:8080", expectedIp: "2001:db8::9" });
  expect(result.value.snapshot.profiles).toHaveLength(3);
  expect(new Set(result.value.snapshot.profiles.map((row: { port: number }) => row.port)).size).toBe(3);
  expect(result.value.snapshot.catalogRevision).not.toBe(result.value.initial.catalogRevision);
  expect(JSON.stringify(result)).not.toMatch(/private-reader|private-password/);
  const config = JSON.parse(readFileSync(f.config, "utf8")), secrets = readFileSync(f.secrets, "utf8");
  expect(config.maxActive).toBe(2);
  expect(secrets).toContain("# keep this comment\nUNRELATED='literal # value'\n");
  expect(parseEnv(secrets)[config.profiles[1].proxyEnv]).toBe("http://private-reader:private-password@proxy.test:8080");
  expect(lstatSync(f.secrets).mode & 0o777).toBe(0o600);
  expect(readdirSync(f.state)).toEqual(["admission.lock"]);
}, 10000);

test("creation rejects unsafe input, duplicate state, and stale catalog revisions", async () => {
  const f = fixture();
  const before = [readFileSync(f.config, "utf8"), readFileSync(f.secrets, "utf8")];
  for (const input of [
    { id: "../outside" }, { id: "Uppercase" }, { id: "all" }, { id: "valid", storage: "checkpoint" },
    { id: "valid", proxyUrl: "socks5://reader:password@proxy.test:1080" },
    { id: "valid", proxyUrl: "http://proxy.test:8080\nINJECTED=value" },
    { id: "valid", expectedIp: "not-an-ip" }, { id: "test" },
    { id: "valid", revision: "0".repeat(64) },
  ]) {
    const result = await run(f, `${withCatalogRevision} return await model.createProfile({ revision, ...${JSON.stringify(input)} });`);
    expect(result.ok).toBe(false);
    expect([400, 409]).toContain(result.status);
    expect([readFileSync(f.config, "utf8"), readFileSync(f.secrets, "utf8")]).toEqual(before);
  }
  mkdirSync(join(f.state, "orphan"));
  const orphan = await run(f, `${withCatalogRevision} return await model.createProfile({ revision, id: 'orphan' });`);
  expect(orphan).toMatchObject({ ok: false, status: 409 });
});

test("catalog writes serialize and reject competing revisions", async () => {
  const f = fixture([]);
  const result = await run(f, `${withCatalogRevision}
    const results = await Promise.allSettled(['first', 'second'].map(id => model.createProfile({ id, revision })));
    return { statuses: results.map(result => result.status), snapshot: await model.snapshot() };`);
  expect(result.ok).toBe(true);
  expect(result.value.statuses.sort()).toEqual(["fulfilled", "rejected"]);
  expect(result.value.snapshot.profiles).toHaveLength(1);
});

test("deleting a stopped profile archives its complete profile and retains shared secrets", async () => {
  const f = fixture([proxyProfile, { id: "other", port: 19472, mode: "direct", storage: "native" }], "UI_TEST_PROXY=http://reader:password@proxy.test:8080\n");
  mkdirSync(join(f.state, "test/browser-data"));
  writeFileSync(join(f.state, "test/browser-data/saved-cookie"), "private saved session");
  writeFileSync(join(f.state, "test/fingerprint.json"), '{"version":2,"config":{}}');
  const before = readFileSync(f.secrets, "utf8");
  const result = await run(f, `${withCatalogRevision} await model.deleteProfile('test', revision); return await model.snapshot();`);
  expect(result.ok).toBe(true);
  expect(result.value.profiles.map((row: { id: string }) => row.id)).toEqual(["other"]);
  expect(existsSync(join(f.state, "test"))).toBe(false);
  const archived = join(f.home, "trash", readdirSync(join(f.home, "trash"))[0]!);
  expect(readFileSync(join(archived, "profile/browser-data/saved-cookie"), "utf8")).toBe("private saved session");
  expect(JSON.parse(readFileSync(join(archived, "profile.json"), "utf8")).profile).toEqual(proxyProfile);
  expect(readFileSync(f.secrets, "utf8")).toBe(before);
  expect(existsSync(join(f.home, ".profile-transaction.json"))).toBe(false);
  const recreated = await run(f, `${withCatalogRevision} return await model.createProfile({ revision, id: 'test' });`);
  expect(recreated.value).toMatchObject({ id: "test", mode: "direct", storage: "native", phase: "stopped" });
  expect(readFileSync(join(archived, "profile/browser-data/saved-cookie"), "utf8")).toBe("private saved session");
}, 10000);

test("deletion refuses active, unclean, unknown, and symbolic-link state", async () => {
  const f = fixture(), before = readFileSync(f.config, "utf8");
  for (const record of [
    `{ version: 2, pid: process.pid, supervisorStart: runtime.processStart(process.pid), instanceId: 'active', serverState: 'not-started' }`,
    `{ version: 2, pid: 0, instanceId: 'unclean', serverState: 'not-started' }`,
    `{ version: 3, pid: 0, instanceId: 'future', serverState: 'not-started' }`,
  ]) {
    const result = await run(f, `${withCatalogRevision}
      fs.writeFileSync(join(home, 'profiles/test/running.json'), JSON.stringify(${record}));
      fs.writeFileSync(join(home, 'profiles/test/stopped.json'), JSON.stringify({ instanceId: 'future' }));
      await model.deleteProfile('test', revision);`);
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(readFileSync(f.config, "utf8")).toBe(before);
  }
  rmSync(join(f.state, "test/running.json"));
  const linked = join(f.home, "linked-state"); writeFileSync(linked, "{}");
  symlinkSync(linked, join(f.state, "test/running.json"));
  expect(await run(f, `${withCatalogRevision} await model.deleteProfile('test', revision);`)).toMatchObject({ ok: false, status: 409 });
  expect(readFileSync(f.config, "utf8")).toBe(before);
  expect(existsSync(join(f.home, "trash"))).toBe(false);
});

const catalogInterruption = (destination: string) => `import { mock } from 'bun:test';
const originalFs = { ...fs };
mock.module('node:fs', () => ({ ...originalFs, renameSync(from, to) {
  const value = originalFs.renameSync(from, to);
  if (${destination}) process.exit(23);
  return value;
}}));`;

test("an interrupted creation recovers secrets and configuration before a start", async () => {
  const f = fixture([]);
  await expect(run(f, `${withCatalogRevision} return await model.createProfile({ id: 'work', revision, proxyUrl: 'http://reader:password@proxy.test:8080' });`, {},
    catalogInterruption(`to === join(process.env.STELZ_HOME, 'secrets.env')`))).rejects.toThrow();
  expect(JSON.parse(readFileSync(f.config, "utf8")).profiles).toEqual([]);
  expect(lstatSync(join(f.home, ".profile-transaction.json")).mode & 0o777).toBe(0o600);
  const result = await run(f, `try { await runtime.start('work'); } catch (error) { if (!error.message.includes('setup')) throw error; } return await model.snapshot();`);
  expect(result.ok).toBe(true);
  expect(result.value.profiles[0]).toMatchObject({ id: "work", phase: "stopped", mode: "proxy", configurationError: null });
  expect(existsSync(join(f.home, ".profile-transaction.json"))).toBe(false);
  expect(existsSync(join(f.state, "work/running.json"))).toBe(false);
});

test("an interrupted deletion recovers before start and cannot recreate the archived profile", async () => {
  const f = fixture();
  writeFileSync(join(f.state, "test/saved-data"), "keep the original profile");
  await expect(run(f, `${withCatalogRevision} await model.deleteProfile('test', revision);`, {},
    catalogInterruption(`to.endsWith('/profile')`))).rejects.toThrow();
  expect(JSON.parse(readFileSync(f.config, "utf8")).profiles).toHaveLength(1);
  expect(existsSync(join(f.state, "test"))).toBe(false);
  const result = await run(f, `try { await runtime.start('test'); } catch (error) { if (!error.message.includes('Unknown profile')) throw error; } return await model.snapshot();`);
  expect(result.ok).toBe(true);
  expect(result.value.profiles).toEqual([]);
  expect(existsSync(join(f.state, "test"))).toBe(false);
  expect(existsSync(join(f.home, ".profile-transaction.json"))).toBe(false);
  const archived = join(f.home, "trash", readdirSync(join(f.home, "trash"))[0]!, "profile");
  expect(readFileSync(join(archived, "saved-data"), "utf8")).toBe("keep the original profile");
});

for (const action of ["stop", "recover"]) test(`${action} cannot recreate a profile after an interrupted deletion`, async () => {
  const f = fixture();
  writeFileSync(join(f.state, "test/saved-data"), "preserve this profile");
  await expect(run(f, `${withCatalogRevision} await model.deleteProfile('test', revision);`, {},
    catalogInterruption(`to.endsWith('/profile')`))).rejects.toThrow();
  const result = await run(f, `try { await runtime.${action}('test'); } catch (error) { if (!error.message.includes('Unknown profile')) throw error; } return await model.snapshot();`);
  expect(result.ok).toBe(true);
  expect(result.value.profiles).toEqual([]);
  expect(existsSync(join(f.state, "test"))).toBe(false);
  expect(existsSync(join(f.home, ".profile-transaction.json"))).toBe(false);
  const archived = join(f.home, "trash", readdirSync(join(f.home, "trash"))[0]!, "profile");
  expect(readFileSync(join(archived, "saved-data"), "utf8")).toBe("preserve this profile");
});

test("catalog recovery refuses manual file changes without overwriting them", async () => {
  const f = fixture();
  await expect(run(f, `${withCatalogRevision} await model.deleteProfile('test', revision);`, {},
    catalogInterruption(`to.endsWith('/profile')`))).rejects.toThrow();
  const manual = JSON.stringify({ maxActive: 1, profiles: f.profiles });
  writeFileSync(f.config, manual);
  const result = await run(f, `await runtime.start('test');`);
  expect(result).toMatchObject({ ok: false, status: 409, message: expect.stringContaining("manually changed") });
  expect(readFileSync(f.config, "utf8")).toBe(manual);
  expect(existsSync(join(f.state, "test"))).toBe(false);
  expect(existsSync(join(f.home, ".profile-transaction.json"))).toBe(true);
});
const proxyProfile: Profile = { id: "test", port: 19471, mode: "proxy", storage: "native", proxyEnv: "UI_TEST_PROXY", expectedIPEnv: "UI_TEST_EXPECTED" };
const journalName = ".network-transaction.json";
const oldNetworkSecrets = `# preserve the private file\nUNRELATED='literal # value' # keep comment\nMULTILINE="first\nUI_TEST_PROXY=inside a quoted value\nlast"\nUI_TEST_PROXY=http://old-user:old-password@old.test:8080\nUI_TEST_EXPECTED=198.51.100.9\n# end\n`;
function networkFixture() { return fixture([{ ...proxyProfile, mode: "direct" }], oldNetworkSecrets); }
function spawnNetworkSave(f: Fixture, onRename: string) {
  const script = `import * as fs from 'node:fs';
import { join } from 'node:path';
import { mock } from 'bun:test';
const originalFs = { ...fs }, home = process.env.STELZ_HOME;
const configPath = join(home, 'profiles.json'), secretsPath = join(home, 'secrets.env'), journalPath = join(home, ${JSON.stringify(journalName)});
mock.module('node:fs', () => ({ ...originalFs, renameSync(from, to) {
  ${onRename}
  return originalFs.renameSync(from, to);
}}));
const { createUiModel } = await import(${JSON.stringify(modelPath)});
const model = createUiModel(), revision = (await model.snapshot()).profiles[0].network.revision;
await model.updateNetwork('test', { revision, mode: 'proxy', proxyUrl: 'http://recovered-user:recovered-password@recovered.test:8181', expectedIp: '2001:db8::8' });
console.log('saved');`;
  return Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
    cwd: root, env: { ...process.env, STELZ_HOME: f.home, CAMOUFOX_EXECUTABLE: join(f.home, "no-browser") }, stdout: "pipe", stderr: "pipe",
  });
}
async function interruptedSave(f: Fixture, rollback = false) {
  const child = spawnNetworkSave(f, rollback ? `
    if (to === secretsPath) throw Error('injected-write-failure');
    if (to === journalPath && JSON.parse(originalFs.readFileSync(from, 'utf8')).direction === 'rollback') {
      originalFs.renameSync(from, to);
      process.kill(process.pid, 'SIGKILL');
    }
  ` : `
    if (to === configPath) { originalFs.renameSync(from, to); process.kill(process.pid, 'SIGKILL'); }
  `);
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
  if (child.signalCode !== "SIGKILL") throw Error(stderr || `Expected an interrupted save, received exit ${code}.`);
  expect(lstatSync(join(f.home, journalName)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(f.config, "utf8")).profiles[0].mode).toBe("proxy");
  expect(readFileSync(f.secrets, "utf8")).toBe(oldNetworkSecrets);
}
function expectRecovered(f: Fixture, committed = true) {
  const config = JSON.parse(readFileSync(f.config, "utf8")), text = readFileSync(f.secrets, "utf8"), secrets = parseEnv(text);
  expect(config.profiles[0]).toMatchObject({ id: "test", storage: "native", mode: committed ? "proxy" : "direct" });
  expect(secrets.UI_TEST_PROXY).toBe(committed ? "http://recovered-user:recovered-password@recovered.test:8181" : "http://old-user:old-password@old.test:8080");
  expect(secrets.UI_TEST_EXPECTED).toBe(committed ? "2001:db8::8" : "198.51.100.9");
  expect(text).toContain("UNRELATED='literal # value' # keep comment\n");
  expect(text).toContain('MULTILINE="first\nUI_TEST_PROXY=inside a quoted value\nlast"\n');
  expect(text.endsWith("# end\n")).toBe(true);
  expect(existsSync(join(f.home, journalName))).toBe(false);
  expect(readdirSync(f.home).filter(name => name.includes(".tmp"))).toEqual([]);
  expect(existsSync(join(f.state, "test/running.json"))).toBe(false);
}

test("uninitialized observations do not initialize or create service state", async () => {
  const f = fixture([], "", false), before = tree(f.home);
  const result = await run(f, "return { snapshot: await model.snapshot(), diagnostics: await model.diagnostics() };");
  expect(result.ok).toBe(true);
  expect(result.value.snapshot).toMatchObject({ initialized: false, setup: false, profiles: [] });
  expect(result.value.snapshot).not.toHaveProperty("maxActive");
  expect(result.value.diagnostics).toMatchObject({ initialized: false, profiles: [] });
  expect(tree(f.home)).toEqual(before);
});

test("stopped observations preserve files but do not present an old controller or failure as current", async () => {
  const f = fixture([proxyProfile], "UI_TEST_PROXY=http://reader:private-password@proxy.test:8080\nUI_TEST_EXPECTED=198.51.100.42\n");
  const state = join(f.state, "test");
  writeFileSync(join(state, "access-key"), "private-access-key");
  writeFileSync(join(state, "status.json"), JSON.stringify({
    phase: "blocked", controller: { id: "private-controller", label: "Client", pid: 123, activeActions: 2, releasing: false },
    error: "Old IP verification failure", checkFailure: "page.goto: NS_ERROR_UNKNOWN_HOST", controlError: "Old connection error",
  }));
  writeFileSync(join(state, "fingerprint.json"), JSON.stringify({ version: 1, config: { "navigator.userAgent": "Saved agent", "screen.width": 1440 } }));
  const before = tree(f.home);
  const result = await run(f, "return { snapshot: await model.snapshot(), detail: await model.detail('test'), diagnostics: await model.diagnostics() };");
  expect(result.ok).toBe(true);
  expect(result.value.snapshot.profiles[0]).toMatchObject({ phase: "stopped", controller: null, error: null, controlError: null });
  expect(result.value.detail.profile).toMatchObject({ phase: "stopped", controller: null, error: null, controlError: null });
  expect(result.value.detail.device).toEqual({ version: 1, properties: [{ name: "User agent", value: "Saved agent" }, { name: "Screen width (px)", value: "1440" }] });
  expect(tree(f.home)).toEqual(before);
});

test("live observations call only authenticated status and expose no controller ID", async () => {
  const f = fixture();
  const result = await run(f, `
    const calls = [], state = join(home, 'profiles/test');
    const service = Bun.serve({ port: 0, fetch(request) {
      calls.push([request.method, new URL(request.url).pathname, request.headers.get('authorization')]);
      return Response.json({ profileId: 'test', phase: 'verification_failed', error: 'Expected exit IP verification failed.', checkFailure: 'page.goto: NS_ERROR_UNKNOWN_HOST https://hidden-user:hidden-password@ip.example/?token=private-query', windowControls: { available: true }, controller: { id: 'lease-secret', label: 'Live client', pid: process.pid, activeActions: 1, releasing: false } });
    }});
    try {
      fs.writeFileSync(join(home, 'profiles.json'), JSON.stringify({ maxActive: 2, profiles: [{ id: 'test', port: service.port, mode: 'direct' }] }));
      fs.writeFileSync(join(state, 'access-key'), 'status-only-key');
      const stamp = runtime.processStart(process.pid);
      fs.writeFileSync(join(state, 'running.json'), JSON.stringify({ version: 2, pid: process.pid, supervisorStart: stamp, serverPid: process.pid, serverStart: stamp, serverState: 'started', instanceId: 'instance', configurationHash: 'unused', port: service.port }));
      const snapshot = await model.snapshot(), detail = await model.detail('test'), diagnostics = await model.diagnostics();
      return { snapshot, detail, diagnostics, calls: calls.map(call => [call[0], call[1], call[2] === 'Bearer status-only-key']) };
    } finally { service.stop(true); }
  `);
  expect(result.ok).toBe(true);
  expect(result.value.snapshot.profiles[0].phase).toBe("verification_failed");
  expect(result.value.snapshot.profiles[0].error).toContain("NS_ERROR_UNKNOWN_HOST");
  for (const value of ["hidden-user", "hidden-password", "private-query"]) expect(JSON.stringify(result.value)).not.toContain(value);
  expect(result.value.snapshot.profiles[0].controller.label).toBe("Live client");
  expect(result.value.snapshot.profiles[0].windowControls).toEqual({ available: true, reason: null });
  expect(result.value.calls).toEqual(Array(3).fill(["GET", "/local-profile/status", true]));
  expect(JSON.stringify(result.value)).not.toContain("lease-secret");
});

test("window inventories redact whole values before truncation and load secrets once per response", async () => {
  const password = "sensitive-window-password".repeat(30);
  const f = fixture([{ id: "test", port: 19471, mode: "direct", proxyEnv: "WINDOW_PROXY" }],
    `WINDOW_PROXY=http://window-user:${password}@proxy.test:8080\n`);
  const result = await run(f, `
    const { createWindowModel } = await import(${JSON.stringify(join(root, "packages/stelz/src/api/window-model.ts"))});
    const password = ${JSON.stringify(password)}, state = join(home, 'profiles/test');
    let unsupported = false;
    const service = Bun.serve({ port: 0, fetch(request) {
      if (new URL(request.url).pathname === '/local-profile/status') return Response.json({ profileId: 'test', instanceId: 'window-life', phase: 'ready' });
      if (unsupported) return new Response('<html>Not found</html>', { status: 404 });
      return Response.json({ profileId: 'test', instanceId: 'window-life', available: true, reason: null, updatedAt: new Date().toISOString(),
        windows: [{ id: 1, title: 'x'.repeat(230) + password, focused: true, state: 'normal', tabs: Array.from({ length: 100 }, (_, index) => ({
          id: index, active: index === 0, title: 'x'.repeat(190) + password,
          url: index === 99 ? 'https://window-user:' + password.slice(0, 490) : 'https://window-user:' + password + '@example.test/path?private=value',
        })) }] });
    }});
    try {
      fs.writeFileSync(join(home, 'profiles.json'), JSON.stringify({ maxActive: 2, profiles: [{ id: 'test', port: service.port, mode: 'direct', proxyEnv: 'WINDOW_PROXY' }] }));
      fs.writeFileSync(join(state, 'access-key'), 'window-service-key');
      fs.writeFileSync(join(state, 'status.json'), JSON.stringify({ profileId: 'test', instanceId: 'window-life', phase: 'ready' }));
      const stamp = runtime.processStart(process.pid);
      fs.writeFileSync(join(state, 'running.json'), JSON.stringify({ version: 2, pid: process.pid, supervisorStart: stamp,
        serverPid: process.pid, serverStart: stamp, serverState: 'started', instanceId: 'reservation', configurationHash: 'fixture', port: service.port }));
      const windows = createWindowModel(), inventory = await windows.list('test'), reads = secretReads;
      unsupported = true;
      return { inventory, reads, unsupported: await windows.list('test') };
    } finally { service.stop(true); }
  `, {}, `import { mock } from 'bun:test';
const originalFs = { ...(await import('node:fs')) };
let secretReads = 0;
mock.module('node:fs', () => ({ ...originalFs, readFileSync(path, ...args) {
  if (String(path).endsWith('/secrets.env')) secretReads++;
  return originalFs.readFileSync(path, ...args);
} }));`);
  expect(result.ok).toBe(true);
  expect(result.value.inventory.available).toBe(true);
  expect(result.value.inventory.windows[0].tabs).toHaveLength(100);
  expect(result.value.reads).toBe(1);
  expect(JSON.stringify(result.value)).not.toMatch(/window-user|sensitive-window|private=value/);
  expect(result.value.inventory.windows[0].title.length).toBeLessThanOrEqual(240);
  expect(result.value.inventory.windows[0].tabs[0].title.length).toBeLessThanOrEqual(200);
  expect(result.value.inventory.windows[0].tabs[99].url).toBe("");
  expect(result.value.unsupported).toMatchObject({ available: false, windows: [], reason: expect.stringContaining("stelz setup") });
});

test("all outward state, diagnostics, devices, errors, and both logs redact credentials", async () => {
  const f = fixture([proxyProfile], "UI_TEST_PROXY=http://u%40name:p%253Ass@proxy.test:8080\nUI_TEST_EXPECTED=198.51.100.42\nOTHER_SECRET=unrelated-private-value\n");
  const state = join(f.state, "test"), accessKey = "local-private-access-key", controllerId = "controller-private-id";
  const leak = `${accessKey} ${controllerId} u@name p%3Ass p%253Ass unrelated-private-value env-private-value https://unknown-user:unknown-pass@other.test:8443/path?token=query-private-value http://odd-user:pa'ss@quote.test Authorization: Bearer unknown-bearer-value`;
  writeFileSync(join(state, "access-key"), accessKey);
  writeFileSync(join(state, "status.json"), JSON.stringify({
    phase: "ready", instanceId: "safe-instance", exitIp: "198.51.100.42", checkedAt: "2026-11-02T00:00:00.000Z",
    fingerprintSha256: "a".repeat(64), engineSha256: { raw: accessKey }, error: leak, controlError: leak,
    controller: { id: controllerId, token: accessKey, label: leak, pid: 42, activeActions: 2, releasing: true },
    arbitrary: { env: leak }, rawEnv: leak,
  }));
  writeFileSync(join(state, "fingerprint.json"), JSON.stringify({ version: 2, config: {
    "navigator.userAgent": leak, "navigator.platform": "x".repeat(200), "navigator.hardwareConcurrency": 8,
    "screen.width": 1920, "screen.height": { arbitrary: leak }, "webGl:renderer": "Saved GPU",
    "navigator.randomObject": { data: leak }, "navigator.language": leak, "webGl:parameters": { raw: leak },
  }, firefoxUserPrefs: { raw: leak }, proxy: { password: leak } }));
  for (const name of ["server.log", "supervisor.log"])
    writeFileSync(join(state, name), Array.from({ length: 120 }, (_, i) => `${i} ${leak}`).join("\n"));
  const result = await run(f, `return { snapshot: await model.snapshot(), detail: await model.detail('test'), diagnostics: await model.diagnostics(), redacted: redactUiText(${JSON.stringify(leak)}) };`, { UI_TEST_API_TOKEN: "env-private-value" });
  expect(result.ok).toBe(true);
  const output = JSON.stringify(result.value);
  for (const value of [accessKey, controllerId, "u%40name", "u@name", "p%3Ass", "p%253Ass", "unrelated-private-value", "env-private-value", "unknown-user", "unknown-pass", "query-private-value", "odd-user", "pa'ss", "unknown-bearer-value"])
    expect(output).not.toContain(value);
  const profile = result.value.snapshot.profiles[0];
  expect(profile.network).toMatchObject({ proxyDisplay: "http://proxy.test:8080", proxyConfigured: true, expectedIp: "198.51.100.42" });
  expect(profile.controller).toBeNull();
  expect(profile.engineSha256).toBeNull();
  expect(Object.keys(profile).sort()).toEqual(["id", "port", "mode", "storage", "phase", "instanceId", "exitIp", "checkedAt", "fixedIpVerified", "windowControls", "controller", "supervisorPid", "serverPid", "ownership", "fingerprintSha256", "engineSha256", "error", "controlError", "configurationError", "network"].sort());
  expect(result.value.diagnostics.profiles[0].accessKeyPresent).toBe(true);
  expect(result.value.diagnostics.profiles[0]).not.toHaveProperty("accessKey");
  expect(result.value.detail.device.properties).toContainEqual({ name: "CPU cores", value: "8" });
  expect(result.value.detail.device.properties.find((item: { name: string }) => item.name === "Platform").value).toHaveLength(64);
  expect(result.value.detail.device.properties).toHaveLength(5);
  expect(result.value.detail.logs.server.split("\n")).toHaveLength(120);
  expect(result.value.detail.logs.supervisor.split("\n")).toHaveLength(120);
});

test("detail requests the last 300 lines within the existing 64 KiB log read bound", async () => {
  const f = fixture(), state = join(f.state, "test");
  writeFileSync(join(state, "server.log"), Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n"));
  writeFileSync(join(state, "supervisor.log"), Array.from({ length: 400 }, (_, i) => `line ${i} ${"x".repeat(512)}`).join("\n"));
  const result = await run(f, "return (await model.detail('test')).logs;");
  expect(result.ok).toBe(true);
  expect(result.value.server.split("\n")).toHaveLength(300);
  expect(result.value.server.startsWith("line 100\n")).toBe(true);
  expect(result.value.supervisor.startsWith("line 0 ")).toBe(false);
  expect(result.value.supervisor).toContain("line 399 ");
  expect(Buffer.byteLength(result.value.server)).toBeLessThanOrEqual(65536);
  expect(Buffer.byteLength(result.value.supervisor)).toBeLessThanOrEqual(65536);
});

test("missing and invalid proxy configuration has safe text and a usable revision", async () => {
  for (const proxy of ["", "http://name:private-value@host.test/path?password=private-query"]) {
    const f = fixture([proxyProfile], `UI_TEST_PROXY=${proxy}\n`);
    const result = await run(f, "return { snapshot: await model.snapshot(), diagnostics: await model.diagnostics() };");
    expect(result.ok).toBe(true);
    const profile = result.value.snapshot.profiles[0];
    expect(profile.configurationError).toContain(proxy ? "invalid" : "missing");
    expect(profile.network.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(profile.network.proxyDisplay).toBeNull();
    expect(profile.network.proxyConfigured).toBe(false);
    expect(JSON.stringify(result)).not.toContain("private-value");
    expect(JSON.stringify(result)).not.toContain("private-query");
  }
});

test("network edits create distinct safe environment references without changing IDs or storage", async () => {
  const profiles: Profile[] = [{ id: "test", port: 19471, mode: "direct" }, { id: "other", port: 19472, mode: "direct", storage: "native" }];
  const f = fixture(profiles, "# keep this comment\nSTELZ_TEST_PROXY_URL=unrelated\n");
  const result = await run(f, `
    const before = await model.snapshot();
    const first = await model.updateNetwork('test', { revision: before.profiles[0].network.revision, mode: 'proxy', proxyUrl: 'http://new-user:new-private-password@proxy.test:8080', expectedIp: '2001:db8::1' });
    const secondRevision = (await model.snapshot()).profiles[1].network.revision;
    const second = await model.updateNetwork('other', { revision: secondRevision, mode: 'proxy', proxyUrl: 'socks5://other.test:1080', expectedIp: '198.51.100.7' });
    return { first, second };
  `);
  expect(result.ok).toBe(true);
  const config = JSON.parse(readFileSync(f.config, "utf8")), secrets = parseEnv(readFileSync(f.secrets, "utf8"));
  const refs = config.profiles.flatMap((p: Profile) => [p.proxyEnv, p.expectedIPEnv]);
  expect(new Set(refs).size).toBe(4);
  for (const ref of refs) expect(ref).toMatch(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);
  expect(config.profiles.map((p: Profile) => ({ id: p.id, storage: p.storage }))).toEqual([{ id: "test", storage: undefined }, { id: "other", storage: "native" }]);
  expect(config.maxActive).toBe(2);
  expect(secrets[config.profiles[0].proxyEnv]).toBe("http://new-user:new-private-password@proxy.test:8080");
  expect(secrets[config.profiles[0].expectedIPEnv]).toBe("2001:db8::1");
  expect(secrets.STELZ_TEST_PROXY_URL).toBe("unrelated");
  expect(result.value.first.storage).toBe("checkpoint");
  expect(result.value.second.network.proxyDisplay).toBe("socks5://other.test:1080");
  expect(JSON.stringify(result)).not.toContain("new-private-password");
  expect(lstatSync(f.config).mode & 0o777).toBe(0o600);
  expect(lstatSync(f.secrets).mode & 0o777).toBe(0o600);
});

test("stopped edits preserve unrelated quoted and multiline secrets, comments, and duplicate assignments", async () => {
  const unrelated = `# first comment\r\nexport QUOTED = 'literal # = value' # quoted comment\r\nMULTILINE="first line\r\nUI_TEST_PROXY=do not edit this line\r\nUI_TEST_EXPECTED=do not edit this either\r\nlast line" # multiline comment\r\n`;
  const f = fixture([proxyProfile], `${unrelated}UI_TEST_PROXY = 'http://old:private-old@proxy.test:8080' # first proxy\r\nUI_TEST_PROXY="http://old:private-old@proxy.test:8080" # last proxy\r\nUI_TEST_EXPECTED="198.51.100.42" # expected comment\r\n# last comment\r\n`);
  const result = await run(f, `${withRevision} return await model.updateNetwork('test', { revision, mode: 'proxy', proxyUrl: 'https://next:private-new@other.test:9443', expectedIp: '' });`);
  expect(result.ok).toBe(true);
  const text = readFileSync(f.secrets, "utf8"), secrets = parseEnv(text);
  expect(text.startsWith(unrelated)).toBe(true);
  expect(text).toContain(" # first proxy\r\n");
  expect(text).toContain(" # last proxy\r\n");
  expect(text).toContain(" # expected comment\r\n# last comment\r\n");
  expect(secrets.UI_TEST_PROXY).toBe("https://next:private-new@other.test:9443");
  expect(secrets.UI_TEST_EXPECTED).toBe("");
  expect(secrets.MULTILINE).toBe(parseEnv(unrelated).MULTILINE);
  expect(result.value.network.expectedIp).toBe("");
});

test("omitted network values preserve secrets and direct mode ignores a saved proxy", async () => {
  const text = "UI_TEST_PROXY=http://keep:private-password@proxy.test:8080\nUI_TEST_EXPECTED=198.51.100.42\n# untouched\n";
  const f = fixture([proxyProfile], text);
  const result = await run(f, `${withRevision} return await model.updateNetwork('test', { revision, mode: 'direct' });`);
  expect(result.ok).toBe(true);
  expect(result.value.mode).toBe("direct");
  expect(result.value.network.expectedIp).toBe("198.51.100.42");
  expect(readFileSync(f.secrets, "utf8")).toBe(text);
});

test("public profile IDs and MCP commands stay usable when a proxy username matches the ID", async () => {
  const f = fixture([proxyProfile], "UI_TEST_PROXY=http://test:private-password@proxy.test:8080\n");
  const result = await run(f, "return { snapshot: await model.snapshot(), detail: await model.detail('test'), diagnostics: await model.diagnostics() };");
  expect(result.ok).toBe(true);
  expect(result.value.snapshot.profiles[0].id).toBe("test");
  expect(result.value.detail.profile.id).toBe("test");
  expect(result.value.diagnostics.profiles[0].id).toBe("test");
  expect(result.value.detail.mcpCommand).toBe(`env STELZ_HOME=${f.home} stelz mcp --profile test`);
  expect(JSON.stringify(result)).not.toContain("private-password");
});

test("revisions include config, shadowed file secrets, and effective environment values", async () => {
  const f = fixture([proxyProfile], "UI_TEST_PROXY=http://file:private-file@proxy.test:8080\nUI_TEST_EXPECTED=198.51.100.1\n");
  const result = await run(f, `
    const revisions = [], snapshot = async () => (await model.snapshot()).profiles[0].network;
    revisions.push(await snapshot());
    process.env.UI_TEST_PROXY = 'http://env:private-env@env.test:8080';
    process.env.UI_TEST_EXPECTED = '';
    revisions.push(await snapshot());
    fs.writeFileSync(join(home, 'secrets.env'), 'UI_TEST_PROXY=http://file:private-file-new@proxy.test:8080\\nUI_TEST_EXPECTED=198.51.100.1\\n');
    revisions.push(await snapshot());
    const config = JSON.parse(fs.readFileSync(join(home, 'profiles.json'), 'utf8'));
    config.profiles[0].port++;
    fs.writeFileSync(join(home, 'profiles.json'), JSON.stringify(config));
    revisions.push(await snapshot());
    return revisions;
  `);
  expect(result.ok).toBe(true);
  expect(new Set(result.value.map((network: { revision: string }) => network.revision)).size).toBe(4);
  expect(result.value[1]).toMatchObject({ proxyDisplay: "http://env.test:8080", expectedIp: "", proxyReadOnly: true, expectedIpReadOnly: true });
  expect(JSON.stringify(result)).not.toContain("private-");
});

test("a stale revision returns 409 and cannot overwrite a completed edit", async () => {
  const f = fixture();
  const result = await run(f, `${withRevision}
    await model.updateNetwork('test', { revision, mode: 'direct', expectedIp: '198.51.100.1' });
    return await model.updateNetwork('test', { revision, mode: 'direct', expectedIp: '198.51.100.2' });
  `);
  expect(result).toMatchObject({ ok: false, status: 409, message: expect.stringContaining("Refresh") });
  expect(Object.values(parseEnv(readFileSync(f.secrets, "utf8")))).toContain("198.51.100.1");
  expect(Object.values(parseEnv(readFileSync(f.secrets, "utf8")))).not.toContain("198.51.100.2");
});

test("environment and shared references reject secret writes while honoring process.env priority", async () => {
  const f = fixture([proxyProfile], "UI_TEST_PROXY=http://file:private-file@file.test:8080\nUI_TEST_EXPECTED=198.51.100.1\n");
  const before = [readFileSync(f.config, "utf8"), readFileSync(f.secrets, "utf8")];
  const result = await run(f, `${withRevision}
    const results = [];
    for (const patch of [{ proxyUrl: 'http://new:private-new@new.test:8080' }, { expectedIp: '' }]) {
      try { await model.updateNetwork('test', { revision, mode: 'proxy', ...patch }); results.push('unexpected'); }
      catch (error) { results.push({ status: error.status, message: error.message }); }
    }
    return { results, network: (await model.snapshot()).profiles[0].network };
  `, { UI_TEST_PROXY: "http://environment:private-environment@env.test:8080", UI_TEST_EXPECTED: "2001:db8::2" });
  expect(result.ok).toBe(true);
  expect(result.value.results.map((item: { status: number }) => item.status)).toEqual([409, 409]);
  expect(result.value.network).toMatchObject({ proxyDisplay: "http://env.test:8080", expectedIp: "2001:db8::2", proxyReadOnly: true, expectedIpReadOnly: true });
  expect([readFileSync(f.config, "utf8"), readFileSync(f.secrets, "utf8")]).toEqual(before);
  expect(JSON.stringify(result)).not.toContain("private-");

  const shared = fixture([proxyProfile, { id: "other", port: 19472, mode: "direct", proxyEnv: "UI_TEST_EXPECTED", expectedIPEnv: "UI_TEST_PROXY" }], before[1]);
  const rejection = await run(shared, `${withRevision}
    const results = [];
    for (const patch of [{ proxyUrl: 'http://new.test:8080' }, { expectedIp: '' }]) {
      try { await model.updateNetwork('test', { revision, mode: 'proxy', ...patch }); results.push('unexpected'); }
      catch (error) { results.push(error.status); }
    }
    return { results, network: (await model.snapshot()).profiles[0].network };
  `);
  expect(rejection.ok).toBe(true);
  expect(rejection.value.results).toEqual([409, 409]);
  expect(rejection.value.network).toMatchObject({ proxyReadOnly: true, expectedIpReadOnly: true });
  expect(readFileSync(shared.secrets, "utf8")).toBe(before[1]);
});

test("active, orphaned, unknown ownership, unclean, reserved, and malformed records reject edits", async () => {
  const f = fixture();
  const result = await run(f, `
    const state = join(home, 'profiles/test'), stamp = runtime.processStart(process.pid), dead = 2147483647;
    ${withRevision}
    const base = { version: 2, pid: process.pid, supervisorStart: stamp, serverPid: process.pid, serverStart: stamp, serverState: 'started', instanceId: 'lifetime', configurationHash: 'old', port: 19471 };
    const cases = [
      { ...base }, { ...base, pid: dead, supervisorStart: 'dead' },
      { ...base, supervisorStart: undefined, serverStart: undefined },
      { ...base, pid: dead, supervisorStart: 'dead', serverPid: dead, serverStart: 'dead' },
      { version: 2, pid: 0, instanceId: 'reserved', serverState: 'not-started' }, null,
    ];
    const results = [];
    for (const record of cases) {
      fs.writeFileSync(join(state, 'running.json'), JSON.stringify(record));
      fs.writeFileSync(join(state, 'status.json'), JSON.stringify({ phase: 'stopped' }));
      try { await model.updateNetwork('test', { revision, mode: 'direct' }); results.push('unexpected'); }
      catch (error) { results.push(error.status); }
    }
    fs.writeFileSync(join(state, 'running.json'), JSON.stringify(base));
    fs.writeFileSync(join(state, 'stopped.json'), JSON.stringify({ instanceId: base.instanceId }));
    try { await model.updateNetwork('test', { revision, mode: 'direct' }); results.push('unexpected'); }
    catch (error) { results.push(error.status); }
    fs.writeFileSync(join(state, 'running.json'), JSON.stringify({ ...base, version: 99, pid: dead, serverPid: dead }));
    try { await model.updateNetwork('test', { revision, mode: 'direct' }); results.push('unexpected'); }
    catch (error) { results.push(error.status); }
    return results;
  `);
  expect(result.ok).toBe(true);
  expect(result.value).toEqual(Array(8).fill(409));
  expect(JSON.parse(readFileSync(f.config, "utf8")).profiles).toEqual(f.profiles);
});

test("a verified clean stopped record permits network changes", async () => {
  const f = fixture(), state = join(f.state, "test");
  writeFileSync(join(state, "running.json"), JSON.stringify({ version: 2, pid: 2147483647, serverPid: 2147483646, serverState: "started", instanceId: "clean", configurationHash: "old" }));
  writeFileSync(join(state, "stopped.json"), JSON.stringify({ instanceId: "clean" }));
  const result = await run(f, `${withRevision} return await model.updateNetwork('test', { revision, mode: 'direct', expectedIp: '::1' });`);
  expect(result.ok).toBe(true);
  expect(result.value).toMatchObject({ phase: "stopped", network: { expectedIp: "::1" } });
});

test("strict inputs reject bad proxies, IP addresses, extra fields, and unknown IDs before data writes", async () => {
  const f = fixture(), configBefore = readFileSync(f.config, "utf8"), secretsBefore = readFileSync(f.secrets, "utf8");
  const result = await run(f, `${withRevision}
    const invalid = [
      ...['', 'ftp://host:8080', 'socks4://host:1080', 'socks5://name:private-value@host:1080', 'http://name:private-value@host/path', 'http://host?token=private-query', 'http://host:99999', 'http://name:p%zz@host', 'http:host', 'http://host\\n'].map(proxyUrl => ({ revision, mode: 'proxy', proxyUrl })),
      ...['999.1.1.1', '127.1', '[::1]', '::g', '198.51.100.1\\n', 'fe80::1%en0', 'private-value'].map(expectedIp => ({ revision, mode: 'direct', expectedIp })),
      { revision, mode: 'direct', storage: 'checkpoint' }, { revision, mode: 'direct', id: 'other' },
      { revision, mode: 'other' }, { revision, mode: 'direct', proxyUrl: null }, { revision, mode: 'direct', expectedIp: 4 },
      { revision: {}, mode: 'direct' }, null,
    ];
    const results = [];
    for (const input of invalid) {
      try { await model.updateNetwork('test', input); results.push('unexpected'); }
      catch (error) { results.push({ status: error.status, message: error.message }); }
    }
    for (const id of ['other', '../outside', '/tmp/outside']) {
      try { await model.updateNetwork(id, { revision, mode: 'direct' }); results.push('unexpected'); }
      catch (error) { results.push({ status: error.status, message: error.message }); }
    }
    return results;
  `);
  expect(result.ok).toBe(true);
  expect(result.value.slice(0, -3).every((item: { status: number }) => item.status === 400)).toBe(true);
  expect(result.value.slice(-3).map((item: { status: number }) => item.status)).toEqual([404, 404, 404]);
  expect(JSON.stringify(result)).not.toContain("private-value");
  expect(JSON.stringify(result)).not.toContain("private-query");
  expect(readFileSync(f.config, "utf8")).toBe(configBefore);
  expect(readFileSync(f.secrets, "utf8")).toBe(secretsBefore);
});

test("unsafe environment references cannot be rewritten", async () => {
  const cases = [
    [{ id: "test", port: 19471, mode: "direct", proxyEnv: "BAD\nINJECTED" }],
  ];
  for (const profiles of cases) {
    const f = fixture(profiles as Profile[]), before = readFileSync(f.config, "utf8");
    const result = await run(f, "return await model.updateNetwork('test', { revision: '0'.repeat(64), mode: 'direct' });");
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(readFileSync(f.config, "utf8")).toBe(before);
  }
});

test("a second-file replacement failure rolls back the first file and removes staged files", async () => {
  const f = fixture(), before = [readFileSync(f.config, "utf8"), readFileSync(f.secrets, "utf8")];
  const prelude = `import { mock } from 'bun:test';
const originalFs = { ...fs };
let failed = false;
mock.module('node:fs', () => ({ ...originalFs, renameSync(from, to) {
  if (to === join(process.env.STELZ_HOME, 'secrets.env') && !failed) { failed = true; throw Error('injected-private-error'); }
  return originalFs.renameSync(from, to);
}}));`;
  const result = await run(f, `${withRevision} return await model.updateNetwork('test', { revision, mode: 'proxy', proxyUrl: 'http://private-user:private-password@proxy.test:8080' });`, {}, prelude);
  expect(result).toMatchObject({ ok: false, status: 409, message: expect.stringContaining("restored") });
  expect([readFileSync(f.config, "utf8"), readFileSync(f.secrets, "utf8")]).toEqual(before);
  expect(readdirSync(f.home).filter(name => name.includes(".tmp"))).toEqual([]);
  expect(existsSync(join(f.home, journalName))).toBe(false);
});

test("an interrupted save stays read-only in observations and recovers all network fields before start", async () => {
  const f = networkFixture();
  await interruptedSave(f);
  const before = tree(f.home);
  const observed = await run(f, "return { snapshot: await model.snapshot(), diagnostics: await model.diagnostics() };");
  expect(observed.ok).toBe(true);
  const message = observed.value.snapshot.profiles[0].configurationError;
  expect(message).toContain("Network save is pending");
  expect(message).toContain(`env STELZ_HOME=${f.home} stelz start test`);
  expect(observed.value.diagnostics.profiles[0].configuration).toBe(message);
  for (const value of ["old-password", "recovered-password", "old-user", "recovered-user"]) expect(JSON.stringify(observed)).not.toContain(value);
  expect(tree(f.home)).toEqual(before);
  const started = await run(f, "return await runtime.start('test');");
  expect(started).toMatchObject({ ok: false, message: "Run stelz setup first." });
  expectRecovered(f);
});

test("the next UI save completes an interrupted transaction before checking its revision", async () => {
  const f = networkFixture();
  await interruptedSave(f);
  const saved = await run(f, `${withRevision} return await model.updateNetwork('test', { revision, mode: 'proxy' });`);
  expect(saved).toMatchObject({ ok: false, status: 409, message: expect.stringContaining("Refresh") });
  expectRecovered(f);
  const next = await run(f, `${withRevision} return await model.updateNetwork('test', { revision, mode: 'proxy', expectedIp: '' });`);
  expect(next.ok).toBe(true);
  expect(next.value.network.expectedIp).toBe("");
  expect(parseEnv(readFileSync(f.secrets, "utf8")).UI_TEST_EXPECTED).toBe("");
});

test("an interruption during rollback resumes rollback instead of applying the rejected save", async () => {
  const f = networkFixture();
  await interruptedSave(f, true);
  expect(JSON.parse(readFileSync(join(f.home, journalName), "utf8")).direction).toBe("rollback");
  expect(await run(f, "return await runtime.start('test');")).toMatchObject({ ok: false, message: "Run stelz setup first." });
  expectRecovered(f, false);
});

test("manual edits to either file block recovery, preserve all bytes, and provide a scoped command", async () => {
  for (const target of ["config", "secrets"] as const) {
    const f = networkFixture();
    await interruptedSave(f);
    if (target === "config") {
      const value = JSON.parse(readFileSync(f.config, "utf8"));
      value.manualProperty = "preserve this manual edit";
      writeFileSync(f.config, JSON.stringify(value));
    } else writeFileSync(f.secrets, readFileSync(f.secrets, "utf8") + "# preserve this manual edit\n");
    const journal = join(f.home, journalName), before = [readFileSync(f.config, "utf8"), readFileSync(f.secrets, "utf8"), readFileSync(journal, "utf8")];
    const observed = await run(f, "return { snapshot: await model.snapshot(), diagnostics: await model.diagnostics() };");
    expect(observed.ok).toBe(true);
    expect(observed.value.snapshot.profiles[0].configurationError).toContain("manually changed");
    expect(observed.value.diagnostics.profiles[0].configuration).toContain(`env STELZ_HOME=${f.home} stelz start test`);
    const started = await run(f, "return await runtime.start('test');");
    const saved = await run(f, `${withRevision} return await model.updateNetwork('test', { revision, mode: 'direct' });`);
    for (const result of [started, saved]) {
      expect(result.ok).toBe(false);
      expect(result.status).toBe(409);
      expect(result.message).toContain("manually changed");
      expect(result.message).toContain(`env STELZ_HOME=${f.home} stelz start test`);
      expect(result.message).not.toContain("password");
    }
    expect([readFileSync(f.config, "utf8"), readFileSync(f.secrets, "utf8"), readFileSync(journal, "utf8")]).toEqual(before);
    expect(existsSync(join(f.state, "test/running.json"))).toBe(false);
  }
});

test("invalid journal schemas, unsafe paths, and public journal permissions cannot recover", async () => {
  for (const kind of ["schema", "storage", "symlink", "permissions"] as const) {
    const f = networkFixture();
    await interruptedSave(f);
    const path = join(f.home, journalName), outside = join(f.home, "outside");
    writeFileSync(outside, "untouched");
    if (kind === "schema") {
      const value = JSON.parse(readFileSync(path, "utf8"));
      value.paths = { secrets: outside };
      writeFileSync(path, JSON.stringify(value));
    }
    if (kind === "storage") {
      const value = JSON.parse(readFileSync(path, "utf8")), after = JSON.parse(value.after.config);
      after.profiles[0].storage = "checkpoint";
      value.after.config = JSON.stringify(after);
      writeFileSync(path, JSON.stringify(value));
    }
    if (kind === "symlink") { rmSync(path); symlinkSync(outside, path); }
    if (kind === "permissions") {
      const text = readFileSync(path, "utf8"); rmSync(path); writeFileSync(path, text, { mode: 0o644 });
    }
    const before = [readFileSync(f.config, "utf8"), readFileSync(f.secrets, "utf8")];
    const observed = await run(f, "return await model.snapshot();");
    expect(observed.ok).toBe(true);
    expect(observed.value.profiles[0].configurationError).toContain("recovery requires inspection");
    expect(observed.value.profiles[0].configurationError).toContain(`env STELZ_HOME=${f.home} stelz doctor all`);
    expect(await run(f, "return await runtime.start('test');")).toMatchObject({ ok: false, status: 409 });
    expect([readFileSync(f.config, "utf8"), readFileSync(f.secrets, "utf8")]).toEqual(before);
    expect(readFileSync(outside, "utf8")).toBe("untouched");
  }
});

test("a concurrent start waits for a normal UI commit without inspecting its live journal", async () => {
  const f = networkFixture(), ready = join(f.home, "ready"), release = join(f.home, "release");
  const writer = spawnNetworkSave(f, `
    if (to === configPath) {
      originalFs.writeFileSync(join(home, 'ready'), 'ready');
      const wait = new Int32Array(new SharedArrayBuffer(4)), deadline = Date.now() + 5000;
      while (!originalFs.existsSync(join(home, 'release'))) {
        if (Date.now() > deadline) throw Error('Test gate timed out.');
        Atomics.wait(wait, 0, 0, 10);
      }
    }
  `);
  try {
    const deadline = Date.now() + 3000;
    while (!existsSync(ready)) { if (Date.now() > deadline) throw Error("UI commit did not reach the gate."); await Bun.sleep(5); }
    const prelude = `import { mock } from 'bun:test';
const originalFs = { ...fs };
mock.module('node:fs', () => ({ ...originalFs, openSync(path, ...args) {
  if (path === join(process.env.STELZ_HOME, ${JSON.stringify(journalName)})) {
    const owner = JSON.parse(originalFs.readFileSync(join(process.env.STELZ_HOME, 'profiles/admission.lock'), 'utf8'));
    if (owner.pid !== process.pid) throw Error('Start inspected the journal before admission.');
  }
  return originalFs.openSync(path, ...args);
}}));`;
    let finished = false;
    const start = run(f, "return await runtime.start('test');", {}, prelude).finally(() => { finished = true; });
    await Bun.sleep(100);
    expect(finished).toBe(false);
    writeFileSync(release, "release");
    const [code, stderr] = await Promise.all([writer.exited, new Response(writer.stderr).text(), new Response(writer.stdout).text()]);
    if (code !== 0) throw Error(stderr || `UI save exited ${code}.`);
    expect(await start).toMatchObject({ ok: false, message: "Run stelz setup first." });
    expectRecovered(f);
  } finally { writeFileSync(release, "release"); writer.kill("SIGKILL"); await writer.exited; }
});

test("simultaneous saves serialize and only one can consume a revision", async () => {
  const f = fixture();
  const result = await run(f, `${withRevision}
    const results = await Promise.allSettled([
      model.updateNetwork('test', { revision, mode: 'direct', expectedIp: '198.51.100.1' }),
      model.updateNetwork('test', { revision, mode: 'direct', expectedIp: '198.51.100.2' }),
    ]);
    return results.map(result => result.status === 'fulfilled' ? { saved: result.value.network.expectedIp } : { status: result.reason.status });
  `);
  expect(result.ok).toBe(true);
  expect(result.value.filter((item: { saved?: string }) => item.saved)).toHaveLength(1);
  expect(result.value.filter((item: { status?: number }) => item.status === 409)).toHaveLength(1);
  expect(JSON.parse(readFileSync(f.config, "utf8")).profiles).toHaveLength(1);
});

test("a queued CLI start reads the configuration after a UI edit releases admission", async () => {
  const f = fixture([proxyProfile]);
  const result = await run(f, `${withRevision}
    let entered, release;
    const ready = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const held = runtime.lock(join(home, 'profiles/test/lifecycle.lock'), async () => { entered(); await gate; });
    await ready;
    const edit = model.updateNetwork('test', { revision, mode: 'direct' });
    const admission = join(home, 'profiles/admission.lock'), deadline = Date.now() + 3000;
    while (!fs.existsSync(admission)) {
      if (Date.now() > deadline) throw Error('UI edit did not obtain admission.');
      await Bun.sleep(5);
    }
    let done = false;
    const start = runtime.start('test').then(() => ({ unexpected: true }), error => ({ message: error.message })).finally(() => { done = true; });
    await Bun.sleep(100);
    const waited = !done;
    release();
    await held;
    const saved = await edit, started = await start;
    return { waited, saved: saved.mode, started, running: fs.existsSync(join(home, 'profiles/test/running.json')) };
  `);
  expect(result.ok).toBe(true);
  expect(result.value).toEqual({ waited: true, saved: "direct", started: { message: "Run stelz setup first." }, running: false });
});

test("network saves reject symlinks instead of writing outside the service directory", async () => {
  for (const kind of ["secrets", "profile", "lock"] as const) {
    const f = fixture(), outside = join(f.home, "outside");
    writeFileSync(outside, "untouched");
    if (kind === "secrets") { rmSync(f.secrets); symlinkSync(outside, f.secrets); }
    if (kind === "profile") { rmSync(join(f.state, "test"), { recursive: true }); symlinkSync(f.home, join(f.state, "test")); }
    if (kind === "lock") symlinkSync(outside, join(f.state, "admission.lock"));
    const result = await run(f, `return await model.updateNetwork('test', { revision: '0'.repeat(64), mode: 'direct' });`);
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(readFileSync(outside, "utf8")).toBe("untouched");
  }
});

test("MCP commands quote STELZ_HOME and select the same service directory", async () => {
  const f = fixture(), original = f.home;
  const quotedHome = join(original, "service's $(literal) directory");
  mkdirSync(quotedHome);
  mkdirSync(join(quotedHome, "profiles/test"), { recursive: true });
  writeFileSync(join(quotedHome, "profiles.json"), readFileSync(f.config));
  const result = await run({ ...f, home: quotedHome }, "return (await model.detail('test')).mcpCommand;");
  expect(result.ok).toBe(true);
  expect(result.value).toBe(`env STELZ_HOME='${quotedHome.replaceAll("'", "'\\''")}' stelz mcp --profile test`);
  expect(existsSync(join(original, "literal"))).toBe(false);
});

test("network edits reject corrupt status before changing either service file", async () => {
  const f = fixture();
  const before = [readFileSync(f.config, "utf8"), readFileSync(f.secrets, "utf8")];
  const result = await run(f, `${withRevision}
    fs.writeFileSync(join(home, "profiles/test/status.json"), "{broken", { mode: 0o600 });
    return await model.updateNetwork('test', {
    revision, mode: 'proxy', proxyUrl: 'http://private-user:private-password@proxy.test:8080'
  });`);
  expect(result).toMatchObject({ ok: false, status: 409 });
  expect(JSON.stringify(result)).not.toMatch(/private-user|private-password/);
  expect([readFileSync(f.config, "utf8"), readFileSync(f.secrets, "utf8")]).toEqual(before);
  expect(existsSync(join(f.home, journalName))).toBe(false);
});

test("network edit responses use the validated observation when status changes after commit", async () => {
  const f = fixture();
  const prelude = `import { mock } from 'bun:test';
const originalFs = { ...fs };
mock.module('node:fs', () => ({ ...originalFs, unlinkSync(path) {
  originalFs.unlinkSync(path);
  if (path === join(process.env.STELZ_HOME, ${JSON.stringify(journalName)}))
    originalFs.writeFileSync(join(process.env.STELZ_HOME, 'profiles/test/status.json'), '{broken');
}}));`;
  const result = await run(f, `${withRevision} return await model.updateNetwork('test', {
    revision, mode: 'proxy', proxyUrl: 'http://private-user:private-password@proxy.test:8080'
  });`, {}, prelude);
  expect(result).toMatchObject({ ok: true, value: { mode: "proxy", phase: "stopped", network: { proxyDisplay: "http://proxy.test:8080" } } });
  expect(JSON.stringify(result)).not.toMatch(/private-user|private-password/);
  expect(JSON.parse(readFileSync(f.config, "utf8")).profiles[0].mode).toBe("proxy");
  expect(readFileSync(join(f.state, "test/status.json"), "utf8")).toBe("{broken");
  expect(existsSync(join(f.home, journalName))).toBe(false);
});
