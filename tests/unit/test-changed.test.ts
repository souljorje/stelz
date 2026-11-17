import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const runner = resolve(import.meta.dir, "../../scripts/test-changed.ts");
test.each(["unstaged", "staged", "untracked", "base", "deleted", "config", "docs", "failure", "clean", "invalid-base"])(
  "affected selection: %s", async kind => {
    const cwd = mkdtempSync(join(tmpdir(), "stelz-changed-")), output = join(cwd, "executed");
    const file = (path: string, content: string) => { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), content); };
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
      if (result.exitCode) throw Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };
    const commit = () => { git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture"); };
    function sample(name: string, imports = "", fails = false) {
      file(`tests/unit/${name}.test.ts`, `${imports}\nimport { test, expect } from 'bun:test';
import { appendFileSync } from 'node:fs';
test('${name}', () => { appendFileSync(process.env.SELECTOR_OUTPUT!, '${name}\\n'); expect(${fails}).toBe(false); });`);
    }
    try {
      git("init", "-q");
      file(".gitignore", "executed\n");
      file("src/leaf.ts", "export const value = 1;\n");
      file("src/middle.ts", "export { value } from './leaf.ts';\n");
      file("docs/mcp.md", "original\n");
      sample("related", "import { value } from '../../src/middle.ts'; void value;");
      sample("config", "import { value } from '../../src/leaf.ts'; void value;");
      sample("profile-cli"); // A subprocess dependency has no import edge.
      sample("unrelated"); sample("mcp-docs");
      commit();
      const base = git("rev-parse", "HEAD");
      if (["unstaged", "staged", "base", "failure"].includes(kind)) appendFileSync(join(cwd, "src/leaf.ts"), "// changed\n");
      if (kind === "staged") git("add", "src/leaf.ts");
      if (kind === "base") commit();
      if (kind === "deleted") rmSync(join(cwd, "src/leaf.ts"));
      if (kind === "config") file("package.json", "{}\n");
      if (kind === "docs") file("docs/mcp.md", "changed\n");
      if (kind === "untracked") sample("new");
      if (kind === "failure") sample("profile-cli", "", true);
      const child = Bun.spawn([process.execPath, runner, ...(["base", "invalid-base"].includes(kind) ? ["--base", kind === "base" ? base : "no-such-ref"] : [])],
        { cwd, env: { ...process.env, STELZ_TEST_BASE: "HEAD", SELECTOR_OUTPUT: output }, stdout: "pipe", stderr: "pipe" });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      const ran = (() => { try { return readFileSync(output, "utf8").trim().split("\n").sort(); } catch { return []; } })();
      // Deletion runs the full suite and must expose the now-broken imports.
      expect(code, out + err).toBe(["deleted", "failure", "invalid-base"].includes(kind) ? 1 : 0);
      if (["unstaged", "staged", "base", "failure"].includes(kind)) expect(ran).toEqual(["config", "profile-cli", "related"]);
      else if (kind === "config") expect(ran).toEqual(["config", "mcp-docs", "profile-cli", "related", "unrelated"]);
      else if (kind === "docs") expect(ran).toEqual(["mcp-docs"]);
      else if (kind === "untracked") expect(ran).toEqual(["new"]);
      else if (kind === "deleted") expect(out).toContain("Full suite:");
      else expect(ran).toEqual([]);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  }, 15_000,
);
