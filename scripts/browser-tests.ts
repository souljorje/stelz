import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SEED_HOME } from "../tests/helpers/test-home.ts";
import { STELZ_VERSION } from "../src/versions.ts";
import { archiveSha256, assertArchiveUnchanged } from "./package-archive.ts";

const root = resolve(import.meta.dir, "..");
type Suite = { name: string; glob: string[]; script: string; seed?: boolean; archive?: boolean };
const suites = Bun.YAML.parse(readFileSync(resolve(root, "tests/browser/suites.yml"), "utf8")) as Suite[];
export type BrowserCheck = { script: string; args: string[]; seed?: boolean; archive?: boolean };

/** Share integration browsers with the selected typing and window checks. */
export function browserPlan(files: string[]): BrowserCheck[] {
  const selected = suites.filter(suite => suite.glob.some(pattern => files.some(file => new Bun.Glob(pattern).match(file))));
  const combined = selected.some(suite => suite.name === "integration")
    ? ["typing", "windows"].filter(name => selected.some(suite => suite.name === name)) : [];
  const plan: BrowserCheck[] = [];
  let packed = false;
  if (selected.some(suite => suite.seed)) plan.push({ script: "test:seed", args: [] });
  else if (selected.some(suite => suite.name === "ui")) plan.push({ script: "build", args: [] });
  for (const suite of selected) {
    if (combined.includes(suite.name)) continue;
    if (suite.archive && !packed) { plan.push({ script: "pack", args: [] }); packed = true; }
    plan.push({ script: suite.script, args: suite.name === "integration" ? combined.map(name => `--${name}`) : [], seed: suite.seed, archive: suite.archive });
  }
  return plan;
}

if (import.meta.main) {
  const plan = browserPlan(process.argv.slice(2));
  const archive = resolve(root, "release-artifacts", `stelz-${STELZ_VERSION}.tgz`);
  let candidate: { archive: string; sha256: string } | undefined;
  if (!plan.length) console.log("No browser suites selected.");
  for (const check of plan) {
    const args = ["run", check.script, ...check.args, ...(check.archive ? ["--archive", archive] : [])];
    console.log(`bun ${args.join(" ")}`);
    if (process.env.STELZ_DRY_RUN) continue;
    if (check.archive) {
      if (!candidate) throw Error("Pack the archive before running package checks.");
      assertArchiveUnchanged(candidate);
    }
    const started = performance.now();
    const child = Bun.spawn([process.execPath, ...args], {
      cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit",
      env: { ...process.env, ...(check.seed ? { STELZ_TEST_SEED_HOME: SEED_HOME } : {}) },
    });
    const code = await child.exited;
    console.log(`${check.script}: ${((performance.now() - started) / 1000).toFixed(1)}s, exit ${code}`);
    if (code) process.exit(code);
    if (check.script === "pack") candidate = { archive, sha256: archiveSha256(archive) };
    if (check.archive) assertArchiveUnchanged(candidate!);
  }
}
