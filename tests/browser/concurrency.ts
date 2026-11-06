// Explicit browser acceptance in a disposable home. Existing service profiles are never selected.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fixture } from "../helpers/fixture.ts";
import { routeProfileTools } from "../helpers/mcp-client.ts";
import { processStart, type Running } from "../../src/runtime/profile-process.ts";

const root = resolve(import.meta.dir, "../.."), cli = process.env.STELZ_CLI || process.env.STELZ_TEST_CLI || join(root, "dist/cli.js");
const home = mkdtempSync(join(tmpdir(), "stelz-browser-concurrency-"));
const ids = ["concurrency-01", "concurrency-02", "concurrency-03"];
const env: Record<string, string> = { STELZ_HOME: home };
for (const key of ["PATH", "HOME", "LANG", "TMPDIR", "CAMOUFOX_EXECUTABLE"]) if (process.env[key]) env[key] = process.env[key]!;
const clients = new Set<Client>(), started = new Set<string>();
const records = new Map<string, Running>(), tabs = new Map<string, string>();
type BrowserProcess = { pid: number; start: string };
const report = { result: "incomplete", home, startedAt: new Date().toISOString(), completedAt: "", profiles: ids,
  lifetimes: {} as Record<string, Running>, browserProcesses: {} as Record<string, BrowserProcess[]>,
  restartedLifetimes: {} as Record<string, Running>,
  checks: [] as string[], errors: [] as string[], cleanedUp: false };
let site: Awaited<ReturnType<typeof fixture>> | undefined;
function assert(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
const record = (id: string): Running => JSON.parse(readFileSync(join(home, "profiles", id, "running.json"), "utf8"));
function confirmedExit(pid: number) {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
function exited(value: BrowserProcess) {
  const current = processStart(value.pid);
  return current === undefined ? confirmedExit(value.pid) : current !== value.start;
}
function observeBrowserProcesses(id: string, lifetime: Running) {
  const server = lifetime.serverPid;
  assert(server && lifetime.serverStart && processStart(server) === lifetime.serverStart, `${id}: server ownership is unavailable`);
  const result = Bun.spawnSync(["ps", "-axo", "pid=,ppid="], { stdout: "pipe", stderr: "pipe" });
  assert(result.exitCode === 0, `${id}: cannot inspect browser subprocesses`);
  const processes = result.stdout.toString().trim().split("\n").map(line => line.trim().split(/\s+/).map(Number));
  const descendants = new Set<number>(), parents = [server];
  for (let index = 0; index < parents.length; index++) {
    for (const [pid, parent] of processes) {
      if (pid! > 1 && parent === parents[index] && !descendants.has(pid!)) {
        descendants.add(pid!); parents.push(pid!);
      }
    }
  }
  assert(processStart(server) === lifetime.serverStart, `${id}: server changed during process inspection`);
  const observed = [...descendants].flatMap(pid => {
    const start = processStart(pid);
    assert(start || confirmedExit(pid), `${id}: browser subprocess ${pid} has unverifiable ownership`);
    return start ? [{ pid, start }] : [];
  });
  assert(observed.length > 0, `${id}: no live browser subprocesses were observed`);
  const known = new Map((report.browserProcesses[id] ?? []).map(value => [`${value.pid}:${value.start}`, value]));
  for (const value of observed) known.set(`${value.pid}:${value.start}`, value);
  report.browserProcesses[id] = [...known.values()];
}
async function verifyBrowserProcessesExited(id: string) {
  const tracked = report.browserProcesses[id] ?? [];
  for (let attempt = 0; attempt < 100; attempt++) {
    const live = tracked.filter(value => !exited(value));
    if (!live.length) return;
    if (attempt === 99) throw Error(`${id}: browser subprocesses remain live or unverifiable: ${live.map(value => value.pid).join(", ")}`);
    await Bun.sleep(50);
  }
}
async function command(...args: string[]) {
  const child = Bun.spawn([process.execPath, "--no-env-file", cli, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGTERM"), 150000);
  try {
    const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code) throw Error(`${args.join(" ")}: ${error || out}`);
    return out;
  } finally { clearTimeout(timer); }
}
async function connect() {
  const client = routeProfileTools(new Client({ name: "concurrency-acceptance", version: "1.0.0" })); clients.add(client);
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--no-env-file", cli, "mcp"], env }));
  return client;
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
  const text = (result.content as { type: string; text?: string }[]).filter(block => block.type === "text").map(block => block.text).join("\n");
  if (result.isError) throw Error(text);
  return JSON.parse(text) as Record<string, unknown>;
}
async function storage(capture: string, expected: string | null) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const observation = site?.observations.get(capture);
    if (observation) {
      const value = observation.storage as { cookie: string; localStorage: string | null; indexedDB: string | null };
      assert(value.localStorage === expected && value.indexedDB === expected, `${capture}: storage crossed profiles`);
      const cookie = value.cookie.split(";").map(part => part.trim()).find(part => part.startsWith("profile="));
      assert(expected === null ? cookie === undefined : cookie === `profile=${expected}`, `${capture}: cookie crossed profiles`);
      return;
    }
    await Bun.sleep(50);
  }
  throw Error(`${capture}: no browser storage observation`);
}
try {
  console.log(`Three native browsers, local fixture only. Temporary home: ${home}`);
  await command("init");
  await command("setup"); site = await fixture(0);
  const client = await connect(), schemas = JSON.stringify((await client.listTools()).tools);
  assert(JSON.stringify((await call(client, "profile_list")).profiles) === "[]", "Catalog is not empty at connection startup");
  const handles = new Map<string, string>();
  for (const id of ids) {
    if (id === ids[2]) await command("profile", "create", id, "--direct");
    else await call(client, "profile_create", { profileId: id });
    assert(JSON.stringify((await call(client, "profile_list")).profiles).includes(id), `${id}: not discovered by the open connection`);
    started.add(id);
    await call(client, "profile_start", { profileId: id });
    const value = record(id); records.set(id, value); report.lifetimes[id] = value;
    assert(processStart(value.pid) === value.supervisorStart && processStart(value.serverPid!) === value.serverStart, `${id}: processes are not owned`);
    assert(existsSync(join(home, "profiles", id, "native-profile.json")), `${id}: native profile is missing`);
    observeBrowserProcesses(id, value);
    assert((await call(client, "profile_status", { profileId: id })).phase === "ready", `${id}: browser is not ready`);
    const acquired = await call(client, "profile_acquire", { profileId: id }); handles.set(id, String(acquired.controlHandle));
    await call(client, "camofox_list_tabs", { profileId: id });
    const tabId = String((await call(client, "camofox_create_tab", { profileId: id, url: `${site.url}/?capture=empty-${id}` })).tabId);
    tabs.set(id, tabId); await call(client, "camofox_snapshot", { profileId: id, tabId });
    await storage(`empty-${id}`, null);
    await call(client, "camofox_type", { profileId: id, tabId, selector: "#marker", text: id });
    await call(client, "camofox_snapshot", { profileId: id, tabId });
    await call(client, "camofox_click", { profileId: id, tabId, selector: "#save" });
    let saved = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      const snapshot = await call(client, "camofox_snapshot", { profileId: id, tabId });
      if (String(snapshot.snapshot).includes(`Storage marker: ${id}`)) { saved = true; break; }
      await Bun.sleep(100);
    }
    assert(saved, `${id}: marker was not saved`);
  }
  assert(JSON.stringify((await client.listTools()).tools) === schemas, "Tool schemas changed with the catalog");
  assert(new Set([...records.values()].map(value => value.serverPid)).size === 3, "Profiles share a server");
  report.checks.push("One connection starts empty, creates and starts two profiles during browsing, and discovers a third created through CLI with unchanged schemas");
  const interleaved = await Promise.allSettled(ids.map(async id => {
    const tabId = tabs.get(id)!;
    await call(client, "camofox_snapshot", { profileId: id, tabId });
    await call(client, "camofox_navigate", { profileId: id, tabId, url: `${site!.url}/?capture=saved-${id}` });
    await call(client, "camofox_snapshot", { profileId: id, tabId }); await storage(`saved-${id}`, id);
  }));
  for (const result of interleaved) if (result.status === "rejected") throw result.reason;
  report.checks.push("Cookie, localStorage, and IndexedDB markers remain isolated across three profiles");

  const first = ids[0]!, second = ids[1]!, competitor = await connect();
  const page = tabs.get(first)!;
  await call(client, "camofox_scroll", { profileId: first, tabId: page, direction: "down", amount: 200 });
  const screenshot = await client.callTool({ name: "camofox_screenshot", arguments: { profileId: first, tabId: page } });
  assert(!screenshot.isError && (screenshot.content as { type: string; mimeType?: string; data?: string }[])
    .some(block => block.type === "image" && block.mimeType === "image/png" && (block.data?.length || 0) > 1000), "Screenshot response changed");
  const disposable = await call(client, "camofox_create_tab", { profileId: first, url: `${site.url}/?pagination=1` });
  const part = await call(client, "camofox_snapshot", { profileId: first, tabId: disposable.tabId });
  assert(typeof part.nextOffset === "number" && part.nextOffset > 0, "Snapshot pagination is missing");
  const rest = await call(client, "camofox_snapshot", { profileId: first, tabId: disposable.tabId, offset: part.nextOffset });
  assert(typeof rest.snapshot === "string" && rest.snapshot !== part.snapshot, "Snapshot pagination repeated its first page");
  await call(client, "camofox_close_tab", { profileId: first, tabId: disposable.tabId });
  assert(!JSON.stringify(await call(client, "camofox_list_tabs", { profileId: first })).includes(String(disposable.tabId)), "Tab close did not remove the selected tab");
  report.checks.push("All nine canonical browser tools preserve responses, including image screenshots and snapshot pagination");
  for (const connection of [client, competitor])
    assert((await connection.callTool({ name: "profile_acquire", arguments: { profileId: first } })).isError, "Second acquisition acquired a held profile");
  for (const args of [
    { profileId: second, controlHandle: handles.get(first), tabId: tabs.get(second) },
    { profileId: first, controlHandle: "unknown", tabId: tabs.get(first) },
    { profileId: first, controlHandle: handles.get(first), tabId: tabs.get(second) },
    { profileId: first, controlHandle: handles.get(first), tabId: tabs.get(first), userId: second },
    { profileId: first, controlHandle: handles.get(first), tabId: tabs.get(first), controllerId: "injected" },
  ]) assert((await client.callTool({ name: "camofox_snapshot", arguments: args })).isError, "Invalid routing reached a browser");
  assert((await competitor.callTool({ name: "camofox_snapshot", arguments: { profileId: first, controlHandle: handles.get(first), tabId: tabs.get(first) } })).isError, "Foreign handle worked on another connection");
  await call(client, "profile_pause", { profileId: first });
  assert((await client.callTool({ name: "camofox_list_tabs", arguments: { profileId: first } })).isError, "Paused A allowed actions");
  await call(client, "camofox_snapshot", { profileId: second, tabId: tabs.get(second) });
  await call(client, "profile_resume", { profileId: first });
  report.checks.push("Swapped handles, foreign tabs, unknown handles, internal overrides, and handles from another connection fail; pausing A leaves B operational");
  const duplicates = await Promise.allSettled(Array.from({ length: 3 }, () => call(client, "profile_start", { profileId: first })));
  for (const duplicate of duplicates) if (duplicate.status === "rejected") throw duplicate.reason;
  for (const id of ids) assert(JSON.stringify(record(id)) === JSON.stringify(records.get(id)), `${id}: repeated start changed its lifetime`);
  await call(client, "profile_release", { profileId: first });
  await call(client, "camofox_snapshot", { profileId: second, tabId: tabs.get(second) });
  const races = await Promise.all([client.callTool({ name: "profile_acquire", arguments: { profileId: first } }), competitor.callTool({ name: "profile_acquire", arguments: { profileId: first } })]);
  assert(races.filter(result => !result.isError).length === 1, "Acquisition race did not have exactly one winner");
  const winner = !races[0]!.isError ? client : competitor;
  await call(client, "profile_release", { profileId: first, controlHandle: handles.get(first) });
  assert(String((await call(winner, "camofox_snapshot", { profileId: first, tabId: tabs.get(first)! })).snapshot).includes(`Storage marker: ${first}`), "Repeated old release affected new owner");
  await client.close(); clients.delete(client);
  const beforeRestart = await call(competitor, "profile_acquire", { profileId: second });
  assert(JSON.stringify(await call(competitor, "camofox_list_tabs", { profileId: second })).includes(tabs.get(second)!), "Disconnect lost the original tab");
  assert(String((await call(competitor, "camofox_snapshot", { profileId: second, tabId: tabs.get(second)! })).snapshot).includes(`Storage marker: ${second}`), "Handoff lost page state");
  report.checks.push("Duplicate starts retain one lifetime; acquisition races have one winner; release and disconnect preserve independent controllers and page state");
  const pin = readFileSync(join(home, "profiles", second, "fingerprint.json"), "utf8");
  await command("stop", second);
  await call(competitor, "profile_start", { profileId: second });
  report.restartedLifetimes[second] = record(second);
  observeBrowserProcesses(second, record(second));
  assert(record(second).instanceId !== records.get(second)!.instanceId, "Explicit restart reused a service lifetime");
  assert((await competitor.callTool({ name: "camofox_snapshot", arguments: { profileId: second, controlHandle: beforeRestart.controlHandle, tabId: tabs.get(second) } })).isError, "Old handle reached the restarted browser");
  const afterRestart = await call(competitor, "profile_acquire", { profileId: second });
  assert(afterRestart.controlHandle !== beforeRestart.controlHandle, "Restart reused a public handle");
  await call(competitor, "profile_release", { profileId: second, controlHandle: beforeRestart.controlHandle });
  const restored = await call(competitor, "camofox_create_tab", { profileId: second, url: `${site.url}/?capture=restarted-${second}` });
  await call(competitor, "camofox_snapshot", { profileId: second, tabId: restored.tabId });
  await storage(`restarted-${second}`, second);
  assert(readFileSync(join(home, "profiles", second, "fingerprint.json"), "utf8") === pin, "Explicit restart changed saved fingerprint settings");
  report.checks.push("Restart rejects the old handle, permits fresh acquisition on the same connection, and preserves native storage and saved fingerprint settings");
} catch (error) { report.errors.push(String(error)); }
finally {
  for (const client of clients) await client.close().catch(error => report.errors.push(`Disconnect: ${error}`));
  for (const id of started) {
    // Observation failures must never skip the explicit stop for this test profile.
    try { observeBrowserProcesses(id, record(id)); }
    catch (error) { report.errors.push(`Process inspection ${id}: ${error}`); }
    try {
      await command("stop", id);
      const saved = record(id), stopped = JSON.parse(readFileSync(join(home, "profiles", id, "stopped.json"), "utf8"));
      assert(stopped.instanceId === saved.instanceId, `${id}: no clean-stop receipt`);
      assert(saved.supervisorStart && saved.serverPid && saved.serverStart, `${id}: process ownership stamps are missing`);
      assert(exited({ pid: saved.pid, start: saved.supervisorStart }) && exited({ pid: saved.serverPid, start: saved.serverStart }), `${id}: processes remain live or unverifiable`);
      await verifyBrowserProcessesExited(id);
    } catch (error) { report.errors.push(`Cleanup ${id}: ${error}`); }
  }
  site?.stop();
  if (!report.errors.length) {
    report.checks.push("All observed browser subprocesses exited after explicit stops of the test profiles");
    rmSync(home, { recursive: true, force: true }); report.cleanedUp = true;
  }
  report.result = report.errors.length ? "failed" : "passed";
  report.completedAt = new Date().toISOString();
  const output = join(root, ".state/concurrency-acceptance"); mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(`${report.result}: ${join(output, "report.json")}`);
  for (const error of report.errors) console.error(error);
  if (report.errors.length) process.exitCode = 1;
}
