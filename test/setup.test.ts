import { afterAll, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(import.meta.dir, ".."), temporary: string[] = [];
const realNode = Bun.which("node")!;
afterAll(() => { for (const path of temporary) rmSync(path, { recursive: true, force: true }); });

function file(path: string, value: string) {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, value);
}
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "stelz-setup-test-")); temporary.push(base);
  const project = join(base, "project"), home = join(base, "home"), browser = join(base, "browser");
  mkdirSync(project); mkdirSync(home);
  cpSync(join(root, "src"), join(project, "src"), { recursive: true });
  file(join(project, "src/setup-driver.ts"), `import { setup } from "./setup.ts";
import { start } from "./runtime.ts";
if (process.argv[2] === "setup") await setup();
else await start(process.argv[3]!);
`);
  file(join(project, "package.json"), JSON.stringify({ type: "module", version: "0.2.0", dependencies: { "@askjo/camofox-browser": "1.18.1", "@modelcontextprotocol/sdk": "1.30.0" } }));
  file(join(project, "dist/plugin.js"), "export function register() {}\nexport function launchIdentityBrowser() {}\nexport function claimIdentityContext() {}\nexport function typeIntoLocator() {}\n");
  const upstream = join(project, "node_modules/@askjo/camofox-browser");
  file(join(upstream, "package.json"), JSON.stringify({ name: "@askjo/camofox-browser", version: "1.18.1", type: "module", dependencies: { "camoufox-js": "0.11.5", "playwright-core": "1.62.1" } }));
  file(join(upstream, "server.js"), `async function fillLocator(locator, text) {
  await locator.fill(text, { timeout: 10000 });
}
const options = { os: hostOS,
        humanize: true, proxy: launchProxy,
        geoip: !!launchProxy, };
async function launch() {
  candidateBrowser = await firefox.launch(options);
  const context = await b.newContext(contextOptions);
}
`);
  file(join(upstream, "LICENSE"), "fixture license");
  file(join(upstream, "lib/camoufox-executable.js"), "if (!existsSync(executableProperties)) ensureSymlink(realpathSync(resourceProperties), executableProperties);\n");
  file(join(upstream, "mcp/server.mjs"), "export {};\n");
  file(join(upstream, "mcp/lib/tool-contracts.mjs"), "export const TOOL_DEFS = [];\nexport function runTool() {}\nexport function adaptResponse() {}\n");
  file(join(upstream, "plugins/persistence/index.js"), "export async function register(app, ctx, pluginConfig = {}) {\n}\n");
  const camoufox = join(project, "node_modules/camoufox-js");
  file(join(camoufox, "package.json"), JSON.stringify({ name: "camoufox-js", version: "0.11.5", dependencies: {} }));
  file(join(camoufox, "dist/utils.js"), 'propFile = path.join(path.dirname(filePath), "properties.json");\n');
  for (const [name, version] of [["playwright-core", "1.62.1"], ["@modelcontextprotocol/sdk", "1.30.0"]]) {
    file(join(project, "node_modules", name!, "package.json"), JSON.stringify({ name, version }));
  }
  file(browser, "browser executable fixture");
  file(join(base, "version.json"), JSON.stringify({ version: "browser-fixture" }));
  const bin = join(base, "bin"), wrapper = join(bin, "node");
  file(wrapper, `#!${process.execPath}
import { existsSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--check" && args[1]?.endsWith("/plugins/local-profile/index.js")) {
  if (process.env.SETUP_TEST_GATE) {
    writeFileSync(process.env.SETUP_TEST_GATE, String(process.pid));
    while (!existsSync(process.env.SETUP_TEST_RELEASE)) await Bun.sleep(10);
  }
  if (process.env.SETUP_TEST_FAIL) { console.error("forced validation failure"); process.exit(1); }
}
const child = Bun.spawn([process.env.SETUP_TEST_REAL_NODE, ...args], { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
process.exit(await child.exited);
`);
  chmodSync(wrapper, 0o755);
  return { base, project, home, browser, upstream, bin, gate: join(base, "gate"), release: join(base, "release") };
}
type Fixture = ReturnType<typeof fixture>;
function legacy(f: Fixture) {
  file(join(f.home, "runtime/camofox-1.18.1/server.js"), "old server");
  file(join(f.home, "runtime/versions.json"), JSON.stringify({ old: "successful manifest" }));
}
function launch(f: Fixture, command = "setup", extra: Record<string, string> = {}) {
  return Bun.spawn([process.execPath, "--no-env-file", join(f.project, "src/setup-driver.ts"), ...command.split(" ")], {
    cwd: f.project, env: { ...process.env, STELZ_HOME: f.home, CAMOUFOX_EXECUTABLE: f.browser, PATH: `${f.bin}:${process.env.PATH}`, SETUP_TEST_REAL_NODE: realNode, ...extra }, stdout: "pipe", stderr: "pipe",
  });
}
async function finish(child: ReturnType<typeof launch>) {
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}
async function until(predicate: () => boolean, description: string) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (predicate()) return; await Bun.sleep(10); }
  throw Error(`Timed out waiting for ${description}`);
}
function oldRuntime(f: Fixture) {
  expect(readFileSync(join(f.home, "runtime/camofox-1.18.1/server.js"), "utf8")).toBe("old server");
  expect(JSON.parse(readFileSync(join(f.home, "runtime/versions.json"), "utf8"))).toEqual({ old: "successful manifest" });
}
function releaseGate(f: Fixture) { file(f.release, "release"); }
function stopGate(f: Fixture) {
  releaseGate(f);
}
const gated = (f: Fixture) => ({ SETUP_TEST_GATE: f.gate, SETUP_TEST_RELEASE: f.release });

test("activates a complete runtime and manifest, including legacy replacement", async () => {
  const f = fixture(); legacy(f);
  for (let i = 0; i < 2; i++) {
    const result = await finish(launch(f));
    if (result.code) throw Error(result.stderr || result.stdout);
    expect(result.code).toBe(0);
    const manifest = JSON.parse(readFileSync(join(f.home, "runtime/versions.json"), "utf8"));
    expect(manifest.upstreamVersion).toBe("1.18.1");
    expect(manifest.browserVersion).toEqual({ version: "browser-fixture" });
    expect(manifest.executableSha256).toHaveLength(64);
    const server = readFileSync(join(f.home, "runtime/camofox-1.18.1/server.js"), "utf8");
    expect(server).toContain("launchIdentityBrowser");
    expect(server).toContain("block_webrtc: !!launchProxy");
    expect(server).toContain("typeIntoLocator(locator, text)");
    expect(existsSync(join(f.home, "runtime/camofox-1.18.1/plugins/local-profile/index.js"))).toBe(true);
  }
  expect(readdirSync(f.home).filter(name => name.startsWith(".runtime-setup-"))).toEqual([]);
}, 30000);

test("validation failure preserves the previous runtime and manifest", async () => {
  const f = fixture(); legacy(f);
  const result = await finish(launch(f, "setup", { SETUP_TEST_FAIL: "1" }));
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("forced validation failure");
  oldRuntime(f);
  expect(readdirSync(f.home).filter(name => name.startsWith(".runtime-setup-"))).toEqual([]);
});

test("missing contract modules or required exports cannot replace the runtime", async () => {
  const contractExports = ["TOOL_DEFS", "runTool", "adaptResponse"];
  const pluginExports = ["register", "launchIdentityBrowser", "claimIdentityContext"];
  const cases = ["missing-contract", ...contractExports.map(name => `contract:${name}`), ...pluginExports.map(name => `plugin:${name}`)];
  for (const item of cases) {
    const f = fixture();
    legacy(f);
    if (item === "missing-contract") rmSync(join(f.upstream, "mcp/lib/tool-contracts.mjs"));
    if (item.startsWith("contract:")) {
      const missing = item.slice("contract:".length);
      const code = contractExports.filter(name => name !== missing).map(name =>
        name === "TOOL_DEFS" ? "export const TOOL_DEFS = [];" : `export function ${name}() {}`,
      ).join("\n");
      file(join(f.upstream, "mcp/lib/tool-contracts.mjs"), code);
    }
    if (item.startsWith("plugin:")) {
      const missing = item.slice("plugin:".length);
      const code = pluginExports.filter(name => name !== missing).map(name => `export function ${name}() {}`).join("\n");
      file(join(f.project, "dist/plugin.js"), code);
    }
    const result = await finish(launch(f));
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/tool-contracts|Invalid Camofox tool contracts|Missing local-profile export/);
    oldRuntime(f);
  }
}, 30000);

test("interruption after staging leaves the previous runtime active and permits retry", async () => {
  const f = fixture(); legacy(f);
  const child = launch(f, "setup", gated(f));
  try {
    await until(() => existsSync(f.gate), "staged validation");
    const stages = readdirSync(f.home).filter(name => name.startsWith(".runtime-setup-"));
    expect(stages).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(f.home, stages[0]!, "versions.json"), "utf8")).upstreamVersion).toBe("1.18.1");
    oldRuntime(f);
    child.kill("SIGKILL");
    await finish(child);
    stopGate(f);
    oldRuntime(f);
    const retried = await finish(launch(f));
    expect(retried.code).toBe(0);
    expect(JSON.parse(readFileSync(join(f.home, "runtime/versions.json"), "utf8")).upstreamVersion).toBe("1.18.1");
  } finally { child.kill("SIGKILL"); stopGate(f); }
}, 30000);

test("interruption during old-runtime cleanup leaves the new runtime complete", async () => {
  const f = fixture(); legacy(f);
  const bulk = join(f.home, "runtime/bulk"); mkdirSync(bulk);
  for (let i = 0; i < 8000; i++) writeFileSync(join(bulk, String(i)), "old");
  const child = launch(f, "setup", gated(f));
  try {
    await until(() => existsSync(f.gate), "staged validation");
    releaseGate(f);
    await until(() => !existsSync(join(f.home, "runtime/bulk")), "atomic activation");
    expect(child.exitCode).toBeNull();
    child.kill("SIGKILL"); await finish(child);
    const manifest = JSON.parse(readFileSync(join(f.home, "runtime/versions.json"), "utf8"));
    expect(manifest.upstreamVersion).toBe("1.18.1");
    expect(readFileSync(join(f.home, "runtime/camofox-1.18.1/server.js"), "utf8")).toContain("launchIdentityBrowser");
    expect(existsSync(join(f.home, "runtime/camofox-1.18.1/plugins/local-profile/index.js"))).toBe(true);
  } finally { child.kill("SIGKILL"); stopGate(f); }
}, 30000);

test("setup serializes with another setup and a real start operation", async () => {
  const f = fixture(); legacy(f);
  const first = launch(f, "setup", gated(f));
  let second: ReturnType<typeof launch> | undefined, start: ReturnType<typeof launch> | undefined;
  try {
    await until(() => existsSync(f.gate), "first setup");
    second = launch(f); start = launch(f, "start identity-02");
    await Bun.sleep(250);
    expect(second.exitCode).toBeNull();
    expect(start.exitCode).toBeNull();
    expect(existsSync(join(f.home, "identities/identity-02/running.json"))).toBe(false);
    expect(readdirSync(f.home).filter(name => name.startsWith(".runtime-setup-"))).toHaveLength(1);
    oldRuntime(f);
    start.kill("SIGKILL"); await finish(start);
    releaseGate(f);
    expect((await finish(first)).code).toBe(0);
    expect((await finish(second)).code).toBe(0);
    expect(JSON.parse(readFileSync(join(f.home, "runtime/versions.json"), "utf8")).upstreamVersion).toBe("1.18.1");
  } finally { first.kill("SIGKILL"); second?.kill("SIGKILL"); start?.kill("SIGKILL"); stopGate(f); }
}, 30000);

test("simultaneous first setups initialize and activate safely", async () => {
  const f = fixture();
  const first = launch(f);
  const second = launch(f);
  const results = await Promise.all([finish(first), finish(second)]);
  for (const result of results) {
    if (result.code) throw Error(result.stderr || result.stdout);
    expect(result.code).toBe(0);
  }
  expect(JSON.parse(readFileSync(join(f.home, "runtime/versions.json"), "utf8")).upstreamVersion).toBe("1.18.1");
}, 30000);

test("active, orphaned, unclean, and malformed identity records block setup", async () => {
  for (const [id, value] of [
    ["identity-02", { pid: process.pid, instanceId: "live" }],
    ["removed-identity", { pid: 99999999, serverPid: process.pid, instanceId: "orphan" }],
    ["identity-01", { pid: 99999999, instanceId: "unclean" }],
    ["identity-01", { pid: 0, instanceId: "reservation" }],
    ["identity-01", null],
  ] as const) {
    const f = fixture(); legacy(f);
    file(join(f.home, "identities", id, "running.json"), JSON.stringify(value));
    const result = await finish(launch(f));
    expect(result.code).not.toBe(0);
    oldRuntime(f);
  }
});

test("setup rechecks identities after obtaining the shared admission lock", async () => {
  const f = fixture(); legacy(f);
  const state = join(f.home, "identities"), held = join(f.base, "held"), release = join(f.base, "unlock");
  mkdirSync(state, { recursive: true });
  const code = `import { lock } from ${JSON.stringify(join(f.project, "src/runtime.ts"))};
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
await lock(${JSON.stringify(join(state, "admission.lock"))}, async () => {
  writeFileSync(${JSON.stringify(held)}, "held");
  while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(10);
  mkdirSync(${JSON.stringify(join(state, "identity-02"))}, { recursive: true });
  writeFileSync(${JSON.stringify(join(state, "identity-02/running.json"))}, JSON.stringify({ pid: ${process.pid}, instanceId: "started" }));
});`;
  const holder = Bun.spawn([process.execPath, "-e", code], { cwd: f.project, env: { ...process.env, STELZ_HOME: f.home }, stdout: "pipe", stderr: "pipe" });
  let setup: ReturnType<typeof launch> | undefined;
  try {
    await until(() => existsSync(held), "startup admission lock");
    setup = launch(f);
    await Bun.sleep(200);
    expect(setup.exitCode).toBeNull();
    file(release, "release"); await holder.exited;
    expect((await finish(setup)).code).not.toBe(0);
    oldRuntime(f);
  } finally { file(release, "release"); holder.kill("SIGKILL"); setup?.kill("SIGKILL"); }
});

test("a clean stopped record permits setup, but a matching marker cannot hide a live server", async () => {
  for (const live of [false, true]) {
    const f = fixture();
    legacy(f);
    const base = join(f.home, "identities/identity-02");
    file(join(base, "running.json"), JSON.stringify({ pid: 99999999, serverPid: live ? process.pid : undefined, instanceId: "clean" }));
    file(join(base, "stopped.json"), JSON.stringify({ instanceId: "clean" }));
    const result = await finish(launch(f));
    if (live) {
      expect(result.code).not.toBe(0);
      oldRuntime(f);
    } else {
      if (result.code) throw Error(result.stderr || result.stdout);
      expect(result.code).toBe(0);
    }
  }
});

test("symlinks in runtime, lock, identity state, and setup sources cannot be followed", async () => {
  for (const kind of ["runtime", "lock", "hardlock", "identity", "source"] as const) {
    const f = fixture(), outside = join(f.base, "outside");
    file(outside, "untouched");
    if (kind === "runtime") symlinkSync(f.base, join(f.home, "runtime"));
    if (kind === "lock") { mkdirSync(join(f.home, "identities")); symlinkSync(outside, join(f.home, "identities/admission.lock")); }
    if (kind === "hardlock") { mkdirSync(join(f.home, "identities")); linkSync(outside, join(f.home, "identities/admission.lock")); }
    if (kind === "identity") { mkdirSync(join(f.home, "identities/identity-01"), { recursive: true }); symlinkSync(outside, join(f.home, "identities/identity-01/running.json")); }
    if (kind === "source") { legacy(f); symlinkSync(outside, join(f.upstream, "lib/unsafe.js")); }
    const result = await finish(launch(f));
    expect(result.code).not.toBe(0);
    expect(readFileSync(outside, "utf8")).toBe("untouched");
    if (kind === "source") oldRuntime(f);
  }
});
