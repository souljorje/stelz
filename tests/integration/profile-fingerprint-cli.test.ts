import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createTestHome } from "../helpers/test-home.ts";

const cli = process.env.STELZ_TEST_CLI || resolve(import.meta.dir, "../../src/cli/cli.ts");
const homes: string[] = [];
const engine = "fixture engine";
const hash = createHash("sha256").update(engine).digest("hex");
const identity = {
  "navigator.userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0",
  "navigator.platform": "MacIntel",
};
function fixture() {
  const home = createTestHome("stelz-fingerprint-cli"); homes.push(home);
  mkdirSync(join(home, "profiles/work"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, "profiles.json"), JSON.stringify({ profiles: [{ id: "work", port: 19471, storage: "native" }] }), { mode: 0o600 });
  writeFileSync(join(home, "secrets.env"), "", { mode: 0o600 });
  writeFileSync(join(home, "engine"), engine, { mode: 0o600 });
  return home;
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function pin(home: string, value: unknown) {
  writeFileSync(join(home, "profiles/work/fingerprint.json"), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}
function snapshot(directory: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (root: string, relative = "") => {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const key = relative ? `${relative}/${entry.name}` : entry.name;
      const info = lstatSync(join(root, entry.name)), metadata = `${info.mode}:${info.mtimeMs}`;
      if (entry.isDirectory()) { result[key] = `directory:${metadata}`; visit(join(root, entry.name), key); }
      else if (entry.isSymbolicLink()) result[key] = `symlink:${metadata}`;
      else result[key] = `${metadata}:${readFileSync(join(root, entry.name)).toString("base64")}`;
    }
  };
  visit(directory); return result;
}
async function run(home: string, args: string[], enginePath = join(home, "engine")) {
  const child = Bun.spawn([process.execPath, "--no-env-file", cli, ...args], {
    env: { ...process.env, STELZ_HOME: home, CAMOUFOX_EXECUTABLE: enginePath }, stdout: "pipe", stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, out, err, json: args.includes("--json") ? JSON.parse(out || err) : undefined };
}

test("valid and invalid saved pins return static diagnostics without changing service state", async () => {
  const home = fixture();
  pin(home, { version: 2, engineSha256: hash, config: identity });
  let before = snapshot(home);
  const valid = await run(home, ["profile", "fingerprint", "check", "work", "--json"]);
  expect(valid.code).toBe(0);
  expect(valid.json).toMatchObject({ ok: true, format: "stelz-fingerprint-check", version: 1,
    profile: { id: "work" }, browserVerified: false,
    fingerprint: { staticValid: true, schema: "PASS", engineSha256: "PASS", runtime: "NOT_RUN", admissionBlocked: true } });
  expect(snapshot(home)).toEqual(before);
  const human = await run(home, ["profile", "fingerprint", "check", "work"]);
  expect(human.code).toBe(0); expect(human.out).toContain("Static identity: VALID");
  expect(human.out).toContain("does not verify a live browser"); expect(snapshot(home)).toEqual(before);

  pin(home, { version: 2, engineSha256: hash, config: { ...identity, "webGl:renderer": "ANGLE (NVIDIA Direct3D11)" } });
  before = snapshot(home);
  const invalid = await run(home, ["profile", "fingerprint", "check", "work", "--json"]);
  expect(invalid.code).toBe(1);
  expect(invalid.json).toMatchObject({ ok: false, error: { code: "fingerprint_invalid" },
    fingerprint: { staticValid: false, engineSha256: "PASS", runtime: "NOT_RUN", admissionBlocked: true } });
  expect(invalid.json.fingerprint.diagnostics).toContainEqual(expect.objectContaining({ code: "coherence.gpu-matches-os" }));
  expect(snapshot(home)).toEqual(before);
});

test("missing pins, malformed files, mismatched engines, and unavailable engines have stable codes", async () => {
  const home = fixture(), command = ["profile", "fingerprint", "check", "work", "--json"];
  let before = snapshot(home);
  const missing = await run(home, command);
  expect(missing.code).toBe(1); expect(missing.json).toMatchObject({ ok: false, error: { code: "fingerprint_uninitialized" } });
  expect(missing.json.fingerprint).toBeUndefined(); expect(snapshot(home)).toEqual(before);
  writeFileSync(join(home, "profiles/work/fingerprint.json"), "{broken"); before = snapshot(home);
  const invalid = await run(home, command);
  expect(invalid.code).toBe(1); expect(invalid.json.error.code).toBe("fingerprint_invalid");
  expect(invalid.json.fingerprint.diagnostics).toContainEqual(expect.objectContaining({ code: "pin.json.parse" }));
  expect(snapshot(home)).toEqual(before);
  pin(home, { version: 2, engineSha256: "a".repeat(64), config: identity }); before = snapshot(home);
  expect((await run(home, command)).json.error.code).toBe("fingerprint_engine_mismatch");
  expect((await run(home, command, join(home, "missing-engine"))).json.error.code).toBe("fingerprint_engine_unavailable");
  expect(snapshot(home)).toEqual(before);
  const path = join(home, "profiles/work/fingerprint.json"), outside = join(home, "outside-pin");
  rmSync(path); writeFileSync(outside, "secret outside pin"); symlinkSync(outside, path);
  const linked = await run(home, command);
  expect(linked.json.error.code).toBe("fingerprint_invalid");
  expect(linked.json.fingerprint.diagnostics).toContainEqual(expect.objectContaining({ code: "pin.file.unsafe" }));
  expect(linked.out + linked.err).not.toContain("secret outside pin");
});

test("nested syntax and catalog errors are JSON and profile links are not followed", async () => {
  const home = fixture();
  for (const args of [
    ["profile", "fingerprint", "--json"], ["profile", "fingerprint", "check", "../work", "--json"],
    ["profile", "fingerprint", "check", "work", "--json", "--json"],
  ]) {
    const result = await run(home, args);
    expect(result.code).toBe(1); expect(result.json).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  }
  expect((await run(home, ["profile", "fingerprint", "check", "other", "--json"])).json.error.code).toBe("profile_not_found");
  rmSync(join(home, "profiles/work"), { recursive: true });
  mkdirSync(join(home, "outside")); symlinkSync(join(home, "outside"), join(home, "profiles/work"));
  expect((await run(home, ["profile", "fingerprint", "check", "work", "--json"])).json.error.code).toBe("profile_unavailable");
  for (const args of [["--help"], ["profile", "--help"], ["profile", "fingerprint", "check", "--help"]])
    expect((await run(home, args)).out).toContain("profile fingerprint check PROFILE");
});

test("an uninitialized home reports a nested JSON error without creating files", async () => {
  const home = createTestHome("stelz-fingerprint-empty"); homes.push(home);
  const before = snapshot(home), result = await run(home, ["profile", "fingerprint", "check", "work", "--json"]);
  expect(result.code).toBe(1); expect(result.json.error.code).toBe("not_initialized"); expect(snapshot(home)).toEqual(before);
});
