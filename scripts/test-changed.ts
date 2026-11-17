import { existsSync } from "node:fs";

// Bun cannot trace source loaded by a subprocess or copied into a fixture package.
// Keep these tests whenever src/ changes. Each test runs once, outside Bun's import selection.
const subprocessTests = [
  "catalog-limits", "config", "dedicated-proxy", "fingerprint-transfer", "ip-configuration",
  "lifecycle", "location-preflight", "package-archive", "paths", "profile-cli", "profile-concurrency",
  "profile-configuration", "profile-fingerprint-cli", "profile-import", "profile-interface",
  "profile-rename", "profile-transfer-cli", "profile-transfer-diagnostics-cli", "setup",
  "startup-gateway", "typing", "ui-model",
];

function git(...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw Error(result.stderr.toString().trim() || "Cannot read the Git diff.");
  return result.stdout.toString();
}
const paths = (value: string) => value.split("\0").filter(Boolean);

export function changedTestCommands(ref = "HEAD") {
  const base = git("merge-base", "HEAD", ref).trim();
  const changed = [...new Set([
    ...paths(git("diff", "--name-only", "--no-renames", "-z", base, "--")),
    ...paths(git("ls-files", "--others", "--exclude-standard", "-z")),
  ])];
  if (!changed.length) return { reason: "No changed files.", commands: [] };
  const deleted = paths(git("diff", "--name-only", "--diff-filter=D", "--no-renames", "-z", base, "--"));
  // Configuration, dependencies, shared fixtures, and unknown inputs affect the whole suite.
  const broad = changed.filter(path => !/^(src\/|ui\/|tests\/(unit|browser|qa)\/|docs\/|skills\/|\.changeset\/|(?:README|CONTRIBUTING|AGENTS)\.md$|LICENSE$)/.test(path));
  if (deleted.length || broad.length) return {
    reason: `Full suite: ${[...new Set([...deleted, ...broad])].join(", ")}`,
    commands: [["test", "--parallel", "./tests/unit"]],
  };
  const extra = new Set<string>();
  if (changed.some(path => path.startsWith("src/"))) for (const name of subprocessTests) extra.add(name);
  if (changed.includes("docs/mcp.md")) extra.add("mcp-docs");
  if (changed.some(path => path.startsWith("tests/qa/"))) extra.add("dedicated-proxy");
  const names = [...extra].filter(name => existsSync(`tests/unit/${name}.test.ts`)).sort();
  const selected = ["test", "--parallel", `--changed=${base}`, "--pass-with-no-tests"];
  if (names.length) selected.push(`--path-ignore-patterns=**/${names.length === 1 ? names[0] : `{${names.join(",")}}`}.test.ts`);
  selected.push("./tests/unit");
  return { reason: `Import selection from ${base.slice(0, 8)}${names.length ? `, plus ${names.length} tests with external dependencies` : ""}.`,
    commands: [selected, ...(names.length ? [["test", "--parallel", ...names.map(name => `./tests/unit/${name}.test.ts`)]] : [])] };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--base" || !args[1] || args[1].startsWith("-")))
    throw Error("Use: bun run test:changed [--base REF]");
  const plan = changedTestCommands(args[1] ?? process.env.STELZ_TEST_BASE ?? "HEAD");
  console.log(plan.reason);
  // The two groups are disjoint. Run sequentially so each Bun runner can use all available workers.
  let failed = false;
  for (const command of plan.commands) {
    const child = Bun.spawn([process.execPath, ...command], { stdout: "inherit", stderr: "inherit" });
    if (await child.exited) failed = true;
  }
  process.exitCode = failed ? 1 : 0;
}
