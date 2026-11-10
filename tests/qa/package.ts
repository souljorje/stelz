import { installPackage } from "../package/install.ts";
import { packageArguments, assertArchiveUnchanged } from "../../scripts/package-archive.ts";
import { mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { STELZ_VERSION } from "../../src/versions.ts";
import { dedicatedProxyInputs } from "../helpers/dedicated-proxy.ts";
const root = resolve(import.meta.dir, "../..");
const input = packageArguments(process.argv.slice(2), ["--native", "--setup", "--proxy", "--manual", "--windows"]);
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
assertArchiveUnchanged(candidate);
await run([bun, "--no-env-file", join(root, "tests/browser/integration.ts")], { env: { ...cleanEnv, STELZ_TEST_HOME: home, STELZ_TEST_CLI: installedCli }, inherit: true });
const acceptance = { integration: true, native: false, transfer: false, concurrency: false, typing: false, setup: false, windows: false, proxy: false, location: false, manual: false };
const installation = join(home, "installation.json");
writeFileSync(installation, JSON.stringify(installed), { mode: 0o600 });
for (const [flag, script, suite] of [
  ["--native", "tests/browser/native-integration.ts", "native"],
  ["--transfer", "tests/browser/profile-transfer.ts", "transfer"],
  ["--concurrency", "tests/browser/concurrency.ts", "concurrency"],
  ["--typing", "tests/browser/typing-browser.ts", "typing"],
  ["--setup", "tests/package/setup.ts", "setup"],
  ["--windows", "tests/browser/profile-windows-browser.ts", "windows"],
  ["--proxy", "tests/browser/proxy-integration.ts", "proxy"],
  ["--proxy", "tests/package/location.ts", "location"],
  ["--manual", "tests/qa/manual-integration.ts", "manual"],
] as const) {
  // Setup downloads the browser. Foreground window, proxy, and human checks also need their explicit opt-in flags.
  if (["setup", "windows", "proxy", "location", "manual"].includes(suite) && !input.flags.has(flag)) continue;
  assertArchiveUnchanged(candidate);
  await run([bun, "--no-env-file", join(root, script), ...(["setup", "location"].includes(suite) ? ["--archive", archive] : [])], { cwd, env: { ...cleanEnv, STELZ_TEST_CLI: installedCli,
    ...(suite === "concurrency" ? { STELZ_CLI: installedCli } : {}),
    // Suites reuse the prepared runtime. The setup suite must prepare its own.
    ...(suite === "setup" ? {} : { STELZ_TEST_SEED_HOME: home }),
    ...(["setup", "location"].includes(suite) ? { STELZ_TEST_INSTALLATION: installation } : {}),
    ...(["proxy", "location"].includes(suite) && process.env.PROXY_TEST_ENV ? { PROXY_TEST_ENV: process.env.PROXY_TEST_ENV } : {}) }, inherit: true });
  acceptance[suite] = true;
}
// Setup must resolve every dependency from the installed archive, not the source checkout.
function checkLinks(folder: string) {
  for (const name of readdirSync(folder)) {
    const file = join(folder, name), stat = lstatSync(file);
    if (stat.isSymbolicLink()) { if (realpathSync(file).startsWith(root)) throw Error(`Package depends on source checkout: ${file}`); }
    else if (stat.isDirectory()) checkLinks(file);
  }
}
checkLinks(join(home, "runtime"));
assertArchiveUnchanged(candidate);
const evidence = { result: "passed", archive, sha256: candidate.sha256, version, acceptance, nativeCheck, globalPrefix: prefix, cwd, serviceHome: home, bundledUiChecked: uiChecked, harnessExecutablesRequired: false, llmCredentialsProvided: false, runtimeLinksReferToSourceCheckout: false, browserChecks: JSON.parse(readFileSync(join(home, "report.json"), "utf8")) };
mkdirSync(join(root, ".state/package-test"), { recursive: true, mode: 0o700 });
writeFileSync(join(root, ".state/package-test/report.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ result: evidence.result, archive, globalPrefix: prefix, serviceHome: home, cwd }, null, 2));
