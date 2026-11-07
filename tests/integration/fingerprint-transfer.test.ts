import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createTestHome } from "../helpers/test-home.ts";

const root = resolve(import.meta.dir, "../..");
const cli = process.env.STELZ_TEST_CLI || join(root, "src/cli/cli.ts");
const exportModule = join(root, "src/profiles/profile-export.ts");
const importModule = join(root, "src/profiles/profile-import.ts");
const archiveModule = join(root, "src/profiles/profile-archive.ts");
const homes: string[] = [], engine = "portable fixture engine";
const engineHash = createHash("sha256").update(engine).digest("hex");
const identity = {
  "navigator.userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0",
  "navigator.platform": "MacIntel", "webGl:renderer": "ANGLE (NVIDIA Direct3D11)",
};
function home(profiles: object[] = []) {
  const directory = createTestHome("stelz-fingerprint-transfer"); homes.push(directory);
  mkdirSync(join(directory, "profiles"), { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, "profiles.json"), JSON.stringify({ profiles }), { mode: 0o600 });
  writeFileSync(join(directory, "secrets.env"), "", { mode: 0o600 });
  writeFileSync(join(directory, "engine"), engine, { mode: 0o600 });
  return directory;
}
function source() {
  const directory = home([{ id: "work", port: 19471, storage: "native", proxyEnv: "WORK_PROXY" },
    { id: "empty", port: 19472, storage: "native" }]);
  writeFileSync(join(directory, "secrets.env"), "WORK_PROXY=http://private-user:private-secret@proxy.test:8080\n", { mode: 0o600 });
  mkdirSync(join(directory, "profiles/work/browser-data"), { recursive: true, mode: 0o700 });
  mkdirSync(join(directory, "profiles/empty"), { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, "profiles/work/browser-data/session"), "private session", { mode: 0o600 });
  writeFileSync(join(directory, "profiles/work/native-profile.json"), '{"version":1}', { mode: 0o600 });
  const pin = ` {\n  "config": ${JSON.stringify(identity)},\n  "engineSha256": "${engineHash}",\n  "version": 2\n}\n`;
  writeFileSync(join(directory, "profiles/work/fingerprint.json"), pin, { mode: 0o600 });
  return { directory, pin };
}
afterEach(() => { for (const directory of homes.splice(0)) rmSync(directory, { recursive: true, force: true }); });
async function child(home: string, args: string[]) {
  const process_ = Bun.spawn([process.execPath, "--no-env-file", ...args], {
    cwd: root, env: { ...process.env, STELZ_HOME: home, CAMOUFOX_EXECUTABLE: join(home, "engine"), WORK_PROXY: undefined }, stdout: "pipe", stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([process_.exited, new Response(process_.stdout).text(), new Response(process_.stderr).text()]);
  return { code, out, err, json: JSON.parse(out || err) };
}
async function exportArchive(directory: string, output: string, ids: string[]) {
  const work = join(directory, `export-${crypto.randomUUID()}`); mkdirSync(work, { mode: 0o700 });
  const program = `const { exportProfileArchive } = await import(${JSON.stringify(exportModule)});
try {
  const result = await exportProfileArchive({ profileIds: ${JSON.stringify(ids)}, outputFile: ${JSON.stringify(output)}, workDirectory: ${JSON.stringify(work)} });
  console.log(JSON.stringify({ ok: true, fingerprintDiagnostics: result.fingerprintDiagnostics }));
} catch (error) { console.log(JSON.stringify({ ok: false, status: error.status, message: error.message })); }`;
  return child(directory, ["-e", program]);
}

test("invalid identity exports with diagnostics and imports exact bytes with selection", async () => {
  const from = source(), destination = home(), archive = join(from.directory, "profiles.zip");
  const exported = await exportArchive(from.directory, archive, ["work", "empty"]);
  expect(exported.json.ok).toBe(true);
  expect(exported.json.fingerprintDiagnostics).toContainEqual({ sourceId: "empty", fingerprint: { status: "uninitialized" } });
  const work = exported.json.fingerprintDiagnostics.find((item: { sourceId: string }) => item.sourceId === "work");
  expect(work.fingerprint).toMatchObject({ status: "checked", validation: { staticValid: false, engineSha256: "PASS", runtime: "NOT_RUN", admissionBlocked: true } });
  expect(work.fingerprint.validation.diagnostics).toContainEqual(expect.objectContaining({ code: "webgl.renderer.direct3d_on_macos" }));
  expect(exported.out).not.toMatch(/private-user|private-secret|private session/);
  expect(readFileSync(join(from.directory, "profiles/work/fingerprint.json"), "utf8")).toBe(from.pin);

  const imported = await child(destination, [cli, "profile", "import", archive, "--profile", "work", "--rename", "work=restored", "--json"]);
  expect(imported.code).toBe(0); expect(imported.json.profiles).toMatchObject([{ sourceId: "work", id: "restored" }]);
  expect(imported.json.fingerprintDiagnostics).toContainEqual(expect.objectContaining({ sourceId: "work", fingerprint: work.fingerprint }));
  expect(imported.out + imported.err).not.toMatch(/private-user|private-secret|private session/);
  expect(readFileSync(join(destination, "profiles/restored/fingerprint.json"), "utf8")).toBe(from.pin);
  expect(readFileSync(join(destination, "profiles/restored/browser-data/session"), "utf8")).toBe("private session");
  expect(existsSync(join(destination, "profiles/restored/running.json"))).toBe(false);
  const checked = await child(destination, [cli, "profile", "fingerprint", "check", "restored", "--json"]);
  expect(checked.code).toBe(1); expect(checked.json.error.code).toBe("fingerprint_invalid");
  expect(checked.json.fingerprint.admissionBlocked).toBe(true);
  const empty = await child(destination, [cli, "profile", "import", archive, "--profile", "empty", "--json"]);
  expect(empty.code).toBe(0);
  expect(empty.json.fingerprintDiagnostics).toEqual([{ sourceId: "empty", fingerprint: { status: "uninitialized" } }]);
}, 20_000);

test("engine mismatch, missing pins, and unsafe links remain fatal", async () => {
  const from = source(), pinPath = join(from.directory, "profiles/work/fingerprint.json");
  writeFileSync(pinPath, JSON.stringify({ version: 2, engineSha256: "a".repeat(64), config: identity }));
  const mismatchArchive = join(from.directory, "mismatch.zip");
  expect((await exportArchive(from.directory, mismatchArchive, ["work"])).json).toMatchObject({ ok: false, status: 409 });
  expect(existsSync(mismatchArchive)).toBe(false);
  writeFileSync(pinPath, "{invalid-json");
  expect((await exportArchive(from.directory, join(from.directory, "invalid-json.zip"), ["work"])).json).toMatchObject({ ok: false, status: 409 });
  rmSync(pinPath);
  expect((await exportArchive(from.directory, join(from.directory, "missing.zip"), ["work"])).json).toMatchObject({ ok: false, status: 409 });
  const outside = join(from.directory, "other-pin"); writeFileSync(outside, from.pin); symlinkSync(outside, pinPath);
  expect((await exportArchive(from.directory, join(from.directory, "link.zip"), ["work"])).json).toMatchObject({ ok: false, status: 409 });
  expect(readFileSync(outside, "utf8")).toBe(from.pin);
});

test("imports retain engine, path, and file-integrity guards", async () => {
  const from = source(), destination = home(), archive = join(from.directory, "archive.zip");
  expect((await exportArchive(from.directory, archive, ["work"])).json.ok).toBe(true);
  writeFileSync(join(destination, "engine"), "different engine");
  const before = readFileSync(join(destination, "profiles.json"), "utf8");
  const mismatch = await child(destination, [cli, "profile", "import", archive, "--json"]);
  expect(mismatch.code).toBe(1); expect(mismatch.json.error.code).toBe("conflict");
  expect(readFileSync(join(destination, "profiles.json"), "utf8")).toBe(before);
  writeFileSync(join(destination, "engine"), engine);
  const stage = join(destination, "stage");
  const program = `import { writeFileSync } from 'node:fs'; import { join } from 'node:path';
const { readProfileArchive } = await import(${JSON.stringify(archiveModule)});
const api = await import(${JSON.stringify(importModule)});
const manifest = await readProfileArchive({ archiveFile: ${JSON.stringify(archive)}, stagingDirectory: ${JSON.stringify(stage)} });
const preview = await api.inspectProfileImport(manifest, ${JSON.stringify(stage)});
const bad = structuredClone(manifest); bad.files[0].path = '../escape';
let pathBlocked = false, integrityBlocked = false;
try { await api.inspectProfileImport(bad, ${JSON.stringify(stage)}); } catch { pathBlocked = true; }
writeFileSync(join(${JSON.stringify(stage)}, 'profiles/work/browser-data/session'), 'X'.repeat(${Buffer.byteLength("private session")}));
try { await api.commitProfileImport({ manifest, stagingDirectory: ${JSON.stringify(stage)}, revision: preview.revision,
  profiles: [{ sourceId: 'work', id: 'work' }] }); } catch { integrityBlocked = true; }
console.log(JSON.stringify({ pathBlocked, integrityBlocked }));`;
  const result = await child(destination, ["-e", program]);
  expect(result.json).toEqual({ pathBlocked: true, integrityBlocked: true });
  expect(readFileSync(join(destination, "profiles.json"), "utf8")).toBe(before);
  expect(existsSync(join(destination, "profiles/work"))).toBe(false);
}, 20_000);

test("a staged pin with a different engine is diagnosed and cannot be imported", async () => {
  const from = source(), destination = home(), archive = join(from.directory, "archive.zip"), stage = join(destination, "stage");
  expect((await exportArchive(from.directory, archive, ["work"])).json.ok).toBe(true);
  const program = `import { createHash } from 'node:crypto'; import { readFileSync, writeFileSync } from 'node:fs'; import { join } from 'node:path';
const { readProfileArchive } = await import(${JSON.stringify(archiveModule)});
const api = await import(${JSON.stringify(importModule)});
const manifest = await readProfileArchive({ archiveFile: ${JSON.stringify(archive)}, stagingDirectory: ${JSON.stringify(stage)} });
const pinPath = join(${JSON.stringify(stage)}, 'profiles/work/fingerprint.json');
const pin = JSON.parse(readFileSync(pinPath, 'utf8')); pin.engineSha256 = 'a'.repeat(64);
const bytes = Buffer.from(JSON.stringify(pin)); writeFileSync(pinPath, bytes);
const file = manifest.files.find(item => item.path === 'profiles/work/fingerprint.json');
file.size = bytes.length; file.sha256 = createHash('sha256').update(bytes).digest('hex');
const preview = await api.inspectProfileImport(manifest, ${JSON.stringify(stage)});
let blocked = false;
try { await api.commitProfileImport({ manifest, stagingDirectory: ${JSON.stringify(stage)}, revision: preview.revision,
  profiles: [{ sourceId: 'work', id: 'work' }] }); } catch { blocked = true; }
console.log(JSON.stringify({ fingerprint: preview.profiles[0].fingerprint, issues: preview.profiles[0].issues, blocked }));`;
  const result = await child(destination, ["-e", program]);
  expect(result.json).toMatchObject({ blocked: true, fingerprint: { status: "checked", validation: { engineSha256: "FAIL" } } });
  expect(result.json.issues).toHaveLength(1);
  expect(existsSync(join(destination, "profiles/work"))).toBe(false);
}, 20_000);
