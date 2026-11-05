import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import type { PortableProfile, ProfileArchiveManifest } from "../../packages/stelz/src/profiles/profile-transfer-types.ts";

const root = resolve(import.meta.dir, "../.."), homes: string[] = [];
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function privateFile(path: string, text: string) { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, text, { mode: 0o600 }); }
function fixture(profiles: PortableProfile[] = [
  { id: "first", name: "First", storage: "native", typingMode: "keyboard", proxy: { url: "http://import-user:import-password@proxy.test:8080" }, expectedIp: "198.51.100.7" },
  { id: "second", storage: "checkpoint", proxy: {}, expectedIp: "" },
]) {
  const home = mkdtempSync(join(tmpdir(), "stelz-import-")); homes.push(home);
  const stage = join(home, "upload"), browser = join(home, "browser"), engine = "fixture executable";
  mkdirSync(join(home, "profiles"), { mode: 0o700 }); mkdirSync(stage, { mode: 0o700 });
  privateFile(browser, engine);
  privateFile(join(home, "profiles.json"), JSON.stringify({ maxActive: 1, metadata: "keep", profiles: [
    { id: "existing", name: "Existing", port: 19471, storage: "native", proxyEnv: "EXISTING_PROXY" },
  ] }, null, 2) + "\n");
  privateFile(join(home, "secrets.env"), "# keep this comment\nEXISTING_PROXY=http://existing.test:8080\nOTHER='line one\nline two'\n");
  privateFile(join(home, "profiles/existing/browser-data/session"), "existing session");
  const manifest: ProfileArchiveManifest = { format: "stelz-profiles", version: 1, createdAt: new Date().toISOString(),
    source: { stelzVersion: "0.2.1", platform: process.platform, arch: process.arch, engineSha256: sha(engine) }, profiles,
    directories: ["profiles"], files: [] };
  const addDirectory = (path: string) => {
    if (!manifest.directories.includes(path)) manifest.directories.push(path);
    mkdirSync(join(stage, path), { recursive: true, mode: 0o700 });
  };
  const addFile = (id: string, relative: string, text: string) => {
    const path = `profiles/${id}/${relative}`, parent = dirname(path), parts = parent.split("/");
    for (let i = 1; i <= parts.length; i++) addDirectory(parts.slice(0, i).join("/"));
    privateFile(join(stage, path), text);
    manifest.files.push({ path, size: Buffer.byteLength(text), sha256: sha(text) });
  };
  for (const [index, p] of profiles.entries()) {
    addDirectory(`profiles/${p.id}`);
    addFile(p.id, "fingerprint.json", JSON.stringify({ version: index % 2 + 1, engineSha256: manifest.source.engineSha256, config: { "navigator.userAgent": "fixture browser" } }));
    if (p.storage === "native") { addFile(p.id, "native-profile.json", '{"version":1}'); addFile(p.id, "browser-data/session", `saved ${p.id}`); }
    else addFile(p.id, "storage-state.json", '{"cookies":[],"origins":[{"origin":"https://site.test","localStorage":[]}]}');
    addFile(p.id, "uploads/document.txt", `upload ${p.id}`);
  }
  const persist = () => privateFile(join(home, "manifest.json"), JSON.stringify(manifest)); persist();
  return { home, stage, browser, manifest, addDirectory, addFile, persist };
}
type Fixture = ReturnType<typeof fixture>;
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
async function run(f: Fixture, body: string, prelude = "", expectedCode = 0) {
  f.persist();
  const script = `import * as fs from 'node:fs'; import { join } from 'node:path';
${prelude}
const home = process.env.STELZ_HOME, stagingDirectory = join(home, 'upload');
const manifest = JSON.parse(fs.readFileSync(join(home, 'manifest.json'), 'utf8'));
const api = await import(${JSON.stringify(join(root, "packages/stelz/src/profiles/profile-import.ts"))});
const configuration = await import(${JSON.stringify(join(root, "packages/stelz/src/profiles/profile-configuration.ts"))});
const config = await import(${JSON.stringify(join(root, "packages/stelz/src/profiles/config.ts"))});
const transaction = await import(${JSON.stringify(join(root, "packages/stelz/src/profiles/profile-import-transaction.ts"))});
const preview = () => api.inspectProfileImport(manifest, stagingDirectory);
const commit = async (extra = {}) => { const p = await preview(); return api.commitProfileImport({ manifest, stagingDirectory, revision: p.revision, profiles: p.profiles.map(({sourceId,id,name}) => ({sourceId,id,name})), ...extra }); };
try { console.log(JSON.stringify({ ok: true, value: await (async () => { ${body} })() })); }
catch (error) { console.log(JSON.stringify({ ok: false, status: error.status, name: error.name, message: error.message })); }`;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
    cwd: root, env: { ...process.env, STELZ_HOME: f.home, CAMOUFOX_EXECUTABLE: f.browser, EXISTING_PROXY: undefined }, stdout: "pipe", stderr: "pipe",
  });
  const [code, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, error || out).toBe(expectedCode);
  return out.trim() ? JSON.parse(out) : null;
}
const catalog = (f: Fixture) => JSON.parse(readFileSync(join(f.home, "profiles.json"), "utf8"));
const importStages = (f: Fixture) => readdirSync(join(f.home, "profiles")).filter(name => name.startsWith(".profile-import-"));
const journal = (f: Fixture) => join(f.home, ".profile-import-transaction.json");
const recover = (f: Fixture) => run(f, "await configuration.prepareProfileConfiguration(async () => {}); return config.settings();");
function replaceArchiveFile(f: Fixture, id: string, relative: string, text: string) {
  const path = `profiles/${id}/${relative}`;
  privateFile(join(f.stage, path), text);
  Object.assign(f.manifest.files.find(file => file.path === path)!, { size: Buffer.byteLength(text), sha256: sha(text) });
}

test("preview reserves the complete batch, copies catalog and disk conflicts, and bounds IDs and names", async () => {
  const longId = "a".repeat(64), f = fixture([
    { id: "existing", name: "Workspace", storage: "native" }, { id: "existing-copy", storage: "checkpoint" },
    { id: longId, name: "n".repeat(80), storage: "native" },
  ]);
  mkdirSync(join(f.home, "profiles/existing-copy-2")); mkdirSync(join(f.home, "profiles", longId));
  const before = readFileSync(join(f.home, "profiles.json"), "utf8"), preview = await run(f, "return preview();");
  expect(preview.ok).toBe(true); expect(preview.value.compatible).toBe(true);
  expect(preview.value.profiles.map((p: { id: string }) => p.id)).toEqual(["existing-copy-3", "existing-copy", "a".repeat(59) + "-copy"]);
  expect(preview.value.profiles[0].name).toBe("Workspace (copy 3)");
  expect(preview.value.profiles[2].name).toHaveLength(80);
  expect(readFileSync(join(f.home, "profiles.json"), "utf8")).toBe(before);
  expect(importStages(f)).toEqual([]); expect(existsSync(journal(f))).toBe(false);
  const imported = await run(f, "return commit();");
  expect(imported.ok).toBe(true); expect(catalog(f).profiles[0].id).toBe("existing");
  expect(readFileSync(join(f.home, "profiles/existing/browser-data/session"), "utf8")).toBe("existing session");
});

test("batch import remaps checkpoints, isolates credentials, keeps blocked references, and imports effective typing", async () => {
  const f = fixture(), before = readFileSync(join(f.home, "secrets.env"), "utf8");
  privateFile(join(f.home, "profiles/stray/running.json"), JSON.stringify({ port: 9377 }));
  const result = await run(f, "return { preview: await preview(), result: await commit() };");
  expect(result.ok).toBe(true); expect(result.value.preview.profiles[0].proxyDisplay).toBe("http://proxy.test:8080");
  expect(JSON.stringify(result.value.preview)).not.toContain("import-password");
  const saved = catalog(f), [existing, first, second] = saved.profiles;
  expect(saved).toMatchObject({ metadata: "keep", maxActive: 1 });
  expect(existing.proxyEnv).toBe("EXISTING_PROXY"); expect(first).toMatchObject({ id: "first", typingMode: "keyboard", storage: "native" });
  expect(first.port).not.toBe(9377); expect(new Set(saved.profiles.map((p: { port: number }) => p.port)).size).toBe(3);
  const text = readFileSync(join(f.home, "secrets.env"), "utf8"), values = parseEnv(text);
  expect(text.startsWith(before)).toBe(true); expect(values[first.proxyEnv]).toBe(f.manifest.profiles[0]!.proxy!.url);
  expect(values[first.expectedIPEnv]).toBe("198.51.100.7"); expect(second.proxyEnv).toMatch(/^STELZ_[A-F\d]+_PROXY_URL$/);
  expect(second.expectedIPEnv).toMatch(/^STELZ_[A-F\d]+_EXPECTED_IP$/); expect(values[second.proxyEnv]).toBeUndefined();
  expect(new Set([first.proxyEnv, first.expectedIPEnv, second.proxyEnv, second.expectedIPEnv]).size).toBe(4);
  const checkpoint = join(f.home, "profiles/second/storage", sha("second").slice(0, 32), "storage-state.json");
  expect(readFileSync(checkpoint, "utf8")).toContain("https://site.test"); expect(existsSync(join(f.home, "profiles/second/storage-state.json"))).toBe(false);
  for (const id of ["first", "second"]) for (const name of ["running.json", "status.json", "access-key", "server.log", "supervisor.log"])
    expect(existsSync(join(f.home, "profiles", id, name))).toBe(false);
  const blocked = await run(f, "return config.proxyEnvironment(config.profile('second'));");
  expect(blocked).toMatchObject({ ok: false, message: expect.stringContaining("Direct fallback is disabled") });
  expect(importStages(f)).toEqual([]); expect(existsSync(journal(f))).toBe(false);
});

test("stale catalog revisions and newly occupied destinations reject the complete batch", async () => {
  const f = fixture(), before = readFileSync(join(f.home, "secrets.env"), "utf8");
  const stale = await run(f, `const p = await preview(); await configuration.createProfile({ id: 'another', revision: p.revision });
    return api.commitProfileImport({ manifest, stagingDirectory, revision: p.revision, profiles: p.profiles.map(({sourceId,id}) => ({sourceId,id})) });`);
  expect(stale).toMatchObject({ ok: false, status: 409, message: expect.stringContaining("Refresh") });
  expect(catalog(f).profiles.map((p: { id: string }) => p.id)).toEqual(["existing", "another"]);
  const occupied = await run(f, `const p = await preview(); fs.mkdirSync(join(home, 'profiles/first'));
    return api.commitProfileImport({ manifest, stagingDirectory, revision: p.revision, profiles: p.profiles.map(({sourceId,id}) => ({sourceId,id})) });`);
  expect(occupied).toMatchObject({ ok: false, status: 409, message: expect.stringContaining("occupied") });
  expect(readFileSync(join(f.home, "secrets.env"), "utf8")).toBe(before); expect(existsSync(journal(f))).toBe(false);
});

test("compatibility reports global and individual issues separately and permits a valid subset", async () => {
  const f = fixture();
  f.addFile("second", "native-profile.json", '{"version":1}');
  const result = await run(f, `const p = await preview(); const selected = p.profiles[0];
    return { preview: p, result: await api.commitProfileImport({ manifest, stagingDirectory, revision: p.revision, profiles: [{sourceId:selected.sourceId,id:selected.id}] }) };`);
  expect(result.ok).toBe(true); expect(result.value.preview.compatible).toBe(true);
  expect(result.value.preview.profiles[1].issues.length).toBeGreaterThan(0); expect(catalog(f).profiles.map((p: { id: string }) => p.id)).toEqual(["existing", "first"]);
  f.manifest.source.platform = "other-os"; f.manifest.source.arch = "other-arch"; f.manifest.source.engineSha256 = "0".repeat(64);
  const incompatible = await run(f, "return preview();");
  expect(incompatible.ok).toBe(true); expect(incompatible.value.compatible).toBe(false); expect(incompatible.value.issues).toHaveLength(3);
});

test("unstarted profiles need no fingerprint and checkpoint origins are optional", async () => {
  const f = fixture([{ id: "new-native", storage: "native" }, { id: "new-checkpoint", storage: "checkpoint" }]);
  for (const id of ["new-native", "new-checkpoint"]) {
    rmSync(join(f.stage, "profiles", id), { recursive: true }); mkdirSync(join(f.stage, "profiles", id));
  }
  f.manifest.files = []; f.manifest.directories = ["profiles", "profiles/new-native", "profiles/new-checkpoint"];
  expect(await run(f, "return commit();")).toMatchObject({ ok: true });
  const g = fixture([{ id: "checkpoint", storage: "checkpoint" }]);
  const path = "profiles/checkpoint/storage-state.json", text = '{"cookies":[]}';
  privateFile(join(g.stage, path), text); Object.assign(g.manifest.files.find(file => file.path === path)!, { size: text.length, sha256: sha(text) });
  const result = await run(g, "return { preview: await preview(), result: await commit() };");
  expect(result.ok).toBe(true); expect(result.value.preview.profiles[0].issues).toEqual([]);
});

for (const checkpoint of ['[]', '{"cookies":{}}', '{"origins":[]}', '{"cookies":[],"origins":null}', '{"cookies":[]} trailing', '{"cookies":[}', '\ufeff{"cookies":[]}', '\u00a0{"cookies":[]}'])
  test("streaming validation rejects invalid checkpoint syntax or root fields", async () => {
    const f = fixture([{ id: "checkpoint", storage: "checkpoint" }]);
    replaceArchiveFile(f, "checkpoint", "storage-state.json", checkpoint);
    const result = await run(f, "return preview();");
    expect(result.ok).toBe(true); expect(result.value.compatible).toBe(true);
    expect(result.value.profiles[0].issues).toContain("The storage checkpoint is invalid.");
    expect(await run(f, "return commit();")).toMatchObject({ ok: false, status: 409 });
  });

test("checkpoint validation streams large values and bounded metadata readers report safe issues", async () => {
  const f = fixture([{ id: "checkpoint", storage: "checkpoint" }]);
  replaceArchiveFile(f, "checkpoint", "storage-state.json", '{"cookies":[],"origins":[{"data":"' + "x".repeat(4 * 1024 * 1024) + '"}]}');
  expect(await run(f, "return api.validCheckpointFile(join(stagingDirectory, 'profiles/checkpoint/storage-state.json'));")).toEqual({ ok: true, value: true });
  replaceArchiveFile(f, "checkpoint", "fingerprint.json", JSON.stringify({ version: 2, engineSha256: f.manifest.source.engineSha256,
    config: { "navigator.userAgent": "fixture browser", oversized: "x".repeat(16 * 1024 * 1024) } }));
  const pin = await run(f, "return preview();");
  expect(pin.value.profiles[0].issues.join(" ")).toContain("16 MiB");
  const g = fixture([{ id: "native", storage: "native" }]);
  replaceArchiveFile(g, "native", "native-profile.json", JSON.stringify({ version: 1, oversized: "x".repeat(64 * 1024) }));
  const marker = await run(g, "return preview();");
  expect(marker.value.profiles[0].issues.join(" ")).toContain("64 KiB");
});

for (const value of ["http://private-user:private-password@host.test/bad", "socks5://user:password@host.test:1080"]) test("invalid archive network data returns a safe error", async () => {
  const f = fixture(); f.manifest.profiles[0]!.proxy = { url: value };
  const result = await run(f, "return preview();");
  expect(result).toMatchObject({ ok: false, status: 400 }); expect(result.message).not.toContain(value); expect(result.message).not.toContain("private-password");
});

for (const mutation of ["bytes", "extra", "symlink", "hardlink"]) test(`commit rejects changed staging ${mutation} without publication`, async () => {
  const f = fixture(), config = readFileSync(join(f.home, "profiles.json"), "utf8"), secrets = readFileSync(join(f.home, "secrets.env"), "utf8");
  const path = join(f.stage, "profiles/first/browser-data/session");
  if (mutation === "bytes") writeFileSync(path, "x".repeat(readFileSync(path).length));
  if (mutation === "extra") privateFile(join(f.stage, "profiles/first/browser-data/extra"), "unlisted");
  if (mutation === "symlink") { rmSync(path); symlinkSync(join(f.home, "browser"), path); }
  if (mutation === "hardlink") { rmSync(path); linkSync(join(f.home, "browser"), path); }
  const result = await run(f, "return commit();");
  expect(result).toMatchObject({ ok: false, status: 409 });
  expect(readFileSync(join(f.home, "profiles.json"), "utf8")).toBe(config); expect(readFileSync(join(f.home, "secrets.env"), "utf8")).toBe(secrets);
  expect(importStages(f)).toEqual([]); expect(existsSync(journal(f))).toBe(false);
});

test("a crash during private preparation recovers backward and preview never performs recovery", async () => {
  const f = fixture(), before = readFileSync(join(f.home, "profiles.json"), "utf8");
  await run(f, "await commit({ onProgress(progress) { if (progress.bytes > 0) process.exit(79); } });", "", 79);
  expect(existsSync(journal(f))).toBe(true); expect(JSON.parse(readFileSync(journal(f), "utf8")).direction).toBe("rollback");
  const pending = readFileSync(journal(f), "utf8"), stages = importStages(f);
  expect((await run(f, "return preview();")).value.compatible).toBe(false);
  expect(readFileSync(journal(f), "utf8")).toBe(pending); expect(importStages(f)).toEqual(stages);
  expect(await recover(f)).toMatchObject({ ok: true }); expect(readFileSync(join(f.home, "profiles.json"), "utf8")).toBe(before);
  expect(importStages(f)).toEqual([]); expect(existsSync(journal(f))).toBe(false);
});

test("incomplete preparation cannot adopt a replaced profile root or an unlisted staged file", async () => {
  const f = fixture();
  await run(f, "await commit({ onProgress(progress) { if (progress.bytes > 0) process.exit(79); } });", "", 79);
  const stage = join(f.home, "profiles", importStages(f)[0]!), target = join(stage, "first"), held = join(f.home, "held-first");
  renameSync(target, held); privateFile(join(target, "browser-data/session"), "unrelated session");
  expect(await recover(f)).toMatchObject({ ok: false, status: 409 });
  expect(readFileSync(join(target, "browser-data/session"), "utf8")).toBe("unrelated session"); expect(existsSync(journal(f))).toBe(true);
  rmSync(target, { recursive: true }); renameSync(held, target);
  privateFile(join(target, "browser-data/unlisted"), "preserve this file");
  expect(await recover(f)).toMatchObject({ ok: false, status: 409 }); expect(existsSync(journal(f))).toBe(true);
  expect(readFileSync(join(target, "browser-data/unlisted"), "utf8")).toBe("preserve this file");
  rmSync(join(target, "browser-data/unlisted")); expect(await recover(f)).toMatchObject({ ok: true });
});

for (const boundary of ["first-directory", "secrets", "publication", "published"]) test(`a crash at ${boundary} recovers the whole batch forward`, async () => {
  const f = fixture(), before = readFileSync(join(f.home, "profiles.json"), "utf8");
  const prelude = `import { mock } from 'bun:test'; const original = { ...fs };
mock.module('node:fs', () => ({ ...original,
  fsyncSync(fd) { original.fsyncSync(fd); ${boundary === "first-directory" ? "if (original.existsSync(join(process.env.STELZ_HOME, 'profiles/first')) && !original.existsSync(join(process.env.STELZ_HOME, 'profiles/second'))) process.exit(79);" : ""} },
  renameSync(from, to) {
    ${boundary === "secrets" ? "if (to === join(process.env.STELZ_HOME, 'secrets.env')) process.exit(79);" : ""}
    ${boundary === "publication" ? "if (to === join(process.env.STELZ_HOME, 'profiles.json')) process.exit(79);" : ""}
    const result = original.renameSync(from, to);
    ${boundary === "published" ? "if (to === join(process.env.STELZ_HOME, 'profiles.json')) process.exit(79);" : ""}
    return result;
  }
}));`;
  await run(f, "return commit();", prelude, 79);
  expect(existsSync(journal(f))).toBe(true); expect(JSON.parse(readFileSync(journal(f), "utf8")).direction).toBe("commit");
  if (boundary !== "published") expect(readFileSync(join(f.home, "profiles.json"), "utf8")).toBe(before);
  expect(await recover(f)).toMatchObject({ ok: true }); expect(catalog(f).profiles.map((p: { id: string }) => p.id)).toEqual(["existing", "first", "second"]);
  expect(readFileSync(join(f.home, "profiles/first/browser-data/session"), "utf8")).toBe("saved first");
  expect(importStages(f)).toEqual([]); expect(existsSync(journal(f))).toBe(false);
  expect(await recover(f)).toMatchObject({ ok: true });
});

test("rollback intent survives a second crash and removes only this batch", async () => {
  const f = fixture(), before = readFileSync(join(f.home, "profiles.json"), "utf8"), secrets = readFileSync(join(f.home, "secrets.env"), "utf8");
  const prelude = `import { mock } from 'bun:test'; const original = { ...fs };
mock.module('node:fs', () => ({ ...original, renameSync(from, to) {
  if (to === join(process.env.STELZ_HOME, 'secrets.env')) throw Error('injected private failure');
  return original.renameSync(from, to);
}, rmdirSync(path) { const result = original.rmdirSync(path); if (path === join(process.env.STELZ_HOME, 'profiles/first')) process.exit(79); return result; } }));`;
  await run(f, "return commit();", prelude, 79);
  expect(JSON.parse(readFileSync(journal(f), "utf8")).direction).toBe("rollback");
  expect(await recover(f)).toMatchObject({ ok: true });
  expect(readFileSync(join(f.home, "profiles.json"), "utf8")).toBe(before); expect(readFileSync(join(f.home, "secrets.env"), "utf8")).toBe(secrets);
  expect(readFileSync(join(f.home, "profiles/existing/browser-data/session"), "utf8")).toBe("existing session");
  expect(existsSync(join(f.home, "profiles/first"))).toBe(false); expect(existsSync(join(f.home, "profiles/second"))).toBe(false); expect(importStages(f)).toEqual([]);
});

test("recovery keeps its journal when an unrelated destination or staged root replaces an owned path", async () => {
  const f = fixture();
  const prelude = `import { mock } from 'bun:test'; const original = { ...fs };
mock.module('node:fs', () => ({ ...original, fsyncSync(fd) { original.fsyncSync(fd);
  if (original.existsSync(join(process.env.STELZ_HOME, 'profiles/first')) && !original.existsSync(join(process.env.STELZ_HOME, 'profiles/second'))) process.exit(79);
} }));`;
  await run(f, "return commit();", prelude, 79);
  privateFile(join(f.home, "profiles/second/unrelated"), "preserve");
  const conflict = await recover(f); expect(conflict).toMatchObject({ ok: false, status: 409 }); expect(existsSync(journal(f))).toBe(true);
  expect(catalog(f).profiles.map((p: { id: string }) => p.id)).toEqual(["existing"]); expect(readFileSync(join(f.home, "profiles/second/unrelated"), "utf8")).toBe("preserve");
  rmSync(join(f.home, "profiles/second"), { recursive: true });
  const original = join(f.home, "profiles", importStages(f)[0]!), moved = join(f.home, "saved-stage"); renameSync(original, moved);
  privateFile(join(original, "unrelated"), "preserve staged root");
  expect(await recover(f)).toMatchObject({ ok: false, status: 409 }); expect(existsSync(journal(f))).toBe(true);
  expect(readFileSync(join(original, "unrelated"), "utf8")).toBe("preserve staged root");
  rmSync(original, { recursive: true }); renameSync(moved, original);
  expect(await recover(f)).toMatchObject({ ok: true });
});

test("pending import credentials are redacted and diagnostics report recovery without blocking existing catalog reads", async () => {
  const f = fixture();
  await run(f, "await commit({ onProgress(progress) { if (progress.bytes > 0) process.exit(79); } });", "", 79);
  const result = await run(f, `const { createUiModel, redactUiText } = await import(${JSON.stringify(join(root, "packages/stelz/src/api/ui-model.ts"))});
    const { doctor } = await import(${JSON.stringify(join(root, "packages/stelz/src/runtime/runtime.ts"))});
    return { text: redactUiText('import-password http://import-user:import-password@proxy.test:8080'), snapshot: await createUiModel().snapshot(), doctor: await doctor() };`);
  expect(result.ok).toBe(true); expect(result.value.text).not.toContain("import-password");
  expect(result.value.snapshot.profiles[0]).toMatchObject({ id: "existing", configurationError: expect.stringContaining("import") });
  expect(result.value.doctor.profileImportRecovery).toContain("import"); expect(existsSync(journal(f))).toBe(true);
});

test("a conflicting import journal does not block an explicit verified stop of an existing profile", async () => {
  const f = fixture(); privateFile(journal(f), "invalid journal requires inspection");
  const result = await run(f, `
    const runtime = await import(${JSON.stringify(join(root, "packages/stelz/src/runtime/runtime.ts"))});
    const processApi = await import(${JSON.stringify(join(root, "packages/stelz/src/runtime/profile-process.ts"))});
    const state = join(home, 'profiles/existing'), running = join(state, 'running.json');
    const accessKey = 'fixture-private-local-key'; fs.writeFileSync(join(state, 'access-key'), accessKey, {mode:0o600});
    let record;
    const endpoint = Bun.serve({hostname:'127.0.0.1',port:0,fetch(request) {
      if (request.headers.get('Authorization') !== 'Bearer ' + accessKey) return new Response('', {status:403});
      if (!request.url.endsWith('/local-profile/stop')) return new Response('', {status:404});
      fs.writeFileSync(running, JSON.stringify({version:2,pid:0,instanceId:record.instanceId,configurationHash:record.configurationHash,port:endpoint.port,serverState:'not-started'}));
      fs.writeFileSync(join(state, 'stopped.json'), JSON.stringify({instanceId:record.instanceId}));
      return Response.json({stopping:true});
    }});
    try {
      const settings = config.settings(); settings.profiles[0].port = endpoint.port;
      fs.writeFileSync(join(home, 'profiles.json'), JSON.stringify(settings));
      const start = processApi.processStart(process.pid);
      record = {version:2,pid:process.pid,serverPid:process.pid,supervisorStart:start,serverStart:start,
        serverState:'started',instanceId:'fixture-instance',configurationHash:config.configurationHash(settings.profiles[0]),port:endpoint.port};
      fs.writeFileSync(running, JSON.stringify(record));
      return await runtime.stop('existing');
    } finally { endpoint.stop(true); }
  `);
  expect(result).toMatchObject({ ok: true, value: { phase: "stopped" } });
  expect(readFileSync(journal(f), "utf8")).toBe("invalid journal requires inspection");
});
