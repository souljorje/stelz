import { afterEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertTestHome, createTestHome, replaceTestHome } from "../helpers/test-home.ts";

const root = resolve(import.meta.dir, "../.."), directories: string[] = [];
function temporary() { const home = mkdtempSync(join(tmpdir(), "stelz-test-isolation-")); directories.push(home); return home; }
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

test("test homes are fresh private directories with explicit ownership", () => {
  const parent = temporary(), first = createTestHome("profiles", parent), second = createTestHome("profiles", parent);
  expect(first).not.toBe(second);
  expect(assertTestHome(first + "/nested/..")).toBe(realpathSync(first));
  expect(statSync(first).mode & 0o777).toBe(0o700);
  expect(statSync(join(first, ".stelz-test-home.json")).mode & 0o777).toBe(0o600);
  expect(() => createTestHome("../operator", parent)).toThrow();
});

test("a fixed test home replaces an earlier test home and never an unowned directory", () => {
  const parent = temporary(), path = join(parent, "seed"), first = replaceTestHome(path);
  writeFileSync(join(first, "old"), "x");
  expect(replaceTestHome(path)).toBe(first);
  expect(existsSync(join(first, "old"))).toBe(false);
  expect(assertTestHome(first)).toBe(first);
  const operator = join(parent, "operator"); mkdirSync(operator); writeFileSync(join(operator, "profiles.json"), "{}");
  expect(() => replaceTestHome(operator)).toThrow("unowned service directory");
  expect(readdirSync(operator)).toEqual(["profiles.json"]);
});

test("a seed must exist and be a test home", () => {
  const parent = temporary(), operator = join(parent, "operator"); mkdirSync(operator);
  const saved = process.env.STELZ_TEST_SEED_HOME;
  try {
    process.env.STELZ_TEST_SEED_HOME = operator;
    expect(() => createTestHome("seeded", parent)).toThrow("unowned service directory");
    process.env.STELZ_TEST_SEED_HOME = join(parent, "absent");
    expect(() => createTestHome("seeded", parent)).toThrow("The seed home is missing. Run `bun run test:seed`");
  } finally { if (saved === undefined) delete process.env.STELZ_TEST_SEED_HOME; else process.env.STELZ_TEST_SEED_HOME = saved; }
});

test("unowned directories and linked or invalid markers cannot become test homes", () => {
  const parent = temporary(), operator = join(parent, "operator"); mkdirSync(operator);
  const catalog = '{"profiles":[{"id":"identity-01"}]}\n';
  writeFileSync(join(operator, "profiles.json"), catalog);
  expect(() => assertTestHome(operator)).toThrow("unowned service directory");
  const owned = createTestHome("owned", parent), marker = join(operator, ".stelz-test-home.json");
  symlinkSync(join(owned, ".stelz-test-home.json"), marker);
  expect(() => assertTestHome(operator)).toThrow("unowned service directory");
  rmSync(marker); writeFileSync(marker, '{"kind":"operator","version":1}');
  expect(() => assertTestHome(operator)).toThrow("unowned service directory");
  expect(readFileSync(join(operator, "profiles.json"), "utf8")).toBe(catalog);
});

test("the operator's default directory is rejected even if it contains a copied test marker", () => {
  const parent = temporary(), operator = join(parent, ".local/share/stelz"), owned = createTestHome("owned", parent);
  mkdirSync(operator, { recursive: true });
  copyFileSync(join(owned, ".stelz-test-home.json"), join(operator, ".stelz-test-home.json"));
  const alias = join(parent, "alias"); symlinkSync(operator, alias);
  const code = `import { assertTestHome } from ${JSON.stringify(join(root, "tests/helpers/test-home.ts"))};
    try { assertTestHome(${JSON.stringify(alias)}); process.exit(1); } catch { process.exit(0); }`;
  const child = Bun.spawnSync([process.execPath, "--no-env-file", "-e", code], {
    cwd: root, env: { ...process.env, HOME: parent }, stdout: "pipe", stderr: "pipe",
  });
  expect(child.exitCode).toBe(0);
});

test("live test entry points refuse operator profiles before any service operation", () => {
  const home = temporary(), catalog = '{"profiles":[{"id":"identity-01"}]}\n';
  writeFileSync(join(home, "profiles.json"), catalog);
  const before = readdirSync(home);
  for (const [script, args] of [
    ["tests/browser/typing-browser.ts", ["--profile", "identity-01"]],
    ["tests/browser/profile-windows-browser.ts", ["--reuse", join(root, "src/cli/cli.ts"), "identity-01", "identity-02"]],
    ["tests/qa/public-sites.ts", ["--profile", "identity-01"]],
    ["tests/browser/integration.ts", []],
  ] as const) {
    const child = Bun.spawnSync([process.execPath, "--no-env-file", script, ...args], {
      cwd: root, env: { ...process.env, STELZ_HOME: home, STELZ_TEST_HOME: home }, stdout: "pipe", stderr: "pipe",
    });
    expect(child.exitCode).not.toBe(0);
    expect(child.stderr.toString()).toMatch(/Existing profiles are not supported|unowned service directory/);
    expect(readFileSync(join(home, "profiles.json"), "utf8")).toBe(catalog);
    expect(readdirSync(home)).toEqual(before);
    expect(existsSync(join(home, "profiles"))).toBe(false);
  }
});
