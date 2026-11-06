import { installPackage } from "../package/install.ts";
import { packageArguments, assertArchiveUnchanged } from "../../scripts/package-archive.ts";
import { mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { STELZ_VERSION } from "../../src/versions.ts";
const root = resolve(import.meta.dir, "../..");
const input = packageArguments(process.argv.slice(2), ["--native", "--proxy", "--manual"]);
const archive = input.archive ?? join(root, "release-artifacts", `stelz-${STELZ_VERSION}.tgz`);
const { candidate, env: cleanEnv, cwd, home, prefix, node, bun, executable, installedCli, version, nativeCheck, uiChecked } = await installPackage(archive, { native: true, keep: true });
async function run(args: string[], options: { cwd?: string; env?: Record<string, string>; inherit?: boolean } = {}) {
  const child = Bun.spawn(args, { cwd: options.cwd ?? cwd, env: options.env ?? cleanEnv, stdout: options.inherit ? "inherit" : "pipe", stderr: options.inherit ? "inherit" : "pipe" });
  if (options.inherit) { if (await child.exited) throw Error(args[0] + " failed."); return ""; }
  const [code, out, error] = await Promise.all([child.exited, new Response(child.stdout as ReadableStream).text(), new Response(child.stderr as ReadableStream).text()]);
  if (code) throw Error(error || out); return out;
}
await run([executable, "setup"]);
await run([bun, join(root, "tests/browser/integration.ts")], { env: { ...cleanEnv, STELZ_TEST_HOME: home, STELZ_TEST_CLI: installedCli }, inherit: true });
const acceptance = { integration: true, native: false, transfer: false, proxy: false, manual: false };
for (const [flag, script, suite] of [
  ["--native", "tests/browser/native-integration.ts", "native"],
  ["--transfer", "tests/browser/profile-transfer.ts", "transfer"],
  ["--proxy", "tests/browser/proxy-integration.ts", "proxy"],
  ["--manual", "tests/qa/manual-integration.ts", "manual"],
] as const) {
  if (suite !== "native" && suite !== "transfer" && !input.flags.has(flag)) continue;
  assertArchiveUnchanged(candidate);
  await run([bun, "--no-env-file", join(root, script)], { cwd, env: { ...cleanEnv, STELZ_TEST_CLI: installedCli,
    ...(suite === "proxy" && process.env.PROXY_TEST_ENV ? { PROXY_TEST_ENV: process.env.PROXY_TEST_ENV } : {}) }, inherit: true });
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
