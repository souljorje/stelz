import { readFileSync, writeFileSync, unlinkSync, existsSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { HOME_DIR, STATE, settings, profile, dir, initDir, save, json, alive, control, configurationHash, entry } from "./config.ts";

type Lock = { pid: number; token: string };
export async function lock<T>(path: string, action: () => Promise<T>, timeout = 45000): Promise<T> {
  const token = crypto.randomUUID(), end = Date.now() + timeout;
  for (;;) {
    try { writeFileSync(path, JSON.stringify({ pid: process.pid, token }), { flag: "wx", mode: 0o600 }); break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let owner: Lock | undefined;
      try { owner = json<Lock>(path); } catch {}
      if (owner && !alive(owner.pid)) { try { unlinkSync(path); } catch {} continue; }
      if (Date.now() >= end) throw Error("Identity operation is busy. Wait for the current action.");
      await Bun.sleep(50);
    }
  }
  try { return await action(); }
  finally { if (json<Lock>(path)?.token === token) unlinkSync(path); }
}
export type Running = { pid: number; serverPid?: number; instanceId: string; configurationHash: string };
export function running(id: string) {
  const value = json<Running>(join(dir(id), "running.json"));
  if (value && json<{ instanceId: string }>(join(dir(id), "stopped.json"))?.instanceId === value.instanceId) return;
  return value && alive(value.pid) ? value : undefined;
}
export function status(id: string) {
  const p = profile(id), live = running(id);
  const stored = json<Record<string, unknown>>(join(dir(id), "status.json"));
  return { identityId: id, mode: p.mode, ...stored, ...(live ? { supervisorPid: live.pid, serverPid: live.serverPid } : { phase: stored?.phase === "unclean" ? "unclean" : "stopped" }) };
}
export function assertRunning(id: string, validateConfiguration = false) {
  const p = profile(id), live = running(id);
  if (!live) throw Error(`Identity is stopped. Run stelz start ${id}.`);
  if (validateConfiguration && live.configurationHash !== configurationHash(p)) throw Error("Identity configuration changed. Stop the identity before you restart it.");
  return p;
}
export async function start(id: string) {
  const p = profile(id); initDir(id);
  const configHash = configurationHash(p);
  if (!existsSync(join(HOME_DIR, "runtime/versions.json"))) throw Error("Run stelz setup first.");
  await lock(join(STATE, "admission.lock"), async () => {
    if (running(id)) { assertRunning(id, true); return; }
    const stale = json<Running>(join(dir(id), "running.json"));
    const clean = stale && json<{ instanceId: string }>(join(dir(id), "stopped.json"))?.instanceId === stale.instanceId;
    if (stale && !clean) throw Error(`${id}: previous stop was not clean. Check its owned processes before you archive running.json.`);
    if (settings().identities.filter(p => running(p.id)).length >= settings().maxActive) throw Error("The browser limit is reached. Stop another identity first.");
    if (!existsSync(join(dir(id), "access-key"))) writeFileSync(join(dir(id), "access-key"), crypto.randomUUID(), { mode: 0o600, flag: "wx" });
    const logFd = openSync(join(dir(id), "supervisor.log"), "a", 0o600);
    const instanceId = crypto.randomUUID();
    const child = spawn(process.execPath, ["--no-env-file", entry("supervisor"), id, instanceId], { cwd: HOME_DIR, detached: true, stdio: ["ignore", logFd, logFd], env: { ...process.env, STELZ_HOME: HOME_DIR } });
    child.unref(); closeSync(logFd);
    save(join(dir(id), "running.json"), { pid: child.pid, instanceId, configurationHash: configHash });
    await Bun.sleep(100);
  });
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if (!running(id)) throw Error(`${id}: launch failed. Read ${join(dir(id), "server.log")}.`);
    try {
      const s = await control(p, "GET", "status");
      const initialized = json<{ instanceId: string }>(join(dir(id), "initialized.json"));
      if ((s.phase === "ready" || s.phase === "paused") && initialized?.instanceId === running(id)?.instanceId) return s;
      if (s.phase === "blocked") throw Error(String(s.error || "Identity is blocked."));
    } catch (e) { if (!String(e).includes("fetch") && !String(e).includes("Unable to connect") && !String(e).includes("ECONN")) throw e; }
    await Bun.sleep(300);
  }
  await stop(id);
  throw Error(`${id}: launch exceeded its time limit. No replacement browser started.`);
}
export async function stop(id: string) {
  const p = profile(id); initDir(id);
  return lock(join(dir(id), "lifecycle.lock"), async () => {
    if (!running(id)) return status(id);
    await control(p, "POST", "stop");
    const deadline = Date.now() + 15000;
    while (running(id) && Date.now() < deadline) await Bun.sleep(100);
    if (running(id)) throw Error(`${id}: clean stop exceeded its time limit. State remains intact.`);
    return status(id);
  });
}
export const key = (id: string) => readFileSync(join(dir(id), "access-key"), "utf8").trim();
export const intervention = (id: string, action: "pause" | "resume" | "handoff") => control(profile(id), "POST", action);
