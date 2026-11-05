import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";

const root = resolve(import.meta.dir, "../.."), homes: string[] = [];
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "stelz-configuration-"));
  homes.push(home);
  mkdirSync(join(home, "profiles/test"), { recursive: true });
  writeFileSync(join(home, "profiles.json"), JSON.stringify({ maxActive: 2, profiles: [
    { id: "test", port: 19471, mode: "direct", storage: "native", proxyEnv: "DOMAIN_PROXY", expectedIPEnv: "DOMAIN_IP" },
  ] }), { mode: 0o600 });
  writeFileSync(join(home, "secrets.env"), "# preserve\nDOMAIN_PROXY=http://old.test:8080 # proxy\nDOMAIN_PROXY=http://old.test:8080\nDOMAIN_IP=198.51.100.1\nOTHER='line one\nline two'\n", { mode: 0o600 });
  return home;
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
async function run(home: string, body: string, prelude = "", expectedCode = 0) {
  const script = `import * as fs from 'node:fs';
import { join } from 'node:path';
${prelude}
const domain = await import(${JSON.stringify(join(root, "packages/stelz/src/profiles/profile-configuration.ts"))});
const { settings } = await import(${JSON.stringify(join(root, "packages/stelz/src/profiles/config.ts"))});
const home = process.env.STELZ_HOME;
const revision = () => { const config = settings(); return domain.networkRevision(config, config.profiles[0], { values: readValues() }); };
const typingRevision = () => domain.typingRevision(settings().profiles[0]);
function readValues() { return parseEnv(fs.readFileSync(join(home, 'secrets.env'), 'utf8')); }
const { parseEnv } = await import('node:util');
try { console.log(JSON.stringify({ ok: true, value: await (async () => { ${body} })() })); }
catch (error) { console.log(JSON.stringify({ ok: false, status: error.status, message: error.message })); }`;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
    cwd: root, env: { ...process.env, STELZ_HOME: home, CAMOUFOX_EXECUTABLE: join(home, "no-browser"), DOMAIN_PROXY: undefined, DOMAIN_IP: undefined },
    stdout: "pipe", stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, err || out).toBe(expectedCode);
  return out.trim() ? JSON.parse(out) : null;
}

test("domain operations create, edit, and archive profiles without a UI model", async () => {
  const home = fixture();
  const result = await run(home, `
    await domain.createProfile({ id: 'second', revision: domain.catalogRevision(settings()) });
    const saved = await domain.updateNetwork('test', { revision: revision(), mode: 'proxy', proxyUrl: 'http://new.test:8080', expectedIp: '' });
    fs.writeFileSync(join(home, 'profiles/test/profile-data'), 'complete profile');
    await domain.deleteProfile('test', domain.catalogRevision(settings()));
    return { mode: saved.profile.mode, ids: settings().profiles.map(p => p.id), trash: fs.readdirSync(join(home, 'trash')) };
  `);
  expect(result.ok).toBe(true);
  expect(result.value).toMatchObject({ mode: "proxy", ids: ["second"] });
  expect(result.value.trash).toHaveLength(1);
  expect(readFileSync(join(home, "trash", result.value.trash[0], "profile/profile-data"), "utf8")).toBe("complete profile");
  const secrets = readFileSync(join(home, "secrets.env"), "utf8");
  expect(secrets).toContain("# preserve\nDOMAIN_PROXY=http://new.test:8080 # proxy\nDOMAIN_PROXY=http://new.test:8080\n");
  expect(secrets).toContain("OTHER='line one\nline two'\n");
  expect(parseEnv(secrets).DOMAIN_IP).toBe("");
  expect(parseEnv(secrets).DOMAIN_PROXY).toBe("http://new.test:8080");
});

test("typing defaults save live without changing launch state, secrets, or profile data", async () => {
  const home = fixture();
  const secrets = readFileSync(join(home, "secrets.env"), "utf8");
  const record = '{"phase":"ready","controller":"existing-controller"}';
  writeFileSync(join(home, "profiles/test/running.json"), record);
  writeFileSync(join(home, "profiles/test/profile-data"), "existing browser data");
  const result = await run(home, `
    const { configurationHash } = await import(${JSON.stringify(join(root, "packages/stelz/src/profiles/config.ts"))});
    const before = settings().profiles[0], hash = configurationHash(before);
    const stale = typingRevision();
    for (const mode of ['keyboard', 'instant', 'auto']) {
      await domain.updateTyping('test', { revision: typingRevision(), mode });
      if (settings().profiles[0].typingMode !== mode) throw Error('Typing preference was not persisted');
      if (configurationHash(settings().profiles[0]) !== hash) throw Error('Typing changed launch state');
    }
    let conflict = false;
    try { await domain.updateTyping('test', { revision: stale, mode: 'keyboard' }); } catch (error) { conflict = error.status === 409; }
    return { before, after: settings().profiles[0], conflict };
  `);
  expect(result.ok).toBe(true);
  expect(result.value.conflict).toBe(true);
  expect(result.value.after).toEqual({ ...result.value.before, typingMode: "auto" });
  expect(readFileSync(join(home, "secrets.env"), "utf8")).toBe(secrets);
  expect(readFileSync(join(home, "profiles/test/running.json"), "utf8")).toBe(record);
  expect(readFileSync(join(home, "profiles/test/profile-data"), "utf8")).toBe("existing browser data");
});

test("typing updates reject invalid modes, extra fields, and malformed revisions", async () => {
  const home = fixture();
  const config = readFileSync(join(home, "profiles.json"), "utf8");
  for (const input of [{ mode: "paced" }, { mode: "auto", other: true }, {}, { mode: "inherit" }, { mode: "keyboard", revision: "invalid" }]) {
    const result = await run(home, `await domain.updateTyping('test', { revision: typingRevision(), ...${JSON.stringify(input)} });`);
    expect(result.ok).toBe(false); expect(result.status).toBe(400);
  }
  expect(readFileSync(join(home, "profiles.json"), "utf8")).toBe(config);
});

test("concurrent network and typing edits merge while competing typing edits conflict", async () => {
  const home = fixture();
  const result = await run(home, `
    const networkBefore = revision(), typingBefore = typingRevision();
    await Promise.all([
      domain.updateTyping('test', { revision: typingBefore, mode: 'keyboard' }),
      domain.updateNetwork('test', { revision: networkBefore, mode: 'proxy', proxyUrl: 'http://merged.test:8080' }),
    ]);
    const merged = settings().profiles[0];
    const current = typingRevision();
    const competing = await Promise.allSettled(['instant', 'auto'].map(mode => domain.updateTyping('test', { revision: current, mode })));
    const networkAfter = revision();
    await domain.updateTyping('test', { revision: typingRevision(), mode: null });
    return { merged, competing: competing.map(result => result.status === 'fulfilled' ? 200 : result.reason.status),
      inherited: settings().profiles[0], networkUnchanged: networkAfter === revision() };
  `);
  expect(result.ok).toBe(true);
  expect(result.value.merged).toMatchObject({ mode: "proxy", typingMode: "keyboard" });
  expect(result.value.competing.sort()).toEqual([200, 409]);
  expect(result.value.inherited).not.toHaveProperty("typingMode");
  expect(result.value.networkUnchanged).toBe(true);
  expect(parseEnv(readFileSync(join(home, "secrets.env"), "utf8")).DOMAIN_PROXY).toBe("http://merged.test:8080");
});

test("a stale domain revision cannot overwrite a completed edit", async () => {
  const home = fixture();
  const result = await run(home, `
    const old = revision();
    await domain.updateNetwork('test', { revision: old, mode: 'proxy' });
    await domain.updateNetwork('test', { revision: old, mode: 'direct', proxyUrl: 'http://rejected.test:8080' });
  `);
  expect(result).toMatchObject({ ok: false, status: 409, message: expect.stringContaining("Refresh") });
  expect(JSON.parse(readFileSync(join(home, "profiles.json"), "utf8")).profiles[0].mode).toBe("proxy");
  expect(parseEnv(readFileSync(join(home, "secrets.env"), "utf8")).DOMAIN_PROXY).toBe("http://old.test:8080");
});

test("domain recovery rejects a reservation, then completes before revision validation", async () => {
  const home = fixture();
  const initial = await run(home, "return revision();");
  const prelude = `import { mock } from 'bun:test';
const original = { ...fs };
mock.module('node:fs', () => ({ ...original, renameSync(from, to) {
  if (to === join(process.env.STELZ_HOME, 'secrets.env')) process.exit(79);
  return original.renameSync(from, to);
}}));`;
  await run(home, `await domain.updateNetwork('test', { revision: revision(), mode: 'proxy', proxyUrl: 'http://recovered.test:8080' });`, prelude, 79);
  const journal = join(home, ".network-transaction.json"), record = join(home, "profiles/test/running.json");
  expect(existsSync(journal)).toBe(true);
  writeFileSync(record, JSON.stringify({ version: 2, pid: 0, instanceId: "reserved", configurationHash: "test", serverState: "not-started" }));
  const before = [readFileSync(journal, "utf8"), readFileSync(join(home, "secrets.env"), "utf8")];
  const blocked = await run(home, `await domain.updateNetwork('test', { revision: revision(), mode: 'direct' });`);
  expect(blocked).toMatchObject({ ok: false, status: 409, message: expect.stringContaining("Stop the journal profile cleanly") });
  expect([readFileSync(journal, "utf8"), readFileSync(join(home, "secrets.env"), "utf8")]).toEqual(before);
  rmSync(record);
  const recovered = await run(home, `await domain.updateNetwork('test', { revision: ${JSON.stringify(initial.value)}, mode: 'direct' });`);
  expect(recovered).toMatchObject({ ok: false, status: 409, message: expect.stringContaining("Refresh") });
  expect(existsSync(journal)).toBe(false);
  expect(parseEnv(readFileSync(join(home, "secrets.env"), "utf8")).DOMAIN_PROXY).toBe("http://recovered.test:8080");
  expect(JSON.parse(readFileSync(join(home, "profiles.json"), "utf8")).profiles[0].mode).toBe("proxy");
});
