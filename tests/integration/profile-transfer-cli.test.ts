import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { createHash } from "node:crypto";
import { createTestHome } from "../helpers/test-home.ts";

const cli = process.env.STELZ_TEST_CLI || resolve(import.meta.dir, "../../src/cli/cli.ts"), homes: string[] = [];
function home() { const value = createTestHome("stelz-transfer-cli"); homes.push(value); return value; }
afterEach(() => { for (const directory of homes.splice(0)) rmSync(directory, { recursive: true, force: true }); });
async function run(home: string, args: string[], extra: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, "--no-env-file", cli, ...args], {
    env: { ...process.env, STELZ_HOME: home, CAMOUFOX_EXECUTABLE: join(home, "engine"), ...extra }, stdout: "pipe", stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, out, err, value: args.includes("--json") ? JSON.parse(out || err) : undefined };
}
async function initialize(home: string) { writeFileSync(join(home, "engine"), "synthetic Camoufox executable"); expect((await run(home, ["init"])).code).toBe(0); }

test("CLI ZIP export/import preserves a batch and creates a copy without exposing credentials", async () => {
  const source = home(), target = home(); await initialize(source); await initialize(target);
  expect((await run(source, ["profile", "create", "work", "--proxy-url", "http://zip-user:zip-secret@proxy.test:8080", "--json"])).code).toBe(0);
  expect((await run(source, ["profile", "create", "personal", "--json"])).code).toBe(0);
  mkdirSync(join(source, "profiles/work/browser-data"), { recursive: true });
  writeFileSync(join(source, "profiles/work/browser-data/cookies.sqlite"), "synthetic saved sessions");
  writeFileSync(join(source, "profiles/work/native-profile.json"), '{"version":1}');
  writeFileSync(join(source, "profiles/work/fingerprint.json"), JSON.stringify({ version: 2,
    engineSha256: createHash("sha256").update("synthetic Camoufox executable").digest("hex"), config: { "navigator.userAgent": "synthetic fixture" } }));
  // Runtime-only files and access keys must never become portable data.
  writeFileSync(join(source, "profiles/work/access-key"), "source-service-key");
  writeFileSync(join(source, "profiles/work/server.log"), "private runtime log");
  const archive = join(source, "batch.stelz-profiles.zip");
  const exported = await run(source, ["profile", "export", "--all", "--output", archive, "--json"]);
  expect(exported.code).toBe(0); expect(exported.value.profiles).toHaveLength(2);
  expect(readFileSync(archive).subarray(0, 2).toString()).toBe("PK");
  expect((await run(target, ["profile", "create", "work", "--json"])).code).toBe(0);
  const before = readFileSync(join(target, "profiles.json"), "utf8");
  const imported = await run(target, ["profile", "import", archive, "--json"]);
  expect(imported.code).toBe(0);
  expect(imported.value).toMatchObject({ ok: true, profiles: expect.arrayContaining([{ sourceId: "work", id: "work-copy", name: expect.any(String) }]) });
  const config = JSON.parse(readFileSync(join(target, "profiles.json"), "utf8"));
  expect(config.profiles.find((p: { id: string }) => p.id === "work")).toEqual(JSON.parse(before).profiles[0]);
  expect(config.profiles).toHaveLength(3);
  const copied = config.profiles.find((p: { id: string }) => p.id === "work-copy");
  expect(parseEnv(readFileSync(join(target, "secrets.env"), "utf8"))[copied.proxyEnv]).toBe("http://zip-user:zip-secret@proxy.test:8080");
  expect(readFileSync(join(target, "profiles/work-copy/browser-data/cookies.sqlite"), "utf8")).toBe("synthetic saved sessions");
  expect(existsSync(join(target, "profiles/work-copy/access-key"))).toBe(false);
  expect(existsSync(join(target, "profiles/work-copy/server.log"))).toBe(false);
  expect(existsSync(join(target, "profiles/work-copy/running.json"))).toBe(false);
  expect(exported.out + exported.err + imported.out + imported.err).not.toMatch(/zip-user|zip-secret|source-service-key/);
}, 20_000);

test("CLI ZIP selection and explicit destination IDs preserve existing archives and reject mismatched engines", async () => {
  const source = home(), target = home(); await initialize(source); await initialize(target);
  await run(source, ["profile", "create", "first", "--json"]); await run(source, ["profile", "create", "second", "--json"]);
  const archive = join(source, "selected.zip");
  expect((await run(source, ["profile", "export", "first", "second", "--output", archive, "--json"])).code).toBe(0);
  const bytes = readFileSync(archive);
  expect((await run(source, ["profile", "export", "first", "--output", archive, "--json"])).value.error.code).toBe("conflict");
  expect(readFileSync(archive)).toEqual(bytes);
  writeFileSync(join(target, "engine"), "different synthetic executable");
  expect((await run(target, ["profile", "import", archive, "--json"])).code).toBe(1);
  expect(JSON.parse(readFileSync(join(target, "profiles.json"), "utf8")).profiles).toHaveLength(0);
  writeFileSync(join(target, "engine"), "synthetic Camoufox executable");
  const imported = await run(target, ["profile", "import", archive, "--profile", "second", "--rename", "second=renamed", "--json"]);
  expect(imported.code).toBe(0); expect(imported.value.profiles).toMatchObject([{ sourceId: "second", id: "renamed" }]);
  expect(JSON.parse(readFileSync(join(target, "profiles.json"), "utf8")).profiles.map((p: { id: string }) => p.id)).toEqual(["renamed"]);
}, 20_000);

test("CLI export refuses an unclean lifetime without stopping it or publishing an archive", async () => {
  const source = home(); await initialize(source); await run(source, ["profile", "create", "work", "--json"]);
  mkdirSync(join(source, "profiles/work"), { recursive: true });
  const record = JSON.stringify({ version: 2, pid: 0, instanceId: "synthetic-reservation", configurationHash: "synthetic", serverState: "not-started" });
  writeFileSync(join(source, "profiles/work/running.json"), record);
  const archive = join(source, "blocked.zip");
  const result = await run(source, ["profile", "export", "work", "--output", archive, "--json"]);
  expect(result.code).toBe(1); expect(result.value.error.code).toBe("conflict");
  expect(existsSync(archive)).toBe(false);
  expect(readFileSync(join(source, "profiles/work/running.json"), "utf8")).toBe(record);
});
