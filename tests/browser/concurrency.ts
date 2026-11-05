// Explicit browser acceptance in a disposable home. Existing service profiles are never selected.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fixture } from "../helpers/fixture.ts";
import { processStart, type Running } from "../../src/runtime/profile-process.ts";

const root = resolve(import.meta.dir, "../.."), cli = join(root, "dist/cli.js");
const home = mkdtempSync(join(tmpdir(), "stelz-browser-concurrency-"));
const ids = ["concurrency-01", "concurrency-02", "concurrency-03"];
const env: Record<string, string> = { STELZ_HOME: home };
for (const key of ["PATH", "HOME", "LANG", "TMPDIR", "CAMOUFOX_EXECUTABLE"]) if (process.env[key]) env[key] = process.env[key]!;
const clients = new Set<Client>(), started = new Set<string>();
const records = new Map<string, Running>(), tabs = new Map<string, string>();
type BrowserProcess = { pid: number; start: string };
const report = { result: "incomplete", home, startedAt: new Date().toISOString(), completedAt: "", profiles: ids,
  lifetimes: {} as Record<string, Running>, browserProcesses: {} as Record<string, BrowserProcess[]>,
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
async function connect(id: string) {
  const client = new Client({ name: "concurrency-acceptance", version: "1.0.0" }); clients.add(client);
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--no-env-file", cli, "mcp", "--profile", id], env }));
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
  const reservations = ids.map(() => Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }));
  try {
    writeFileSync(join(home, "profiles.json"), JSON.stringify({ profiles: ids.map((id, index) => ({
      id, port: reservations[index]!.port, storage: "native",
    })) }), { mode: 0o600 });
  } finally { for (const reservation of reservations) reservation.stop(true); }
  await command("setup"); site = await fixture(0);
  for (const id of ids) started.add(id);
  const launches = await Promise.allSettled(ids.map(id => command("start", id)));
  for (const launch of launches) if (launch.status === "rejected") throw launch.reason;
  for (const id of ids) {
    const value = record(id); records.set(id, value); report.lifetimes[id] = value;
    assert(processStart(value.pid) === value.supervisorStart && processStart(value.serverPid!) === value.serverStart, `${id}: processes are not owned`);
    assert(existsSync(join(home, "profiles", id, "native-profile.json")), `${id}: native profile is missing`);
    observeBrowserProcesses(id, value);
  }
  assert(new Set([...records.values()].map(value => value.serverPid)).size === 3, "Profiles share a server");
  report.checks.push("Three native browsers remain active simultaneously");
  console.log(report.checks.at(-1));

  const connections = new Map<string, Client>();
  for (const id of ids) {
    const client = await connect(id); connections.set(id, client);
    assert((await call(client, "profile_status")).phase === "ready", `${id}: browser is not ready`);
    await call(client, "profile_acquire"); await call(client, "camofox_list_tabs");
    const tabId = String((await call(client, "camofox_create_tab", { url: `${site.url}/?capture=empty-${id}` })).tabId);
    tabs.set(id, tabId); await call(client, "camofox_snapshot", { tabId });
    await storage(`empty-${id}`, null);
    await call(client, "camofox_type", { tabId, selector: "#marker", text: id });
    await call(client, "camofox_snapshot", { tabId });
    await call(client, "camofox_click", { tabId, selector: "#save" });
    let saved = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      const snapshot = await call(client, "camofox_snapshot", { tabId });
      if (String(snapshot.snapshot).includes(`Storage marker: ${id}`)) { saved = true; break; }
      await Bun.sleep(100);
    }
    assert(saved, `${id}: marker was not saved`);
  }
  for (const id of ids) {
    const client = connections.get(id)!, tabId = tabs.get(id)!;
    await call(client, "camofox_snapshot", { tabId });
    await call(client, "camofox_navigate", { tabId, url: `${site.url}/?capture=saved-${id}` });
    await call(client, "camofox_snapshot", { tabId }); await storage(`saved-${id}`, id);
  }
  report.checks.push("Cookie, localStorage, and IndexedDB markers remain isolated across three profiles");

  const first = ids[0]!, competitor = await connect(first);
  assert((await competitor.callTool({ name: "profile_acquire", arguments: {} })).isError, "Second controller acquired a held profile");
  const duplicates = await Promise.allSettled(Array.from({ length: 3 }, () => command("start", first)));
  for (const duplicate of duplicates) if (duplicate.status === "rejected") throw duplicate.reason;
  for (const id of ids) assert(JSON.stringify(record(id)) === JSON.stringify(records.get(id)), `${id}: repeated start changed its lifetime`);
  await connections.get(first)!.close(); clients.delete(connections.get(first)!);
  await call(competitor, "profile_acquire");
  assert(JSON.stringify(await call(competitor, "camofox_list_tabs")).includes(tabs.get(first)!), "Disconnect lost the original tab");
  assert(String((await call(competitor, "camofox_snapshot", { tabId: tabs.get(first)! })).snapshot).includes(`Storage marker: ${first}`), "Handoff lost page state");
  report.checks.push("Duplicate starts retain one lifetime and disconnect preserves controller handoff and page state");
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
