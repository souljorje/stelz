import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createTestHome } from "../helpers/test-home.ts";
import type { TransferFingerprintDiagnostic } from "../../src/profiles/profile-transfer-types.ts";

const root = resolve(import.meta.dir, "../..");
const cli = process.env.STELZ_TEST_CLI || join(root, "src/cli/cli.ts");
const archiveModule = join(root, "src/profiles/profile-archive.ts");
const homes: string[] = [], engine = "transfer wrapper fixture engine";
const engineHash = createHash("sha256").update(engine).digest("hex");
const identity = {
  "navigator.userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0",
  "navigator.platform": "MacIntel",
};

function home(profiles: object[] = []) {
  const directory = createTestHome("stelz-transfer-diagnostics"); homes.push(directory);
  mkdirSync(join(directory, "profiles"), { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, "profiles.json"), JSON.stringify({ profiles }), { mode: 0o600 });
  writeFileSync(join(directory, "secrets.env"), "", { mode: 0o600 });
  writeFileSync(join(directory, "engine"), engine, { mode: 0o600 });
  return directory;
}
function source() {
  const directory = home([
    { id: "valid", port: 19471, storage: "native" },
    { id: "invalid", port: 19472, storage: "native", proxyEnv: "WRAPPER_PROXY" },
    { id: "empty", port: 19473, storage: "native", proxyEnv: "WRAPPER_MISSING_PROXY" },
  ]);
  writeFileSync(join(directory, "secrets.env"), "WRAPPER_PROXY=http://private-user:private-secret@proxy.test:8080\n", { mode: 0o600 });
  for (const id of ["valid", "invalid", "empty"]) mkdirSync(join(directory, "profiles", id), { mode: 0o700 });
  const valid = JSON.stringify({ version: 2, engineSha256: engineHash, config: identity });
  const invalid = ` {\n"version":2,"engineSha256":"${engineHash}","config":${JSON.stringify({ ...identity, "webGl:renderer": "ANGLE (NVIDIA Direct3D11)" })}\n}\n`;
  writeFileSync(join(directory, "profiles/valid/fingerprint.json"), valid, { mode: 0o600 });
  writeFileSync(join(directory, "profiles/invalid/fingerprint.json"), invalid, { mode: 0o600 });
  return { directory, invalid };
}
afterEach(() => { for (const directory of homes.splice(0)) rmSync(directory, { recursive: true, force: true }); });
async function spawn(home: string, args: string[]) {
  const child = Bun.spawn([process.execPath, "--no-env-file", ...args], {
    cwd: root, env: { ...process.env, STELZ_HOME: home, CAMOUFOX_EXECUTABLE: join(home, "engine"), WRAPPER_PROXY: undefined, WRAPPER_MISSING_PROXY: undefined },
    stdout: "pipe", stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, out, err, json: args.includes("--json") ? JSON.parse(out || err) : undefined };
}
const run = (home: string, args: string[]) => spawn(home, [cli, ...args]);

test("export and import expose selected diagnostics in JSON and human output", async () => {
  const from = source(), jsonTarget = home(), humanTarget = home();
  const archive = join(from.directory, "profiles.zip"), humanArchive = join(from.directory, "human.zip");
  const exported = await run(from.directory, ["profile", "export", "--all", "--output", archive, "--json"]);
  expect(exported.code).toBe(0); expect(exported.err).toBe("");
  expect(exported.json).toMatchObject({ ok: true, archive, profiles: expect.arrayContaining([
    { id: "valid", name: "valid" }, { id: "invalid", name: "invalid" }, { id: "empty", name: "empty" },
  ]) });
  const diagnostics = exported.json.fingerprintDiagnostics as TransferFingerprintDiagnostic[];
  const byId = new Map(diagnostics.map(item => [item.sourceId, item.fingerprint] as const));
  expect(byId.get("empty")).toEqual({ status: "uninitialized" });
  expect(byId.get("valid")).toMatchObject({ status: "checked", validation: { staticValid: true, engineSha256: "PASS", runtime: "NOT_RUN" } });
  const invalid = byId.get("invalid");
  expect(invalid).toMatchObject({ status: "checked", validation: { staticValid: false, engineSha256: "PASS", runtime: "NOT_RUN" } });
  if (invalid?.status !== "checked") throw Error("The invalid pin diagnostics are missing.");
  expect(invalid.validation.diagnostics).toContainEqual(expect.objectContaining({ code: "coherence.gpu-matches-os" }));
  expect(readFileSync(archive).subarray(0, 2).toString()).toBe("PK");

  const humanExport = await run(from.directory, ["profile", "export", "--all", "--output", humanArchive]);
  expect(humanExport.code).toBe(0); expect(humanExport.out.trim()).toBe(`Exported 3 profiles to ${humanArchive}.`);
  expect(humanExport.err).toContain("The archive includes saved logins and available proxy credentials. Keep it private.");
  expect(humanExport.err).toContain("invalid: invalid"); expect(humanExport.err).toContain("uninitialized: empty");
  expect(humanExport.err).toContain("runtime not verified:");
  const validArchive = join(from.directory, "valid-only.zip");
  const validExport = await run(from.directory, ["profile", "export", "valid", "--output", validArchive]);
  expect(validExport.code).toBe(0); expect(validExport.err).toContain("runtime not verified: valid");
  expect(validExport.err).not.toContain("invalid:"); expect(validExport.err).not.toContain("uninitialized:");
  const before = readFileSync(archive);
  const duplicate = await run(from.directory, ["profile", "export", "--all", "--output", archive, "--json"]);
  expect(duplicate.code).toBe(1); expect(duplicate.json).toMatchObject({ ok: false, error: { code: "conflict" } });
  expect(duplicate.json.fingerprintDiagnostics).toBeUndefined(); expect(readFileSync(archive)).toEqual(before);

  const imported = await run(jsonTarget, ["profile", "import", archive, "--profile", "invalid", "--profile", "empty",
    "--rename", "invalid=restored", "--json"]);
  expect(imported.code).toBe(0); expect(imported.err).toBe("");
  expect(imported.json.profiles).toEqual(expect.arrayContaining([
    expect.objectContaining({ sourceId: "invalid", id: "restored" }), expect.objectContaining({ sourceId: "empty", id: "empty" }),
  ]));
  expect(imported.json.fingerprintDiagnostics).toHaveLength(2);
  expect(imported.json.fingerprintDiagnostics).toEqual(expect.arrayContaining([
    { sourceId: "invalid", fingerprint: byId.get("invalid") }, { sourceId: "empty", fingerprint: byId.get("empty") },
  ]));
  expect(readFileSync(join(jsonTarget, "profiles/restored/fingerprint.json"), "utf8")).toBe(from.invalid);
  expect(existsSync(join(jsonTarget, "profiles/valid"))).toBe(false);

  const humanImport = await run(humanTarget, ["profile", "import", archive, "--profile", "invalid", "--profile", "empty"]);
  expect(humanImport.code).toBe(0); expect(humanImport.out).toContain("Imported invalid as invalid.");
  expect(humanImport.out).toContain("Imported empty as empty.");
  expect(humanImport.err).toContain("invalid: invalid"); expect(humanImport.err).toContain("uninitialized: empty");
  expect(humanImport.err).toContain("runtime not verified: invalid");
  expect(humanImport.err).toContain("Some imported profiles need proxy credentials before they can start.");
  expect(exported.out + exported.err + humanExport.out + humanExport.err + imported.out + imported.err + humanImport.out + humanImport.err)
    .not.toMatch(/private-user|private-secret/);
}, 30_000);

test("import compatibility failures retain preview diagnostics and structured errors", async () => {
  const from = source(), target = home(), archive = join(from.directory, "valid.zip");
  const badArchive = join(from.directory, "mismatched-pin.zip"), stage = join(from.directory, "repack");
  expect((await run(from.directory, ["profile", "export", "valid", "--output", archive, "--json"])).code).toBe(0);
  const script = `import { readFileSync, rmSync, writeFileSync } from 'node:fs'; import { join } from 'node:path';
const { readProfileArchive, writeProfileArchive } = await import(${JSON.stringify(archiveModule)});
const manifest = await readProfileArchive({ archiveFile: ${JSON.stringify(archive)}, stagingDirectory: ${JSON.stringify(stage)} });
const path = join(${JSON.stringify(stage)}, 'profiles/valid/fingerprint.json');
const pin = JSON.parse(readFileSync(path, 'utf8')); pin.engineSha256 = 'a'.repeat(64);
writeFileSync(path, JSON.stringify(pin)); rmSync(join(${JSON.stringify(stage)}, 'manifest.json'));
const { files, directories, ...metadata } = manifest;
await writeProfileArchive({ snapshotDirectory: ${JSON.stringify(stage)}, metadata, outputFile: ${JSON.stringify(badArchive)} });`;
  const repacked = await spawn(from.directory, ["-e", script]); expect(repacked.code, repacked.err).toBe(0);
  const rejected = await run(target, ["profile", "import", badArchive, "--profile", "valid", "--json"]);
  expect(rejected.code).toBe(1); expect(rejected.out).toBe("");
  expect(rejected.json).toMatchObject({ ok: false, error: { code: "conflict" }, fingerprintDiagnostics: [
    { sourceId: "valid", fingerprint: { status: "checked", validation: { staticValid: false, engineSha256: "FAIL", runtime: "NOT_RUN" } } },
  ] });
  expect(rejected.json.fingerprintDiagnostics[0].fingerprint.validation.diagnostics)
    .toContainEqual(expect.objectContaining({ code: "engineSha256.mismatch" }));
  const human = await run(target, ["profile", "import", badArchive, "--profile", "valid"]);
  expect(human.code).toBe(1); expect(human.err).toContain("invalid: valid");
  expect(human.err).toContain("runtime not verified: valid");
  expect(existsSync(join(target, "profiles/valid"))).toBe(false);
  writeFileSync(join(target, "engine"), "different fixture engine");
  const incompatible = await run(target, ["profile", "import", archive, "--profile", "valid", "--json"]);
  expect(incompatible.code).toBe(1);
  expect(incompatible.json).toMatchObject({ ok: false, error: { code: "conflict" }, fingerprintDiagnostics: [
    { sourceId: "valid", fingerprint: { status: "checked", validation: { engineSha256: "PASS", runtime: "NOT_RUN" } } },
  ] });
}, 30_000);
