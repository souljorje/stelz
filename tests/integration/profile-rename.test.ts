import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";

const root = resolve(import.meta.dir, "../.."), homes: string[] = [];
function fixture(legacy = false) {
  const home = mkdtempSync(join(tmpdir(), "stelz-rename-")), id = "identity-01";
  homes.push(home);
  const state = join(home, legacy ? "identities" : "profiles"), config = join(home, legacy ? "identities.json" : "profiles.json");
  mkdirSync(join(state, id), { recursive: true });
  writeFileSync(config, JSON.stringify({ maxActive: 2, note: "keep catalog metadata", [legacy ? "identities" : "profiles"]: [
    { id, port: 19471, mode: "direct", proxyEnv: "RENAME_PROXY", expectedIPEnv: "RENAME_IP", typingMode: "keyboard" },
  ] }), { mode: 0o600 });
  writeFileSync(join(home, "secrets.env"), "# keep credentials\nRENAME_PROXY=http://rename-user:rename-password@proxy.test:8080\nRENAME_IP=198.51.100.1\n", { mode: 0o600 });
  return { home, id, state, config };
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

async function run(f: ReturnType<typeof fixture>, body: string, prelude = "", expectedCode = 0) {
  const script = `import * as fs from 'node:fs';
import { join } from 'node:path';
${prelude}
const domain = await import(${JSON.stringify(join(root, "packages/stelz/src/profiles/profile-configuration.ts"))});
const config = await import(${JSON.stringify(join(root, "packages/stelz/src/profiles/config.ts"))});
const home = process.env.STELZ_HOME, id = ${JSON.stringify(f.id)};
const revision = () => domain.catalogRevision(config.settings());
try { console.log(JSON.stringify({ ok: true, value: await (async () => { ${body} })() })); }
catch (error) { console.log(JSON.stringify({ ok: false, status: error.status, message: error.message })); }`;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
    cwd: root, env: { ...process.env, STELZ_HOME: f.home, CAMOUFOX_EXECUTABLE: join(f.home, "no-browser"),
      RENAME_PROXY: undefined, RENAME_IP: undefined, STELZ_TYPING_MODE: "auto", STELZ_IP_CHECK_INTERVAL_MS: "120000" },
    stdout: "pipe", stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, err || out).toBe(expectedCode);
  return out.trim() ? JSON.parse(out) : null;
}

for (const legacy of [false, true]) test(`rename preserves ${legacy ? "legacy identities" : "profile"} catalogs and saved browser data`, async () => {
  const f = fixture(legacy), directory = join(f.state, f.id), inode = lstatSync(directory).ino;
  const secrets = readFileSync(join(f.home, "secrets.env"), "utf8");
  writeFileSync(join(directory, "browser-data"), "existing browser data");
  const result = await run(f, `
    const before = config.settings().profiles[0], hash = config.configurationHash(before), oldRevision = revision();
    const stamp = 'existing-process-start';
    const record = { version: 2, pid: process.pid, serverPid: process.pid, supervisorStart: stamp, serverStart: stamp,
      instanceId: 'existing-browser', configurationHash: hash, port: before.port, serverState: 'started' };
    fs.writeFileSync(join(config.dir(id), 'running.json'), JSON.stringify(record));
    fs.writeFileSync(join(config.dir(id), 'status.json'), JSON.stringify({ profileId: id, phase: 'ready', controller: { id: 'existing-controller' } }));
    const lifetime = fs.readFileSync(join(config.dir(id), 'running.json'), 'utf8');
    const state = fs.readFileSync(join(config.dir(id), 'status.json'), 'utf8');
    const saved = await domain.renameProfile(id, { revision: oldRevision, name: '  Рабочий профиль  ' });
    const after = config.settings().profiles[0];
    const { createHash } = await import('node:crypto');
    const legacyHash = createHash('sha256').update('{"id":"identity-01","port":19471,"mode":"direct","proxyEnv":"RENAME_PROXY","expectedIPEnv":"RENAME_IP","proxy":{},"expectedIP":"198.51.100.1"}').digest('hex');
    return { before, after, saved: saved.profile, changedRevision: oldRevision !== revision(), hash,
      legacyHash, afterHash: config.configurationHash(after),
      typingHash: config.configurationHash({ ...after, typingMode: 'instant' }),
      lifetimeUnchanged: lifetime === fs.readFileSync(join(config.dir(id), 'running.json'), 'utf8'),
      statusUnchanged: state === fs.readFileSync(join(config.dir(id), 'status.json'), 'utf8') };
  `);
  expect(result.ok).toBe(true);
  const { before, after, saved, hash, legacyHash, afterHash, typingHash } = result.value;
  expect(after).toEqual({ ...before, name: "Рабочий профиль" });
  expect(saved).toEqual(after);
  expect(hash).toBe(legacyHash);
  expect(afterHash).toBe(hash);
  expect(typingHash).toBe(hash);
  expect(result.value).toMatchObject({ changedRevision: true, lifetimeUnchanged: true, statusUnchanged: true });
  expect(lstatSync(directory).ino).toBe(inode);
  expect(readFileSync(join(directory, "browser-data"), "utf8")).toBe("existing browser data");
  expect(readFileSync(join(f.home, "secrets.env"), "utf8")).toBe(secrets);
  const persisted = JSON.parse(readFileSync(f.config, "utf8"));
  expect(persisted).toMatchObject({ maxActive: 2, note: "keep catalog metadata" });
  expect(persisted[legacy ? "identities" : "profiles"][0]).toEqual(after);
  expect(persisted).not.toHaveProperty(legacy ? "profiles" : "identities");
  expect(existsSync(join(f.home, legacy ? "profiles" : "identities"))).toBe(false);
});

test("rename accepts the length boundary and removes the override when the name equals the stable ID", async () => {
  const f = fixture();
  const result = await run(f, `
    await domain.renameProfile(id, { revision: revision(), name: ' '.repeat(4) + 'a'.repeat(80) + ' ' });
    const named = config.settings().profiles[0];
    await domain.renameProfile(id, { revision: revision(), name: ' ' + id + ' ' });
    return { named, cleared: config.settings().profiles[0] };
  `);
  expect(result.ok).toBe(true);
  expect(result.value.named.name).toBe("a".repeat(80));
  expect(result.value.cleared.id).toBe(f.id);
  expect(result.value.cleared).not.toHaveProperty("name");
});

test("invalid names, payloads, and revisions leave the catalog unchanged", async () => {
  const f = fixture(), before = readFileSync(f.config, "utf8");
  const invalidNames = [undefined, null, 1, {}, "", " ", "a".repeat(81), "\nname", "name\t", "a\0b", "a\x7fb", "a\x85b",
    ...["\u061c", "\u200e", "\u200f", "\u202a", "\u202e", "\u2066", "\u2069", "\u206a", "\u206f", "\u2028", "\u2029"].map(character => `a${character}b`)];
  const result = await run(f, `
    const inputs = ${JSON.stringify(invalidNames)}.map(name => ({ revision: revision(), name }));
    inputs.push(null, [], 'name', 42, {}, { revision: 'invalid', name: 'Good' }, { revision: revision(), name: 'Good', id: 'other' });
    const statuses = [];
    for (const input of inputs) {
      try { await domain.renameProfile(id, input); statuses.push(200); }
      catch (error) { statuses.push(error.status); }
    }
    return statuses;
  `);
  expect(result.ok).toBe(true);
  expect(result.value).toHaveLength(invalidNames.length + 7);
  expect(result.value.every((status: number) => status === 400)).toBe(true);
  expect(readFileSync(f.config, "utf8")).toBe(before);
  const missing = await run(f, "await domain.renameProfile('missing', { revision: revision(), name: 'Good' });");
  expect(missing).toMatchObject({ ok: false, status: 404 });
});

test("catalog validation rejects invalid stored names", async () => {
  const f = fixture();
  const result = await run(f, `
    const before = config.settings();
    const statuses = ${JSON.stringify([null, 1, "", " name ", "a".repeat(81), "a\x85b", "a\u061cb", "a\u202eb", "a\u2067b"])}.map(name => {
      try { config.validateSettings({ profiles: [{ ...before.profiles[0], name }] }); return false; }
      catch { return true; }
    });
    return { statuses, valid: config.validateSettings({ profiles: [{ ...before.profiles[0], name: 'Work & personal' }] }).profiles[0].name };
  `);
  expect(result.ok).toBe(true);
  expect(result.value.statuses.every(Boolean)).toBe(true);
  expect(result.value.valid).toBe("Work & personal");
});

test("catalog revisions reject competing renames and edits without losing unrelated settings", async () => {
  const f = fixture();
  const result = await run(f, `
    const initial = revision();
    const competing = await Promise.allSettled(['Work', 'Personal'].map(name => domain.renameProfile(id, { revision: initial, name })));
    const winner = config.settings().profiles[0].name, stale = revision();
    await domain.updateTyping(id, { revision: domain.typingRevision(config.settings().profiles[0]), mode: 'instant' });
    let conflict;
    try { await domain.renameProfile(id, { revision: stale, name: 'Rejected' }); } catch (error) { conflict = error.status; }
    await domain.renameProfile(id, { revision: revision(), name: 'Merged' });
    return { competing: competing.map(result => result.status === 'fulfilled' ? 200 : result.reason.status), winner, conflict, after: config.settings().profiles[0] };
  `);
  expect(result.ok).toBe(true);
  expect(result.value.competing.sort()).toEqual([200, 409]);
  expect(["Work", "Personal"]).toContain(result.value.winner);
  expect(result.value.conflict).toBe(409);
  expect(result.value.after).toMatchObject({ id: f.id, name: "Merged", typingMode: "instant", mode: "direct", port: 19471,
    proxyEnv: "RENAME_PROXY", expectedIPEnv: "RENAME_IP" });
});

test("a network draft captured before rename preserves the latest display name", async () => {
  const f = fixture();
  const result = await run(f, `
    const before = config.settings(), p = before.profiles[0];
    const secrets = { values: { RENAME_PROXY: 'http://rename-user:rename-password@proxy.test:8080', RENAME_IP: '198.51.100.1' } };
    const draft = { revision: domain.networkRevision(before, p, secrets), proxyUrl: 'http://draft.test:8080' };
    const named = await domain.renameProfile(id, { revision: revision(), name: 'New display name' });
    const currentRevision = domain.networkRevision(named.config, named.profile, named.secrets);
    await domain.updateNetwork(id, draft);
    return { originalRevision: draft.revision, currentRevision, after: config.settings().profiles[0] };
  `);
  expect(result.ok).toBe(true);
  expect(result.value.currentRevision).toBe(result.value.originalRevision);
  expect(result.value.after).toMatchObject({ id: f.id, name: "New display name", typingMode: "keyboard", port: 19471,
    proxyEnv: "RENAME_PROXY", expectedIPEnv: "RENAME_IP" });
  expect(parseEnv(readFileSync(join(f.home, "secrets.env"), "utf8")).RENAME_PROXY).toBe("http://draft.test:8080");
});

test("rename recovers pending network changes before checking the catalog revision", async () => {
  const f = fixture(), initial = await run(f, "return revision();");
  const prelude = `import { mock } from 'bun:test';
const original = { ...fs };
mock.module('node:fs', () => ({ ...original, renameSync(from, to) {
  if (to === join(process.env.STELZ_HOME, 'secrets.env')) process.exit(79);
  return original.renameSync(from, to);
} }));`;
  await run(f, `const current = config.settings(), p = current.profiles[0];
    await domain.updateNetwork(id, { revision: domain.networkRevision(current, p, { values: { RENAME_PROXY: 'http://rename-user:rename-password@proxy.test:8080', RENAME_IP: '198.51.100.1' } }),
      proxyUrl: 'http://recovered.test:8080' });`, prelude, 79);
  const journal = join(f.home, ".network-transaction.json"), record = join(f.state, f.id, "running.json");
  expect(existsSync(journal)).toBe(true);
  writeFileSync(record, JSON.stringify({ version: 2, pid: 0, serverState: "not-started", instanceId: "reserved" }));
  const rename = `await domain.renameProfile(id, { revision: ${JSON.stringify(initial.value)}, name: 'Recovered' });`;
  const blocked = await run(f, rename);
  expect(blocked).toMatchObject({ ok: false, status: 409, message: expect.stringContaining("Stop the journal profile cleanly") });
  expect(existsSync(journal)).toBe(true);
  rmSync(record);
  const stale = await run(f, rename);
  expect(stale).toMatchObject({ ok: false, status: 409, message: expect.stringContaining("Refresh") });
  expect(existsSync(journal)).toBe(false);
  expect(parseEnv(readFileSync(join(f.home, "secrets.env"), "utf8")).RENAME_PROXY).toBe("http://recovered.test:8080");
  const saved = await run(f, "await domain.renameProfile(id, { revision: revision(), name: 'Recovered' }); return config.settings().profiles[0];");
  expect(saved).toMatchObject({ ok: true, value: { id: f.id, name: "Recovered", proxyEnv: "RENAME_PROXY" } });
});

test("an interrupted atomic rename leaves the previous catalog readable and permits retry", async () => {
  const f = fixture(), before = readFileSync(f.config, "utf8");
  const prelude = `import { mock } from 'bun:test';
const original = { ...fs };
mock.module('node:fs', () => ({ ...original, renameSync(from, to) {
  if (to === join(process.env.STELZ_HOME, 'profiles.json')) process.exit(79);
  return original.renameSync(from, to);
} }));`;
  const body = "await domain.renameProfile(id, { revision: revision(), name: 'Retried' }); return config.settings().profiles[0];";
  await run(f, body, prelude, 79);
  expect(readFileSync(f.config, "utf8")).toBe(before);
  expect(await run(f, body)).toMatchObject({ ok: true, value: { id: f.id, name: "Retried" } });
});

test("rename refuses unsafe catalog files", async () => {
  const f = fixture(), original = readFileSync(f.config, "utf8"), target = join(f.home, "catalog-target.json");
  writeFileSync(target, original);
  rmSync(f.config);
  symlinkSync(target, f.config);
  const result = await run(f, "await domain.renameProfile(id, { revision: 'a'.repeat(64), name: 'Unsafe' });");
  expect(result).toMatchObject({ ok: false, status: 409 });
  expect(readFileSync(target, "utf8")).toBe(original);
});
