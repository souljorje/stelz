import { readFileSync, writeFileSync, unlinkSync, existsSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { ROOT, STATE, settings, profile, dir, initDir, save, json, alive, control, proxyEnvironment, type Profile } from "./config.ts";

type Lock = { pid: number; token: string };
export async function lock<T>(path: string, action: () => Promise<T>, timeout = 45000): Promise<T> {
  const token = crypto.randomUUID(), end = Date.now() + timeout;
  for (;;) {
    try { writeFileSync(path, JSON.stringify({ pid: process.pid, token }), { flag: "wx", mode: 0o600 }); break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const owner = json<Lock>(path);
      if (owner && !alive(owner.pid)) { try { unlinkSync(path); } catch {} continue; }
      if (Date.now() >= end) throw Error("Profile operation is busy; wait for its current action to finish");
      await Bun.sleep(50);
    }
  }
  try { return await action(); }
  finally { if (json<Lock>(path)?.token === token) unlinkSync(path); }
}
type Running = { pid: number; serverPid?: number; instanceId: string };
export function running(id: string) {
  const value = json<Running>(join(dir(id), "running.json"));
  if (value && json<{ instanceId: string }>(join(dir(id), "stopped.json"))?.instanceId === value.instanceId) return;
  return value && alive(value.pid) ? value : undefined;
}
export function status(id: string) {
  const p = profile(id), live = running(id);
  const stored = json<Record<string, unknown>>(join(dir(id), "status.json"));
  return { profileId: id, mode: p.mode, ...stored, ...(live ? { supervisorPid: live.pid, serverPid: live.serverPid } : { phase: stored?.phase === "unclean" ? "unclean" : "stopped" }) };
}
export async function start(id: string) {
  const p = profile(id); initDir(id);
  proxyEnvironment(p); // Validate before launching any process.
  if (!existsSync(join(ROOT, ".runtime/versions.json"))) throw Error("Run bun run setup first");
  await lock(join(STATE, "admission.lock"), async () => {
    if (running(id)) return;
    const stale = json<Running>(join(dir(id), "running.json"));
    const clean = stale && json<{ instanceId: string }>(join(dir(id), "stopped.json"))?.instanceId === stale.instanceId;
    if (stale && !clean) throw Error(`${id}: previous shutdown was not confirmed clean; verify its owned processes are gone before archiving running.json. No replacement browser was launched.`);
    if (settings().profiles.filter(p => running(p.id)).length >= settings().maxActive) throw Error("Configured concurrent browser limit reached; stop/release another profile");
    if (!existsSync(join(dir(id), "access-key"))) writeFileSync(join(dir(id), "access-key"), crypto.randomUUID(), { mode: 0o600, flag: "wx" });
    const logFd = openSync(join(dir(id), "supervisor.log"), "a", 0o600);
    const instanceId = crypto.randomUUID();
    const child = spawn(process.execPath, [join(ROOT, "src/supervisor.ts"), id, instanceId], { cwd: ROOT, detached: true, stdio: ["ignore", logFd, logFd], env: process.env });
    child.unref(); closeSync(logFd);
    // Reserve capacity immediately; supervisor updates this same ownership record.
    save(join(dir(id), "running.json"), { pid: child.pid, instanceId });
    await Bun.sleep(100);
  });
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if (!running(id)) throw Error(`${id}: launch failed; inspect its redacted .state log`);
    try {
      const s = await control(p, "GET", "status");
      const initialized = json<{ instanceId: string }>(join(dir(id), "initialized.json"));
      if ((s.phase === "ready" || s.phase === "paused") && initialized?.instanceId === running(id)?.instanceId) return s;
      if (s.phase === "blocked") throw Error(String(s.error || "Profile blocked"));
    } catch (e) { if (!String(e).includes("fetch") && !String(e).includes("Unable to connect") && !String(e).includes("ECONN")) throw e; }
    await Bun.sleep(300);
  }
  await stop(id);
  throw Error(`${id}: launch timed out; no replacement browser was started`);
}
export async function stop(id: string) {
  profile(id); const live = running(id);
  if (!live) return status(id);
  await control(profile(id), "POST", "stop");
  const deadline = Date.now() + 15000;
  while (running(id) && Date.now() < deadline) await Bun.sleep(100);
  if (running(id)) throw Error(`${id}: clean shutdown timed out; state retained and lock not force-cleared`);
  return status(id);
}
export async function adminStop(id: string) {
  profile(id); initDir(id);
  return lock(join(dir(id), "action.lock"), async () => {
    const result = await stop(id);
    try { unlinkSync(join(dir(id), "lease.json")); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    return result;
  });
}
type Lease = { token: string; owner: string; acquiredAt: string };
export function assertLease(id: string, token: string) {
  const lease = json<Lease>(join(dir(id), "lease.json"));
  if (!lease || lease.token !== token) throw Error("Missing or invalid profile lease; acquire the assigned profile first");
}
export async function acquire(id: string, owner: string) {
  profile(id); initDir(id);
  return lock(join(dir(id), "lease-operation.lock"), async () => {
    if (json<Lease>(join(dir(id), "lease.json"))) throw Error(`${id}: already leased; release its current worker before reassigning`);
    const token = crypto.randomUUID(); save(join(dir(id), "lease.json"), { token, owner, acquiredAt: new Date().toISOString() });
    try { const result = await start(id); return { ...result, leaseToken: token }; }
    catch (e) { await stop(id).catch(() => {}); unlinkSync(join(dir(id), "lease.json")); throw e; }
  });
}
export async function release(id: string, token: string, stopBrowser = true) {
  initDir(id);
  return lock(join(dir(id), "action.lock"), async () => {
    assertLease(id, token);
    if (stopBrowser) await stop(id);
    unlinkSync(join(dir(id), "lease.json"));
    return { released: true, ...status(id) };
  });
}
export async function intervention(id: string, action: "pause" | "resume") {
  const p = profile(id); initDir(id);
  return lock(join(dir(id), "action.lock"), () => control(p, "POST", action));
}
export async function withBrowser<T>(id: string, token: string, action: (p: Profile) => Promise<T>) {
  const p = profile(id); initDir(id);
  return lock(join(dir(id), "action.lock"), async () => {
    assertLease(id, token);
    if (!running(id)) throw Error("Browser is stopped; explicitly reacquire/restart it");
    await control(p, "POST", "check");
    return action(p);
  });
}
export function key(id: string) { return readFileSync(join(dir(id), "access-key"), "utf8").trim(); }
