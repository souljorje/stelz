import { afterEach, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../.."), homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

async function run(failure = "") {
  const home = mkdtempSync(join(tmpdir(), "stelz-browser-plan-")); homes.push(home);
  mkdirSync(join(home, "scripts")); mkdirSync(join(home, "tests/browser"), { recursive: true });
  // Run the real planner in a disposable project. Only the package commands are fixtures.
  const runner = readFileSync(join(root, "scripts/browser-tests.ts"), "utf8")
    .replace('"../tests/helpers/test-home.ts"', JSON.stringify(join(root, "tests/helpers/test-home.ts")))
    .replace('"../src/versions.ts"', JSON.stringify(join(root, "src/versions.ts")))
    .replace('"./package-archive.ts"', JSON.stringify(join(root, "scripts/package-archive.ts")));
  writeFileSync(join(home, "scripts/browser-tests.ts"), runner);
  copyFileSync(join(root, "tests/browser/suites.yml"), join(home, "tests/browser/suites.yml"));
  writeFileSync(join(home, "package.json"), JSON.stringify({ scripts: {
    pack: "bun fixture.ts pack", "test:setup": "bun fixture.ts setup", "test:location": "bun fixture.ts location",
  } }));
  writeFileSync(join(home, "fixture.ts"), `
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { STELZ_VERSION } from ${JSON.stringify(join(root, "src/versions.ts"))};
const [name, flag, archive] = process.argv.slice(2);
appendFileSync("calls.jsonl", JSON.stringify({ name, flag, archive }) + "\\n");
if (name === "pack") {
  if (process.env.RUNNER_FAILURE === "pack") process.exit(23);
  mkdirSync("release-artifacts");
  writeFileSync("release-artifacts/stelz-" + STELZ_VERSION + ".tgz", "same candidate bytes");
} else {
  if (flag !== "--archive" || readFileSync(archive!, "utf8") !== "same candidate bytes") throw Error("Wrong archive");
  if (name === "setup" && process.env.RUNNER_FAILURE === "mutate") writeFileSync(archive!, "changed");
}
`);
  const child = Bun.spawn([process.execPath, "scripts/browser-tests.ts", "tests/package/setup.ts", "tests/package/location.ts"], {
    cwd: home, env: { ...process.env, STELZ_DRY_RUN: undefined, RUNNER_FAILURE: failure }, stdout: "pipe", stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const calls = readFileSync(join(home, "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  return { code, out, err, calls };
}

test("archive suites receive the same explicitly selected archive after one pack", async () => {
  const result = await run();
  expect(result.code, result.err).toBe(0);
  expect(result.calls.map(call => call.name)).toEqual(["pack", "setup", "location"]);
  expect(result.calls[1].archive).toBe(result.calls[2].archive);
});

test("a failed pack stops the browser runner before package checks", async () => {
  const result = await run("pack");
  expect(result.code).not.toBe(0);
  expect(result.calls.map(call => call.name)).toEqual(["pack"]);
});

test("an archive changed by one suite is refused before the next suite", async () => {
  const result = await run("mutate");
  expect(result.code).not.toBe(0);
  expect(result.err).toContain("The tested release archive changed");
  expect(result.calls.map(call => call.name)).toEqual(["pack", "setup"]);
});
