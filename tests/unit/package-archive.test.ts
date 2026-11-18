import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { packageArguments, inspectPackageArchive, assertArchiveUnchanged } from "../../scripts/package-archive.ts";
import { inspectBundledDependencies } from "../../scripts/bundled-dependencies.ts";

test("package installation accepts an explicit archive and rejects ambiguous arguments", () => {
  expect(packageArguments(["--archive", "candidate.tgz", "--native"], ["--native"]).flags.has("--native")).toBe(true);
  for (const args of [["--archive"], ["--native", "--native"], ["--other"], ["--archive", "a", "--archive", "b"]])
    expect(() => packageArguments(args, ["--native"])).toThrow();
});

test("package inspection records exact bytes and detects replacement after acceptance", () => {
  const home = mkdtempSync(join(tmpdir(), "stelz-candidate-test-"));
  try {
    const files = ["node_modules/@askjo/camofox-browser/package.json", "node_modules/@askjo/camofox-browser/server.js",
      "node_modules/@askjo/camofox-browser/plugins/persistence/index.js"];
    for (const path of files) { const file = join(home, "package", path); mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, "{}"); }
    for (const [path, source] of Object.entries(inspectBundledDependencies(resolve(import.meta.dir, "../.."))))
      writeFileSync(join(home, "package/node_modules", path), source);
    const archive = join(home, "candidate.tgz"), packed = Bun.spawnSync(["tar", "-czf", archive, "-C", home, "package"]);
    expect(packed.exitCode).toBe(0);
    const candidate = inspectPackageArchive(archive);
    expect(candidate.sha256).toMatch(/^[a-f\d]{64}$/);
    expect(() => assertArchiveUnchanged(candidate)).not.toThrow();
    appendFileSync(archive, "changed after testing");
    expect(() => assertArchiveUnchanged(candidate)).toThrow("changed");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
