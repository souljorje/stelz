import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";

const root = resolve(import.meta.dir, ".."), homes: string[] = [];
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
const domain = await import(${JSON.stringify(join(root, "src/profile-configuration.ts"))});
const { settings } = await import(${JSON.stringify(join(root, "src/config.ts"))});
const home = process.env.STELZ_HOME;
const revision = () => { const config = settings(); return domain.networkRevision(config, config.profiles[0], { values: readValues() }); };
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
