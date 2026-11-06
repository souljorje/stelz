import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { STELZ_VERSION } from "../../src/versions.ts";

test("unbuilt source resolves the package and supervisor from an empty cwd", () => {
  const temp = mkdtempSync(join(tmpdir(), "stelz-source-paths-"));
  try {
    const product = join(realpathSync(temp), "product"), cwd = join(temp, "empty"), home = join(realpathSync(temp), "home");
    mkdirSync(cwd); mkdirSync(product);
    cpSync(resolve(import.meta.dir, "../../src"), join(product, "src"), { recursive: true });
    cpSync(resolve(import.meta.dir, "../../package.json"), join(product, "package.json"));
    const driver = join(product, "src/paths-driver.ts");
    writeFileSync(driver, `import { ROOT, entry, HOME_DIR } from "./profiles/config.ts";
import { STELZ_VERSION } from "./versions.ts";
console.log(JSON.stringify({ root: ROOT, home: HOME_DIR, supervisor: entry("supervisor"), cli: entry("cli"), version: STELZ_VERSION }));`);
    const result = Bun.spawnSync([process.execPath, "--no-env-file", driver], { cwd, env: { ...process.env, STELZ_HOME: home } });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({ root: product + "/", home, supervisor: join(product, "src/runtime/supervisor.ts"), cli: join(product, "src/cli/cli.ts"), version: STELZ_VERSION });
    mkdirSync(home);
    writeFileSync(join(home, "profiles.json"), JSON.stringify({ profiles: [{ id: "source", port: 9876 }] }));
    const supervisor = Bun.spawnSync([process.execPath, "--no-env-file", JSON.parse(result.stdout.toString()).supervisor, "source"], { cwd, env: { ...process.env, STELZ_HOME: home } });
    expect(supervisor.exitCode).not.toBe(0);
    expect(supervisor.stderr.toString()).toContain("A supervisor requires a reserved service instance.");
    // Bundled entry names retain their public artifact paths.
    mkdirSync(join(product, "dist")); writeFileSync(join(product, "dist/supervisor.js"), "");
    const built = Bun.spawnSync([process.execPath, "--no-env-file", driver], { cwd });
    expect(built.exitCode).toBe(0);
    expect(JSON.parse(built.stdout.toString()).supervisor).toBe(join(product, "dist/supervisor.js"));
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("UI contract can bundle for a browser without server dependencies", async () => {
  const contract = resolve(import.meta.dir, "../../src/api/contracts.ts");
  const result = await Bun.build({ entrypoints: [contract], target: "browser" });
  expect(result.success).toBe(true);
  const code = await result.outputs[0]!.text();
  expect(code).not.toMatch(/(?:node:|bun:|process\.env|require\()/);
});
