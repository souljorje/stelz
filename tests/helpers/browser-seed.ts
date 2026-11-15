// Prepare the one runtime that a browser run shares. lefthook.yml gives its path to every suite as STELZ_TEST_SEED_HOME.
// Each run replaces the earlier one first, because the patch, the plugin, or the dependencies can change.
// A failed step leaves no seed, so the suites fail at once and never clone an old runtime.
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { replaceTestHome } from "./test-home.ts";

const root = resolve(import.meta.dir, "../..");
const home = replaceTestHome(join(root, ".state/browser-seed"));
const env: Record<string, string> = { STELZ_HOME: home };
for (const key of ["PATH", "HOME", "LANG", "TMPDIR", "CAMOUFOX_EXECUTABLE"]) if (process.env[key]) env[key] = process.env[key]!;
function run(args: string[], options: { env?: Record<string, string> } = {}) {
  const { exitCode } = Bun.spawnSync([process.execPath, ...args], { cwd: root, ...options, stdout: "inherit", stderr: "inherit" });
  if (exitCode) throw Error(`bun ${args.join(" ")} failed with exit code ${exitCode}.`);
}
try {
  // Setup stages the built plugin, so the build comes first.
  run(["run", "build"]);
  run(["--no-env-file", join(root, "src/cli/cli.ts"), "setup", "--yes"], { env });
} catch (error) {
  rmSync(home, { recursive: true, force: true });
  console.error((error as Error).message);
  process.exit(1);
}
console.log(`Prepared the browser run runtime: ${home}`);
