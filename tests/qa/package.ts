import { installPackage } from "./install.ts";
import { nativeSmoke } from "../helpers/native-dependencies.ts";
import { packageArguments, assertArchiveUnchanged } from "../../scripts/package-archive.ts";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { STELZ_VERSION } from "../../src/versions.ts";
import { dedicatedProxyInputs } from "../helpers/dedicated-proxy.ts";
const root = resolve(import.meta.dir, "../..");
const input = packageArguments(process.argv.slice(2), ["--setup", "--proxy", "--human", "--windows"]);
if (input.flags.has("--proxy")) dedicatedProxyInputs(process.env.PROXY_TEST_ENV, "acceptance");
const archive = input.archive ?? join(root, "release-artifacts", `stelz-${STELZ_VERSION}.tgz`);
const installed = await installPackage(archive, { native: true, keep: true });
const { candidate, env: installedEnv, cwd, home, prefix, bun, executable, installedCli, version, nativeCheck, uiChecked } = installed;
// The official CLI installs the browser in a versioned directory, not at the default path.
const cleanEnv = process.env.CAMOUFOX_EXECUTABLE ? { ...installedEnv, CAMOUFOX_EXECUTABLE: process.env.CAMOUFOX_EXECUTABLE } : installedEnv;
async function run(args: string[], options: { cwd?: string; env?: Record<string, string>; inherit?: boolean } = {}) {
  const child = Bun.spawn(args, { cwd: options.cwd ?? cwd, env: options.env ?? cleanEnv, stdout: options.inherit ? "inherit" : "pipe", stderr: options.inherit ? "inherit" : "pipe" });
  if (options.inherit) { if (await child.exited) throw Error(args[0] + " failed."); return ""; }
  const [code, out, error] = await Promise.all([child.exited, new Response(child.stdout as ReadableStream).text(), new Response(child.stderr as ReadableStream).text()]);
  if (code) throw Error(error || out); return out;
}
await run([executable, "setup", "--yes"]);
const versions = JSON.parse(readFileSync(join(home, "runtime/versions.json"), "utf8"));
const runtimeNativeCheck = await nativeSmoke(installed.node, join(prefix, "lib/node_modules/stelz"), {
  cwd, env: cleanEnv, stagedServer: join(home, "runtime", "camofox-" + versions.upstreamVersion),
});
assertArchiveUnchanged(candidate);
await run([bun, "--no-env-file", join(root, "tests/browser/smoke.ts"), ...(input.flags.has("--windows") ? ["--windows"] : [])],
  { env: { ...cleanEnv, STELZ_TEST_HOME: home, STELZ_TEST_CLI: installedCli }, inherit: true });
const acceptance = { browser: true, setup: false, windows: input.flags.has("--windows"), proxy: false, human: false };
const installation = join(home, "installation.json");
writeFileSync(installation, JSON.stringify(installed), { mode: 0o600 });
for (const [flag, script, suite] of [
  ["--setup", "tests/qa/setup.ts", "setup"],
  ["--proxy", "tests/qa/proxy.ts", "proxy"],
  ["--human", "tests/qa/human.ts", "human"],
] as const) {
  // Setup, proxy, and human checks need their explicit opt-in flags.
  if (!input.flags.has(flag)) continue;
  assertArchiveUnchanged(candidate);
  await run([bun, "--no-env-file", join(root, script), ...(suite === "setup" ? ["--archive", archive] : [])], { cwd, env: { ...cleanEnv, STELZ_TEST_CLI: installedCli,
    // Suites reuse the prepared runtime. The setup suite must prepare its own.
    ...(suite === "setup" ? { STELZ_TEST_INSTALLATION: installation } : { STELZ_TEST_SEED_HOME: home }),
    ...(suite === "proxy" && process.env.PROXY_TEST_ENV ? { PROXY_TEST_ENV: process.env.PROXY_TEST_ENV } : {}) }, inherit: true });
  acceptance[suite] = true;
}
// Setup must resolve every dependency from the installed archive, not the source checkout.
function checkLinks(folder: string) {
  for (const name of readdirSync(folder)) {
    const file = join(folder, name), stat = lstatSync(file);
    if (stat.isSymbolicLink()) { if (!realpathSync(file).startsWith(realpathSync(prefix) + "/")) throw Error(`Runtime dependency escaped the installed prefix: ${file}`); }
    else if (stat.isDirectory()) checkLinks(file);
  }
}
checkLinks(join(home, "runtime"));
assertArchiveUnchanged(candidate);
const evidence = { result: "passed", archive, sha256: candidate.sha256, version, acceptance, nativeCheck, runtimeNativeCheck, globalPrefix: prefix, cwd, serviceHome: home, bundledUiChecked: uiChecked, harnessExecutablesRequired: false, llmCredentialsProvided: false, runtimeLinksReferToSourceCheckout: false, browserChecks: JSON.parse(readFileSync(join(home, "report.json"), "utf8")) };
const reportDir = mkdtempSync(join(tmpdir(), "stelz-package-test-"));
writeFileSync(join(reportDir, "report.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ result: evidence.result, archive, globalPrefix: prefix, serviceHome: home, cwd }, null, 2));
console.log("Report: " + join(reportDir, "report.json"));
