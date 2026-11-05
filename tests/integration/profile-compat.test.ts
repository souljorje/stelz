import { afterEach, expect, test } from "bun:test";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { normalizeProfileId } from "../../src/profiles/profile-compat.ts";
import { UPSTREAM_VERSION } from "../../src/versions.ts";
import type { Profile } from "../../src/profiles/config.ts";

const root = resolve(import.meta.dir, "../.."), homes: string[] = [];
type LegacyProfile = Profile & { mode: "direct" | "proxy" };
const legacyProfile: LegacyProfile = {
  id: "identity-01", port: 19471, mode: "direct", storage: "native",
  proxyEnv: "IDENTITY_01_PROXY_URL", expectedIPEnv: "IDENTITY_01_EXPECTED_IP",
};
const checkpointProfile: LegacyProfile = { id: "identity-02", port: 19472, mode: "direct" };
const oldSecrets = "# keep legacy references\nUNRELATED='literal # value'\n" +
  "IDENTITY_01_PROXY_URL=http://old-user:old-password@old.test:8080\nIDENTITY_01_EXPECTED_IP=198.51.100.9\n";
const token = "12345678-1234-4234-8234-123456789abc";
type Fixture = { home: string; state: string; config: string; secrets: string; key: "identities" | "profiles"; profiles: Profile[] };
type Files = { config: string; secrets: string };
const text = (file: string) => readFileSync(file, "utf8");
const privateFile = (file: string, value: string) => writeFileSync(file, value, { mode: 0o600 });
const encode = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

function emptyHome() {
  const home = mkdtempSync(join(tmpdir(), "stelz-profile-compat-"));
  homes.push(home);
  return home;
}
function fixture(legacy = true): Fixture {
  const home = emptyHome(), key = legacy ? "identities" : "profiles";
  const f: Fixture = { home, key, state: join(home, key), config: join(home, `${key}.json`),
    secrets: join(home, "secrets.env"), profiles: [structuredClone(legacyProfile), { ...checkpointProfile }] };
  mkdirSync(f.state, { mode: 0o700 });
  privateFile(f.config, encode({ maxActive: 2, [key]: f.profiles }));
  privateFile(f.secrets, oldSecrets);
  privateFile(join(f.state, "admission.lock"), '{"pid":0,"token":"legacy-admission"}');
  for (const p of f.profiles) {
    const path = join(f.state, p.id), data = join(path, p.storage === "native" ? "browser-data" : "storage");
    mkdirSync(data, { recursive: true, mode: 0o700 });
    privateFile(join(path, "lifecycle.lock"), '{"pid":0,"token":"legacy-lifecycle"}');
    privateFile(join(path, "fingerprint.json"), '{"version":1,"config":{"screen.width":1440}}');
    privateFile(join(path, "status.json"), encode({ identityId: p.id, instanceId: "old-instance", mode: "direct", phase: "stopped" }));
    if (p.storage === "native") {
      privateFile(join(path, "native-profile.json"), '{"version":1}');
      writeFileSync(join(data, "cookies.sqlite"), Buffer.from([0, 255, 17, 13, 10, 42]), { mode: 0o600 });
    } else privateFile(join(data, "storage-state.json"), '{"cookies":[],"origins":[]}');
  }
  return f;
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

function environment(home: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, STELZ_HOME: home, CAMOUFOX_EXECUTABLE: join(home, "no-browser") };
  delete env.IDENTITY_01_PROXY_URL;
  delete env.IDENTITY_01_EXPECTED_IP;
  return env;
}
async function run(home: string, body: string) {
  // config.ts selects paths at import time; never share its module cache across homes.
  const script = `import * as fs from 'node:fs';
import { join } from 'node:path';
try {
  const config = await import(${JSON.stringify(join(root, "src/profiles/config.ts"))});
  const runtime = await import(${JSON.stringify(join(root, "src/runtime/runtime.ts"))});
  const catalog = await import(${JSON.stringify(join(root, "src/profiles/profile-catalog.ts"))});
  const network = await import(${JSON.stringify(join(root, "src/profiles/network-transaction.ts"))});
  const { createUiModel } = await import(${JSON.stringify(join(root, "src/api/ui-model.ts"))});
  const home = process.env.STELZ_HOME, model = createUiModel();
  const value = await (async () => { ${body} })();
  console.log(JSON.stringify({ ok: true, value }));
} catch (error) { console.log(JSON.stringify({ ok: false, status: error.status, message: error.message })); }`;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
    cwd: root, env: environment(home), stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw Error(stderr || stdout || `Compatibility fixture exited ${code}.`);
  return JSON.parse(stdout.trim());
}
function tree(path: string): unknown {
  const info = lstatSync(path);
  return { ino: info.ino, dev: info.dev, mode: info.mode,
    value: info.isDirectory() ? readdirSync(path).sort().map(name => [name, tree(join(path, name))]) : readFileSync(path).toString("base64") };
}
function browserState(path: string) {
  return Object.fromEntries(readdirSync(path).filter(name => name !== "lifecycle.lock").sort().map(name => [name, tree(join(path, name))]));
}
const files = (f: Fixture): Files => ({ config: text(f.config), secrets: text(f.secrets) });
const rawCatalog = (f: Fixture) => JSON.parse(text(f.config));
function expectNoMigration(f: Fixture) {
  const other = f.key === "identities" ? "profiles" : "identities";
  expect(existsSync(join(f.home, other))).toBe(false);
  expect(existsSync(join(f.home, `${other}.json`))).toBe(false);
}
function catalogJournal(f: Fixture, operation: "create" | "delete", id: string, before: Files, after: Files) {
  const path = join(f.home, ".identity-transaction.json");
  // Version 1 is the journal written before the identity-to-profile rename.
  privateFile(path, encode({ version: 1, operation, id, token, before, after }));
  return path;
}

test("saved identityId becomes profileId without changing other fields or the input record", () => {
  const legacy = { identityId: "identity-01", instanceId: "old-instance", controller: { id: "controller" } };
  const before = structuredClone(legacy);
  expect(normalizeProfileId(legacy)).toEqual({ profileId: legacy.identityId, instanceId: legacy.instanceId, controller: legacy.controller });
  expect(legacy).toEqual(before);
  expect(normalizeProfileId({ profileId: "profile-01", phase: "ready" })).toEqual({ profileId: "profile-01", phase: "ready" });
  expect(normalizeProfileId({ identityId: "identity-01", profileId: "identity-01" })).toEqual({ profileId: "identity-01" });
  expect(() => normalizeProfileId({ identityId: "identity-01", profileId: "other" })).toThrow(/conflict/i);
});

test("a new installation uses only canonical profile files and an empty catalog", async () => {
  const home = emptyHome();
  expect(await run(home, `config.initialize(); config.initialize();
    return { config: config.CONFIG_FILE, state: config.STATE, catalog: config.settings(), journal: catalog.CATALOG_JOURNAL };`)).toEqual({
    ok: true, value: { config: join(home, "profiles.json"), state: join(home, "profiles"),
      catalog: { profiles: [] }, journal: join(home, ".profile-transaction.json") },
  });
  expect(JSON.parse(text(join(home, "profiles.json")))).toEqual({ profiles: [] });
  expect(readdirSync(home).sort()).toEqual(["profiles", "profiles.json", "secrets.env"]);
  expect(lstatSync(join(home, "secrets.env")).mode & 0o777).toBe(0o600);
});

test("init and observations preserve legacy IDs, secret references, data paths, and every inode", async () => {
  const f = fixture(), before = tree(f.home);
  const result = await run(f.home, `config.initialize(); config.initialize();
    return { config: config.CONFIG_FILE, state: config.STATE, dir: config.dir('identity-01'),
      settings: config.settings(), profile: config.profile('identity-01'), secret: config.secret('IDENTITY_01_PROXY_URL'),
      status: await runtime.reportStatus('identity-01'), snapshot: await model.snapshot(),
      directory: (await model.detail('identity-01')).directory,
      command: (await model.detail('identity-01')).mcpCommand };`);
  expect(result).toMatchObject({ ok: true, value: { config: f.config, state: f.state, dir: join(f.state, "identity-01"),
    settings: { maxActive: 2, profiles: f.profiles }, profile: legacyProfile,
    secret: parseEnv(oldSecrets).IDENTITY_01_PROXY_URL, status: { profileId: "identity-01", instanceId: "old-instance", phase: "stopped" } } });
  expect(result.value.status).not.toHaveProperty("identityId");
  expect(result.value.snapshot).not.toHaveProperty("identities");
  expect(result.value.snapshot.profiles.map((p: { id: string; storage: string }) => [p.id, p.storage])).toEqual([
    ["identity-01", "native"], ["identity-02", "checkpoint"],
  ]);
  expect(result.value.command).toContain("stelz mcp --profile identity-01");
  expect(result.value.directory).toBe(join(f.state, "identity-01"));
  expect(tree(f.home)).toEqual(before);
  expectNoMigration(f);
});

test("settings normalize the legacy list and serialize with the previous raw key", async () => {
  const f = fixture();
  const result = await run(f.home, `const previous = config.settings();
    const serialized = ['identities', 'profiles'].map(key => JSON.parse(config.serializeSettings(previous,
      JSON.stringify({ maxActive: 2, [key]: previous.profiles }))));
    let duplicateRejected = false;
    try { config.validateSettings({ maxActive: 2, identities: previous.profiles, profiles: previous.profiles }); }
    catch { duplicateRejected = true; }
    return { previous, serialized, duplicateRejected };`);
  expect(result).toEqual({ ok: true, value: { previous: { maxActive: 2, profiles: f.profiles }, serialized: [
    { maxActive: 2, identities: f.profiles }, { maxActive: 2, profiles: f.profiles },
  ], duplicateRejected: true } });
  expect(rawCatalog(f)).toEqual({ maxActive: 2, identities: f.profiles });
});

test("duplicate canonical and legacy paths fail without moving or replacing either copy", async () => {
  for (const kind of ["catalog", "state", "journal"] as const) {
    const f = fixture();
    if (kind === "catalog") privateFile(join(f.home, "profiles.json"), text(f.config));
    if (kind === "state") mkdirSync(join(f.home, "profiles"));
    if (kind === "journal") {
      privateFile(join(f.home, ".profile-transaction.json"), "{}");
      privateFile(join(f.home, ".identity-transaction.json"), "{}");
    }
    const before = tree(f.home);
    expect(await run(f.home, "config.initialize();")).toMatchObject({ ok: false, message: expect.stringContaining("Conflicting profile state") });
    expect(tree(f.home)).toEqual(before);
  }
});

for (const legacy of [true, false]) test(`${legacy ? "legacy" : "canonical"} create/network/delete keep the catalog format and saved browser data`, async () => {
  const f = fixture(legacy), path = join(f.state, legacyProfile.id), saved = browserState(path);
  const directoryInode = lstatSync(path).ino, admissionInode = lstatSync(join(f.state, "admission.lock")).ino;
  const lifecycleInode = lstatSync(join(path, "lifecycle.lock")).ino, other = tree(join(f.state, checkpointProfile.id));
  const result = await run(f.home, `const created = await model.createProfile({ id: 'new-work', revision: (await model.snapshot()).catalogRevision });
    const afterCreate = JSON.parse(fs.readFileSync(config.CONFIG_FILE, 'utf8'));
    const revision = (await model.snapshot()).profiles[0].network.revision;
    const updated = await model.updateNetwork('identity-01', { revision,
      proxyUrl: 'http://new-user:new-password@new.test:8181', expectedIp: '2001:db8::8' });
    const afterNetwork = JSON.parse(fs.readFileSync(config.CONFIG_FILE, 'utf8'));
    await model.deleteProfile('identity-01', (await model.snapshot()).catalogRevision);
    return { created, afterCreate, updated, afterNetwork, snapshot: await model.snapshot() };`);
  expect(result).toMatchObject({ ok: true });
  expect(result.value.created).toMatchObject({ id: "new-work", storage: "native", phase: "stopped" });
  expect(result.value.afterCreate).toEqual({ maxActive: 2, [f.key]: [...f.profiles, expect.objectContaining({ id: "new-work" })] });
  const { mode: _mode, ...updatedProfile } = legacyProfile;
  expect(result.value.afterNetwork[f.key][0]).toEqual(updatedProfile);
  expect(result.value.updated).toMatchObject({ id: legacyProfile.id, network: { expectedIp: "2001:db8::8", proxyDisplay: "http://new.test:8181" } });
  expect(JSON.stringify(result.value.updated)).not.toMatch(/new-user|new-password/);
  expect(rawCatalog(f)).toEqual({ maxActive: 2, [f.key]: [checkpointProfile, expect.objectContaining({ id: "new-work" })] });
  expect(parseEnv(text(f.secrets))).toEqual({ UNRELATED: "literal # value", IDENTITY_01_PROXY_URL: "http://new-user:new-password@new.test:8181", IDENTITY_01_EXPECTED_IP: "2001:db8::8" });
  expect(text(f.secrets)).toStartWith("# keep legacy references\nUNRELATED='literal # value'\n");
  const trash = join(f.home, "trash"), archive = join(trash, readdirSync(trash)[0]!), archived = join(archive, "profile");
  expect(browserState(archived)).toEqual(saved);
  expect(lstatSync(archived).ino).toBe(directoryInode);
  expect(lstatSync(join(archived, "lifecycle.lock")).ino).toBe(lifecycleInode);
  expect(lstatSync(join(f.state, "admission.lock")).ino).toBe(admissionInode);
  expect(tree(join(f.state, checkpointProfile.id))).toEqual(other);
  expect(JSON.parse(text(join(archive, "profile.json")))).toEqual({ profile: updatedProfile });
  expect(existsSync(join(archive, "identity.json"))).toBe(false);
  expect(existsSync(path)).toBe(false);
  expect(existsSync(join(f.home, ".profile-transaction.json"))).toBe(false);
  expect(existsSync(join(f.home, ".identity-transaction.json"))).toBe(false);
  expectNoMigration(f);
});

test("interrupted legacy creation recovers with or without already-persisted secrets", async () => {
  for (const secretsPersisted of [false, true]) {
    const f = fixture(), before = files(f), stateInode = lstatSync(f.state).ino;
    const saved = f.profiles.map(p => tree(join(f.state, p.id)));
    const admissionInode = lstatSync(join(f.state, "admission.lock")).ino;
    const added: LegacyProfile = { id: "identity-new", port: 19473, mode: "proxy", storage: "native", proxyEnv: "IDENTITY_NEW_PROXY_URL" };
    const after = { config: encode({ maxActive: 2, identities: [...f.profiles, added] }),
      secrets: before.secrets + "IDENTITY_NEW_PROXY_URL=http://new-user:new-password@new.test:8181\n" };
    const journal = catalogJournal(f, "create", added.id, before, after);
    if (secretsPersisted) privateFile(f.secrets, after.secrets);
    expect(await run(f.home, `await runtime.start('identity-new');`)).toMatchObject({ ok: false, message: "Run stelz setup first." });
    expect(files(f)).toEqual(after);
    expect(rawCatalog(f).identities).toEqual([...f.profiles, added]);
    expect(existsSync(journal)).toBe(false);
    expect(existsSync(join(f.state, added.id, "running.json"))).toBe(false);
    // Only the admission record and the newly initialized directory may change.
    expect(lstatSync(f.state).ino).toBe(stateInode);
    expect(lstatSync(join(f.state, "admission.lock")).ino).toBe(admissionInode);
    expect(f.profiles.map(p => tree(join(f.state, p.id)))).toEqual(saved);
    expectNoMigration(f);
  }
});

test("legacy deletion resumes from identity.json metadata before and after the directory was archived", async () => {
  for (const stage of ["metadata", "archived", "catalog"] as const) {
    const f = fixture(), before = files(f), path = join(f.state, legacyProfile.id), saved = browserState(path);
    const inode = lstatSync(path).ino, lockInode = lstatSync(join(path, "lifecycle.lock")).ino;
    const after = { config: encode({ maxActive: 2, identities: [checkpointProfile] }), secrets: before.secrets };
    const journal = catalogJournal(f, "delete", legacyProfile.id, before, after);
    const archive = join(f.home, "trash", `${legacyProfile.id}-${token}`), metadata = join(archive, "identity.json");
    mkdirSync(archive, { recursive: true, mode: 0o700 });
    privateFile(metadata, encode({ identity: legacyProfile }));
    const metadataBefore = tree(metadata);
    if (stage !== "metadata") renameSync(path, join(archive, "profile"));
    if (stage === "catalog") privateFile(f.config, after.config);
    expect(await run(f.home, `await runtime.start('identity-01');`)).toMatchObject({ ok: false, message: "Unknown profile: identity-01" });
    expect(files(f)).toEqual(after);
    expect(tree(metadata)).toEqual(metadataBefore);
    expect(existsSync(join(archive, "profile.json"))).toBe(false);
    expect(browserState(join(archive, "profile"))).toEqual(saved);
    expect(lstatSync(join(archive, "profile")).ino).toBe(inode);
    expect(lstatSync(join(archive, "profile/lifecycle.lock")).ino).toBe(lockInode);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(journal)).toBe(false);
    expectNoMigration(f);
  }
});

function legacyNetwork(f: Fixture, direction: "commit" | "rollback") {
  const before = files(f), after = {
    config: encode({ maxActive: 2, identities: [{ ...legacyProfile, mode: "proxy" }, checkpointProfile] }),
    secrets: oldSecrets.replace("http://old-user:old-password@old.test:8080", "http://new-user:new-password@new.test:8181")
      .replace("198.51.100.9", "2001:db8::8"),
  };
  const path = join(f.home, ".network-transaction.json");
  privateFile(path, encode({ version: 1, token, identityId: legacyProfile.id, direction, before, after }));
  // The old writer stopped between the catalog and secrets replacements.
  privateFile(f.config, after.config);
  return { path, before, after };
}

for (const direction of ["commit", "rollback"] as const) test(`legacy identityId network journal resumes ${direction} atomically`, async () => {
  const f = fixture(), path = join(f.state, legacyProfile.id), saved = browserState(path);
  const lockInodes = [join(f.state, "admission.lock"), join(path, "lifecycle.lock")].map(file => lstatSync(file).ino);
  const t = legacyNetwork(f, direction);
  const observed = await run(f.home, "return network.pendingNetworkTransaction();");
  expect(observed).toMatchObject({ ok: true, value: { profileId: legacyProfile.id, blocked: false } });
  expect(observed.value).not.toHaveProperty("identityId");
  expect(await run(f.home, `await runtime.start('identity-01');`)).toMatchObject({ ok: false, message: "Run stelz setup first." });
  expect(files(f)).toEqual(direction === "commit" ? t.after : t.before);
  expect(browserState(path)).toEqual(saved);
  expect([join(f.state, "admission.lock"), join(path, "lifecycle.lock")].map(file => lstatSync(file).ino)).toEqual(lockInodes);
  expect(existsSync(t.path)).toBe(false);
  expect(existsSync(join(path, "running.json"))).toBe(false);
  expectNoMigration(f);
});

test("legacy network recovery rejects conflicting IDs or manual edits without partial writes", async () => {
  for (const conflict of ["ids", "config", "secrets"] as const) {
    const f = fixture(), t = legacyNetwork(f, "commit"), path = join(f.state, legacyProfile.id), saved = browserState(path);
    if (conflict === "ids") privateFile(t.path, encode({ ...JSON.parse(text(t.path)), profileId: checkpointProfile.id }));
    if (conflict === "config") privateFile(f.config, encode({ ...rawCatalog(f), maxActive: 1 }));
    if (conflict === "secrets") privateFile(f.secrets, text(f.secrets) + "# manual edit\n");
    const before = files(f), journalBefore = tree(t.path);
    const result = await run(f.home, `await runtime.start('identity-01');`);
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(JSON.stringify(result)).not.toMatch(/old-password|new-password/);
    expect(files(f)).toEqual(before);
    expect(tree(t.path)).toEqual(journalBefore);
    expect(browserState(path)).toEqual(saved);
    expect(existsSync(join(path, "running.json"))).toBe(false);
    expectNoMigration(f);
  }
});

test("CLI --identity and cached identity MCP tools work while advertised names stay canonical", async () => {
  const f = fixture(), contractDir = join(f.home, `runtime/camofox-${UPSTREAM_VERSION}/mcp/lib`);
  mkdirSync(contractDir, { recursive: true });
  privateFile(join(contractDir, "tool-contracts.mjs"), "export const TOOL_DEFS = [];\n");
  const before = tree(f.home), client = new Client({ name: "legacy-compat-test", version: "1" });
  const env = Object.fromEntries(Object.entries(environment(f.home)).filter((entry): entry is [string, string] => entry[1] !== undefined));
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: ["--no-env-file", join(root, "src/cli/cli.ts"), "mcp", "--identity", legacyProfile.id], env, stderr: "pipe" }));
    const actions = ["status", "acquire", "release", "pause", "resume", "recheck"];
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(actions.map(action => `profile_${action}`));
    const canonical = await client.callTool({ name: "profile_status", arguments: {} });
    const legacy = await client.callTool({ name: "identity_status", arguments: {} });
    expect(canonical.isError).not.toBe(true);
    expect(legacy.isError).not.toBe(true);
    const canonicalStatus = JSON.parse((canonical.content as { text: string }[])[0]!.text);
    const legacyStatus = JSON.parse((legacy.content as { text: string }[])[0]!.text);
    expect(canonicalStatus).toMatchObject({ profileId: legacyProfile.id, phase: "stopped" });
    expect(canonicalStatus).not.toHaveProperty("identityId");
    expect(canonicalStatus).not.toHaveProperty("mode");
    expect(legacyStatus).toEqual({ ...canonicalStatus, identityId: legacyProfile.id });
    for (const action of actions.slice(1)) {
      const current = await client.callTool({ name: `profile_${action}`, arguments: {} });
      const cached = await client.callTool({ name: `identity_${action}`, arguments: {} });
      expect(cached.isError).toBe(true);
      expect(cached.content).toEqual(current.content);
      expect(JSON.stringify(cached.content)).not.toContain("Unknown tool");
    }
  } finally { await client.close(); }
  expect(tree(f.home)).toEqual(before);
});

for (const mode of ["direct", "proxy"] as const) test(`legacy ${mode} launch hashes and network fields survive unrelated edits`, async () => {
  const f = fixture(), saved = rawCatalog(f);
  saved.identities[0].mode = mode;
  privateFile(f.config, encode(saved));
  const secrets = text(f.secrets);
  const result = await run(f.home, `
    delete process.env.STELZ_TYPING_MODE;
    delete process.env.STELZ_IP_CHECK_INTERVAL_MS;
    const { createHash } = await import('node:crypto');
    const domain = await import(${JSON.stringify(join(root, "src/profiles/profile-configuration.ts"))});
    const before = config.settings().profiles[0];
    const proxy = ${JSON.stringify(mode === "direct" ? {} : {
      PROXY_STRATEGY: "round_robin", PROXY_PROTOCOL: "http", PROXY_HOST: "old.test", PROXY_PORT: "8080", PROXY_USERNAME: "old-user", PROXY_PASSWORD: "old-password",
    })};
    const historicalHash = createHash('sha256').update(JSON.stringify({ ...before, proxy, expectedIP: '198.51.100.9' })).digest('hex');
    const beforeHash = config.configurationHash(before);
    await domain.renameProfile(before.id, { revision: domain.catalogRevision(config.settings()), name: 'Renamed' });
    await domain.updateTyping(before.id, { revision: domain.typingRevision(config.settings().profiles[0]), mode: 'keyboard' });
    const current = config.settings(), p = current.profiles[0];
    await domain.updateNetwork(p.id, { revision: domain.networkRevision(current, p, { values: {
      IDENTITY_01_PROXY_URL: 'http://old-user:old-password@old.test:8080', IDENTITY_01_EXPECTED_IP: '198.51.100.9' } }), expectedIp: '198.51.100.9' });
    const after = config.settings().profiles[0];
    return { before, after, historicalHash, beforeHash, afterHash: config.configurationHash(after) };
  `);
  expect(result.ok).toBe(true);
  expect(result.value.after).toEqual({ ...result.value.before, name: "Renamed", typingMode: "keyboard" });
  expect(result.value.beforeHash).toBe(result.value.historicalHash);
  expect(result.value.afterHash).toBe(result.value.historicalHash);
  expect(text(f.secrets)).toBe(secrets);
  expectNoMigration(f);
});
