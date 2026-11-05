import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";

const cli = resolve(import.meta.dir, "../../packages/stelz/src/cli/cli.ts"), homes: string[] = [];
function home() { const value = mkdtempSync(join(tmpdir(), "stelz-profile-cli-")); homes.push(value); return value; }
afterEach(() => { for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true }); });
async function run(dir: string, args: string[], extra: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, "--no-env-file", cli, ...args], {
    env: { ...process.env, STELZ_HOME: dir, CLI_PROXY: undefined, CLI_IP: undefined, ...extra }, stdout: "pipe", stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, out, err, value: args.includes("--json") ? JSON.parse(out || err) : undefined };
}
const create = (dir: string, args: string[] = [], env?: Record<string, string>) => run(dir, ["profile", "create", "work", ...args, "--json"], env);
const files = (dir: string, legacy = false) => [readFileSync(join(dir, legacy ? "identities.json" : "profiles.json"), "utf8"), readFileSync(join(dir, "secrets.env"), "utf8")];

test("CLI creates a native profile and reuses it without rewriting configuration or saved state", async () => {
  const dir = home(); await run(dir, ["init"]);
  const first = await create(dir);
  expect(first.code).toBe(0);
  expect(first.value).toMatchObject({ ok: true, created: true, home: dir, profile: { id: "work", storage: "native", proxyConfigured: false } });
  const before = files(dir);
  mkdirSync(join(dir, "profiles/work/browser-data"), { recursive: true });
  writeFileSync(join(dir, "profiles/work/browser-data/marker"), "existing session");
  expect((await create(dir)).value).toEqual({ ...first.value, created: false });
  expect((await create(dir, ["--direct"])).code).toBe(0);
  expect(files(dir)).toEqual(before);
  expect(readFileSync(join(dir, "profiles/work/browser-data/marker"), "utf8")).toBe("existing session");
});

test("CLI imports proxy and IP inputs once and never prints their values", async () => {
  const dir = home(); await run(dir, ["init"]);
  const env = { CLI_PROXY: "http://private-user:private-password@proxy.test:8080", CLI_IP: "203.0.113.19" };
  const flags = ["--proxy-env", "CLI_PROXY", "--expected-ip-env", "CLI_IP"];
  const first = await create(dir, flags, env), before = files(dir);
  expect(first.code).toBe(0);
  const stored = parseEnv(before[1]!);
  expect(stored[first.value.profile.proxyEnv]).toBe(env.CLI_PROXY);
  expect(stored[first.value.profile.expectedIPEnv]).toBe(env.CLI_IP);
  const second = await create(dir, flags, env);
  expect(second.value).toEqual({ ...first.value, created: false });
  expect((await create(dir)).value.created).toBe(false);
  expect(files(dir)).toEqual(before);
  expect(first.out + first.err + second.out + second.err).not.toMatch(/private-user|private-password|proxy\.test|203\.0\.113\.19/);
});

test("CLI conflicts preserve the original proxy, IP, secret references, and identity", async () => {
  const dir = home(); await run(dir, ["init"]);
  await create(dir, ["--proxy-url", "http://original.test:8080", "--expected-ip", "203.0.113.19"]);
  const before = files(dir);
  for (const flags of [["--direct"], ["--proxy-url", "http://different.test:8080"], ["--expected-ip", "203.0.113.20"], ["--expected-ip", ""]]) {
    const result = await create(dir, flags);
    expect(result.code).toBe(1);
    expect(result.value).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(files(dir)).toEqual(before);
  }
});

test("existing direct profiles reject requested proxies instead of changing route", async () => {
  const dir = home(); await run(dir, ["init"]); await create(dir);
  const before = files(dir), result = await create(dir, ["--proxy-url", "http://private:password@proxy.test:8080"]);
  expect(result.code).toBe(1); expect(result.value.error.code).toBe("conflict");
  expect(result.err).not.toContain("password"); expect(files(dir)).toEqual(before);
});

test("legacy profiles and unrelated client configuration remain byte-for-byte intact", async () => {
  const dir = home(); mkdirSync(join(dir, "identities/work"), { recursive: true });
  writeFileSync(join(dir, "identities.json"), JSON.stringify({ maxActive: 2, metadata: "keep", identities: [
    { id: "work", port: 19471, mode: "proxy", proxyEnv: "EXISTING_PROXY", expectedIPEnv: "EXISTING_IP" },
  ] }));
  writeFileSync(join(dir, "secrets.env"), "# keep\nEXISTING_PROXY=http://legacy.test:8080\nEXISTING_IP=203.0.113.19\n");
  writeFileSync(join(dir, "client.toml"), 'approval_policy = "on-request"\n');
  const before = files(dir, true);
  const result = await create(dir, ["--proxy-url", "http://legacy.test:8080", "--expected-ip", "203.0.113.19"]);
  expect(result.value).toMatchObject({ ok: true, created: false, profile: { storage: "checkpoint", proxyEnv: "EXISTING_PROXY", expectedIPEnv: "EXISTING_IP" } });
  expect(files(dir, true)).toEqual(before);
  expect(existsSync(join(dir, "profiles.json"))).toBe(false);
  expect(readFileSync(join(dir, "client.toml"), "utf8")).toBe('approval_policy = "on-request"\n');
});

test("parallel CLI creates allocate exactly one profile and one credential reference", async () => {
  const dir = home(); await run(dir, ["init"]);
  const results = await Promise.all(Array.from({ length: 6 }, () => create(dir, ["--proxy-url", "http://same.test:8080"])));
  expect(results.every(result => result.code === 0)).toBe(true);
  expect(results.filter(result => result.value.created)).toHaveLength(1);
  expect(new Set(results.map(result => result.value.profile.port)).size).toBe(1);
  expect(new Set(results.map(result => result.value.profile.proxyEnv)).size).toBe(1);
  expect(JSON.parse(files(dir)[0]!).profiles).toHaveLength(1);
  expect(Object.keys(parseEnv(files(dir)[1]!))).toHaveLength(1);
}, 15000);

test("CLI resumes an interrupted creation using the existing journal", async () => {
  const dir = home(); await run(dir, ["init"]);
  const domain = resolve(import.meta.dir, "../../packages/stelz/src/profiles/profile-configuration.ts");
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", `
import * as fs from 'node:fs'; import { mock } from 'bun:test';
const original = { ...fs };
mock.module('node:fs', () => ({ ...original, renameSync(from, to) {
  original.renameSync(from, to); if (to.endsWith('/secrets.env')) process.exit(23);
}}));
const { ensureProfile } = await import(${JSON.stringify(domain)});
await ensureProfile({ id: 'work', proxyUrl: 'http://recover.test:8080' });`], {
    env: { ...process.env, STELZ_HOME: dir }, stdout: "pipe", stderr: "pipe",
  });
  expect(await child.exited).toBe(23);
  expect(existsSync(join(dir, ".profile-transaction.json"))).toBe(true);
  const result = await create(dir, ["--proxy-url", "http://recover.test:8080"]);
  expect(result.value).toMatchObject({ ok: true, created: false, profile: { id: "work", proxyConfigured: true } });
  expect(existsSync(join(dir, ".profile-transaction.json"))).toBe(false);
  expect(JSON.parse(files(dir)[0]!).profiles).toHaveLength(1);
});

test("missing initialization, malformed inputs, and missing proxy variables fail as JSON", async () => {
  const dir = home();
  expect((await create(dir)).value).toMatchObject({ ok: false, error: { code: "not_initialized" } });
  expect(existsSync(join(dir, "profiles.json"))).toBe(false);
  await run(dir, ["init"]); const before = files(dir);
  for (const flags of [["--proxy-env", "CLI_PROXY"], ["--expected-ip-env", "CLI_IP"], ["--proxy-url", ""], ["--proxy-url", "bad-secret"],
    ["--direct", "--proxy-url", "http://proxy.test:8080"], ["--expected-ip", "bad-ip"], ["--proxy-url"], ["--unknown"], ["--direct", "--direct"]]) {
    const result = await create(dir, flags);
    expect(result.code).toBe(1); expect(result.value.ok).toBe(false);
    expect(result.err).not.toContain("bad-secret"); expect(files(dir)).toEqual(before);
  }
  for (const id of ["all", "../escape", "UPPERCASE"]) expect((await run(dir, ["profile", "create", id, "--json"])).code).toBe(1);
});

test("missing existing proxy credentials and unsafe service files cannot become direct profiles", async () => {
  const dir = home(); await run(dir, ["init"]);
  const first = await create(dir, ["--proxy-url", "http://proxy.test:8080"]), before = files(dir);
  expect((await create(dir, [], { [first.value.profile.proxyEnv]: "" })).value.error.code).toBe("conflict");
  expect(files(dir)).toEqual(before);
  rmSync(join(dir, "secrets.env"));
  const target = join(dir, "outside.env"); writeFileSync(target, before[1]!); symlinkSync(target, join(dir, "secrets.env"));
  expect((await create(dir)).code).toBe(1);
  expect(readFileSync(target, "utf8")).toBe(before[1]);
});

test("conflicting legacy paths fail as JSON before configuration modules can initialize", async () => {
  const dir = home(); await run(dir, ["init"]); const before = files(dir);
  const legacy = '{"identities":[]}\n'; writeFileSync(join(dir, "identities.json"), legacy);
  const result = await create(dir);
  expect(result.code).toBe(1);
  expect(result.value).toMatchObject({ ok: false, error: { code: "profile_unavailable" } });
  expect(files(dir)).toEqual(before);
  expect(readFileSync(join(dir, "identities.json"), "utf8")).toBe(legacy);
});
