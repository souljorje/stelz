import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const root = resolve(import.meta.dir, "../.."), homes: string[] = [], MiB = 1024 * 1024;
function fixture(legacy = false) {
  const home = mkdtempSync(join(tmpdir(), "stelz-large-catalog-")); homes.push(home);
  const key = legacy ? "identities" : "profiles", config = join(home, `${key}.json`), state = join(home, key);
  const profiles = Array.from({ length: 1001 }, (_, index) => ({ id: `large-${index}`, port: 20000 + index,
    mode: "direct", storage: "native", ...(index === 0 ? { proxyEnv: "LARGE_PROXY" } : {}) }));
  const value = { maxActive: 1, metadata: "preserve".repeat(MiB / 8 + 1), [key]: profiles };
  const encode = (catalog: typeof value) => JSON.stringify(catalog, null, 2) + "\n";
  mkdirSync(join(state, "large-0"), { recursive: true });
  writeFileSync(config, encode(value), { mode: 0o600 });
  writeFileSync(join(home, "secrets.env"), "# keep\nLARGE_PROXY=http://old.test:8080\n", { mode: 0o600 });
  expect(Buffer.byteLength(readFileSync(config))).toBeGreaterThan(MiB);
  return { home, key, config, state, profiles, value, encode };
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
async function run(home: string, body: string, prelude = "") {
  const script = `import * as fs from 'node:fs'; import { join } from 'node:path'; import { parseEnv } from 'node:util';
${prelude}
const domain = await import(${JSON.stringify(join(root, "packages/stelz/src/profiles/profile-configuration.ts"))});
const config = await import(${JSON.stringify(join(root, "packages/stelz/src/profiles/config.ts"))});
const home = process.env.STELZ_HOME;
const revision = () => { const value = config.settings(); return domain.networkRevision(value, value.profiles[0], { values: parseEnv(fs.readFileSync(join(home, 'secrets.env'), 'utf8')) }); };
try { console.log(JSON.stringify({ ok: true, value: await (async () => { ${body} })() })); }
catch (error) { console.log(JSON.stringify({ ok: false, status: error.status, message: error.message })); }`;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
    cwd: root, env: { ...process.env, STELZ_HOME: home, LARGE_PROXY: undefined }, stdout: "pipe", stderr: "pipe",
  });
  const [code, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, error || out).toBe(0);
  return JSON.parse(out);
}

for (const legacy of [false, true]) test(`large ${legacy ? "legacy" : "canonical"} catalogs support create, network edits, and archived deletion`, async () => {
  const f = fixture(legacy);
  writeFileSync(join(f.state, "large-0/saved-data"), "keep this session");
  const result = await run(f.home, `
    await domain.createProfile({ id: 'added', revision: domain.catalogRevision(config.settings()) });
    const createdCount = config.settings().profiles.length;
    const updated = await domain.updateNetwork('large-0', { revision: revision(), proxyUrl: 'http://new.test:8080' });
    await domain.deleteProfile('large-0', domain.catalogRevision(config.settings()));
    return { createdCount, hasMode: Object.hasOwn(updated.profile, 'mode'), count: config.settings().profiles.length };
  `);
  expect(result).toEqual({ ok: true, value: { createdCount: 1002, hasMode: false, count: 1001 } });
  const saved = JSON.parse(readFileSync(f.config, "utf8"));
  expect(saved.maxActive).toBe(1); expect(saved.metadata).toBe(f.value.metadata);
  expect(saved[f.key].some((p: { id: string }) => p.id === "added")).toBe(true);
  expect(saved).not.toHaveProperty(legacy ? "profiles" : "identities");
  const archive = readdirSync(join(f.home, "trash"))[0]!;
  expect(readFileSync(join(f.home, "trash", archive, "profile/saved-data"), "utf8")).toBe("keep this session");
  expect(readFileSync(join(f.home, "secrets.env"), "utf8")).toContain("# keep\nLARGE_PROXY=http://new.test:8080");
}, 30000);

test("an interrupted catalog save recovers a journal larger than its former byte ceiling", async () => {
  const f = fixture(true), secrets = readFileSync(join(f.home, "secrets.env"), "utf8");
  const padding = " ".repeat(8 * MiB);
  const before = { config: padding + f.encode(f.value), secrets };
  const after = { config: padding + f.encode({ ...f.value, [f.key]: [...f.profiles,
    { id: "recovered", port: 32000, mode: "direct", storage: "native" }] }), secrets };
  writeFileSync(f.config, before.config);
  const journal = join(f.home, ".identity-transaction.json");
  const pending = JSON.stringify({ version: 1, operation: "create", id: "recovered", token: randomUUID(), before, after });
  expect(Buffer.byteLength(pending)).toBeGreaterThan(12 * MiB);
  writeFileSync(journal, pending, { mode: 0o600 });
  expect(await run(f.home, "await domain.prepareProfileConfiguration(async () => {}); return config.settings().profiles.length;")).toEqual({ ok: true, value: 1002 });
  expect(readFileSync(f.config, "utf8")).toBe(after.config);
  expect(existsSync(journal)).toBe(false);
}, 30000);

for (const legacy of [false, true]) test(`interrupted deletion recovers an oversized ${legacy ? "legacy" : "canonical"} journal after archiving profile data`, async () => {
  const f = fixture(legacy), secretFile = join(f.home, "secrets.env");
  f.profiles.push({ id: "large-1001", port: 21001, mode: "direct", storage: "native" });
  f.value.metadata = "preserve".repeat(MiB);
  const before = f.encode(f.value), secrets = readFileSync(secretFile, "utf8");
  writeFileSync(f.config, before);
  writeFileSync(join(f.state, "large-0/saved-data"), "keep this session");
  const prelude = `import { mock } from 'bun:test'; const original = { ...fs };
mock.module('node:fs', () => ({ ...original, renameSync(from, to) {
  const result = original.renameSync(from, to);
  if (to.endsWith('/profile')) throw Error('injected interruption after archive');
  return result;
}}));`;
  expect(await run(f.home, "await domain.deleteProfile('large-0', domain.catalogRevision(config.settings()));", prelude))
    .toMatchObject({ ok: false, status: 409, message: expect.stringContaining("pending") });
  const journal = join(f.home, legacy ? ".identity-transaction.json" : ".profile-transaction.json");
  if (legacy) renameSync(join(f.home, ".profile-transaction.json"), journal);
  expect(Buffer.byteLength(readFileSync(journal))).toBeGreaterThan(12 * MiB);
  expect(readFileSync(f.config, "utf8")).toBe(before);
  expect(existsSync(join(f.state, "large-0"))).toBe(false);
  expect(await run(f.home, "await domain.prepareProfileConfiguration(async () => {}); return config.settings().profiles.length;"))
    .toEqual({ ok: true, value: 1001 });
  const saved = JSON.parse(readFileSync(f.config, "utf8"));
  expect(saved.maxActive).toBe(1);
  expect(saved.metadata).toBe(f.value.metadata);
  expect(saved[f.key].some((p: { id: string }) => p.id === "large-0")).toBe(false);
  expect(saved).not.toHaveProperty(legacy ? "profiles" : "identities");
  expect(readFileSync(secretFile, "utf8")).toBe(secrets);
  const archives = readdirSync(join(f.home, "trash"));
  expect(archives).toHaveLength(1);
  expect(readFileSync(join(f.home, "trash", archives[0]!, "profile/saved-data"), "utf8")).toBe("keep this session");
  expect(existsSync(journal)).toBe(false);
}, 30000);

for (const direction of ["commit", "rollback"]) test(`large network journals recover interrupted ${direction} without losing metadata or secrets`, async () => {
  const f = fixture(), secretFile = join(f.home, "secrets.env");
  const padding = " ".repeat(8 * MiB);
  const before = { config: padding + f.encode(f.value), secrets: readFileSync(secretFile, "utf8") };
  const after = { config: padding + f.encode({ ...f.value, [f.key]: f.profiles.map((p, index) => index ? p : { ...p, mode: "proxy" }) }),
    secrets: before.secrets.replace("old.test", "new.test") };
  const journal = join(f.home, ".network-transaction.json");
  const pending = JSON.stringify({ version: 1, token: randomUUID(), profileId: "large-0", direction, before, after });
  expect(Buffer.byteLength(pending)).toBeGreaterThan(16 * MiB);
  writeFileSync(f.config, after.config); // Interrupted after the config replacement, before secrets.
  writeFileSync(journal, pending, { mode: 0o600 });
  expect(await run(f.home, "await domain.prepareProfileConfiguration(async () => {}); return config.settings().profiles.length;")).toEqual({ ok: true, value: 1001 });
  const desired = direction === "commit" ? after : before;
  expect(readFileSync(f.config, "utf8")).toBe(desired.config);
  expect(readFileSync(secretFile, "utf8")).toBe(desired.secrets);
  expect(existsSync(journal)).toBe(false);
}, 30000);

test("large catalog network edits still roll back a failed second-file replacement", async () => {
  const f = fixture(), before = readFileSync(f.config, "utf8"), secrets = readFileSync(join(f.home, "secrets.env"), "utf8");
  const prelude = `import { mock } from 'bun:test'; const original = { ...fs }; let failed = false;
mock.module('node:fs', () => ({ ...original, renameSync(from, to) {
  if (to === join(process.env.STELZ_HOME, 'secrets.env') && !failed) { failed = true; throw Error('injected failure'); }
  return original.renameSync(from, to);
}}));`;
  expect(await run(f.home, "await domain.updateNetwork('large-0', { revision: revision(), proxyUrl: 'http://new.test:8080' });", prelude))
    .toMatchObject({ ok: false, status: 409, message: expect.stringContaining("restored") });
  expect(readFileSync(f.config, "utf8")).toBe(before);
  expect(readFileSync(join(f.home, "secrets.env"), "utf8")).toBe(secrets);
  expect(existsSync(join(f.home, ".network-transaction.json"))).toBe(false);
}, 30000);

test("removing catalog byte ceilings preserves secret-file bounds for both mutation paths", async () => {
  const f = fixture(), before = readFileSync(f.config, "utf8");
  writeFileSync(join(f.home, "secrets.env"), "#".repeat(MiB + 1));
  for (const action of [
    "await domain.createProfile({ id: 'rejected', revision: domain.catalogRevision(config.settings()) });",
    "await domain.updateNetwork('large-0', { revision: revision() });",
  ]) expect(await run(f.home, action)).toMatchObject({ ok: false, status: 409 });
  expect(readFileSync(f.config, "utf8")).toBe(before);
  expect(existsSync(join(f.home, ".profile-transaction.json"))).toBe(false);
  expect(existsSync(join(f.home, ".network-transaction.json"))).toBe(false);
});

for (const kind of ["catalog", "network"]) test(`${kind} recovery rejects oversized embedded secrets without replacing service files`, async () => {
  const f = fixture(), before = { config: readFileSync(f.config, "utf8"), secrets: readFileSync(join(f.home, "secrets.env"), "utf8") };
  const after = kind === "catalog"
    ? { config: f.encode({ ...f.value, [f.key]: [...f.profiles, { id: "rejected", port: 32000, mode: "direct", storage: "native" }] }), secrets: "#".repeat(MiB + 1) }
    : { config: before.config, secrets: "#".repeat(MiB + 1) };
  const journal = join(f.home, kind === "catalog" ? ".profile-transaction.json" : ".network-transaction.json");
  const pending = JSON.stringify({ version: 1, token: randomUUID(), before, after,
    ...(kind === "catalog" ? { operation: "create", id: "rejected" } : { profileId: "large-0", direction: "commit" }) });
  writeFileSync(journal, pending, { mode: 0o600 });
  expect(await run(f.home, "await domain.prepareProfileConfiguration(async () => {});")).toMatchObject({ ok: false, status: 409 });
  expect(readFileSync(f.config, "utf8")).toBe(before.config);
  expect(readFileSync(join(f.home, "secrets.env"), "utf8")).toBe(before.secrets);
  expect(readFileSync(journal, "utf8")).toBe(pending);
});
