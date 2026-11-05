import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { releaseArguments, inspectReleaseCandidate, assertCandidateUnchanged } from "../../scripts/release-candidate.ts";
import { validatePublication } from "../../scripts/check-publication.ts";

test("candidate acceptance accepts an explicit archive and rejects ambiguous arguments", () => {
  expect(releaseArguments(["--archive", "candidate.tgz", "--native"], ["--native"]).flags.has("--native")).toBe(true);
  for (const args of [["--archive"], ["--native", "--native"], ["--other"], ["--archive", "a", "--archive", "b"]])
    expect(() => releaseArguments(args, ["--native"])).toThrow();
});

test("candidate inspection records exact bytes and detects replacement after acceptance", () => {
  const home = mkdtempSync(join(tmpdir(), "stelz-candidate-test-"));
  try {
    const files = ["node_modules/@askjo/camofox-browser/package.json", "node_modules/@askjo/camofox-browser/server.js",
      "node_modules/@askjo/camofox-browser/plugins/persistence/index.js", "node_modules/camoufox-js/package.json", "node_modules/camoufox-js/dist/utils.js"];
    for (const path of files) { const file = join(home, "package", path); mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, "{}"); }
    writeFileSync(join(home, "package/package.json"), JSON.stringify({ name: "stelz", version: "0.2.0", license: "MIT" }));
    writeFileSync(join(home, "package/LICENSE"), "MIT License\n");
    const archive = join(home, "candidate.tgz"), packed = Bun.spawnSync(["tar", "-czf", archive, "-C", home, "package"]);
    expect(packed.exitCode).toBe(0);
    const candidate = inspectReleaseCandidate(archive);
    expect(candidate.sha256).toMatch(/^[a-f\d]{64}$/);
    expect(() => assertCandidateUnchanged(candidate)).not.toThrow();
    appendFileSync(archive, "changed after testing");
    expect(() => assertCandidateUnchanged(candidate)).toThrow("changed");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("publication requires the exact candidate and every supported-platform acceptance gate", () => {
  const sha256 = "a".repeat(64), candidate = { sha256, manifest: { version: "0.2.0" } };
  const input = { version: "0.2.0", sha256, run: "123", tag: "latest" };
  const evidence = { version: "0.2.0", sha256, candidateRunId: "123", candidateSourceCommit: "b".repeat(40),
    platform: "darwin", arch: "arm64", result: "passed", checks: { integration: true, native: true, proxy: true, manual: true, ui: true } };
  expect(() => validatePublication(candidate, evidence, input)).not.toThrow();
  for (const key of ["integration", "native", "proxy", "manual", "ui"] as const)
    expect(() => validatePublication(candidate, { ...evidence, checks: { ...evidence.checks, [key]: false } }, input)).toThrow("Complete macOS");
  expect(() => validatePublication(candidate, evidence, { ...input, sha256: "c".repeat(64) })).toThrow("does not match");
  expect(() => validatePublication(candidate, { ...evidence, candidateRunId: "456" }, input)).toThrow("does not match");
  expect(() => validatePublication(candidate, { ...evidence, platform: "linux" }, input)).toThrow("Complete macOS");
  expect(() => validatePublication(candidate, evidence, { ...input, version: "../../wrong" })).toThrow("Supply");
});
