import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { alive, dir, isRuntimeId, json, type Profile } from "../profiles/config.ts";

// Keep the lock inode in place. The kernel releases flock when a process dies,
// so competing stale-lock recoveries cannot unlink each other's new lock.
const system = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});
const proc =
  process.platform === "darwin"
    ? dlopen("/usr/lib/libproc.dylib", {
        proc_pidinfo: {
          args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
          returns: FFIType.i32,
        },
      })
    : undefined;
const macSysctl =
  process.platform === "darwin"
    ? dlopen("/usr/lib/libSystem.B.dylib", {
        sysctl: {
          args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64],
          returns: FFIType.i32,
        },
      })
    : undefined;

export async function lock<T>(path: string, action: () => Promise<T>, timeout = 45000, busy = "Profile operation is busy. Wait for the current action."): Promise<T> {
  const token = crypto.randomUUID(),
    end = Date.now() + timeout;
  const flags = constants.O_CREAT | constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW;
  const fd = openSync(path, flags, 0o600);
  let held = false;
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1) throw Error(`Invalid lock file: ${path}`);
    for (;;) {
      if (system.symbols.flock(fd, 2 | 4) === 0) {
        held = true;
        // Refuse an unlinked or replaced inode.
        let same = false;
        try {
          const a = fstatSync(fd);
          const b = lstatSync(path);
          same =
            a.isFile() && b.isFile() && a.nlink === 1 && b.nlink === 1 && a.dev === b.dev && a.ino === b.ino;
        } catch {}
        if (!same) throw Error(`Lock file changed during acquisition: ${path}`);
        ftruncateSync(fd, 0);
        writeSync(fd, JSON.stringify({ version: 2, pid: process.pid, token }));
        break;
      }
      if (Date.now() >= end) throw Error(busy);
      await Bun.sleep(50);
    }
    return await action();
  } finally {
    if (held) system.symbols.flock(fd, 8);
    closeSync(fd);
  }
}

// A PID alone is not ownership: it may already belong to a different process.
// Darwin reports an absolute start time; Linux reports boot ID and start ticks.
function isMacZombie(pid: number): boolean {
  if (!macSysctl) return false;
  // CTL_KERN/KERN_PROC/KERN_PROC_PID returns kinfo_proc, including zombies.
  const mib = Buffer.alloc(16);
  [1, 14, 1, pid].forEach((value, index) => mib.writeInt32LE(value, index * 4));
  const data = Buffer.alloc(2048);
  const size = Buffer.alloc(8);
  size.writeBigUInt64LE(BigInt(data.length));
  return (
    macSysctl.symbols.sysctl(ptr(mib), 4, ptr(data), ptr(size), null, 0) === 0 &&
    size.readBigUInt64LE() >= 44n &&
    data.readInt32LE(40) === pid &&
    data[36] === 5
  );
}

function processInfo(pid: number): { start?: string; zombie?: boolean } | undefined {
  if (!Number.isInteger(pid) || pid <= 1) return;
  try {
    if (proc) {
      const data = Buffer.alloc(136);
      if (
        proc.symbols.proc_pidinfo(pid, 3, 0, ptr(data), data.length) !== data.length ||
        data.readUInt32LE(12) !== pid
      )
        return isMacZombie(pid) ? { zombie: true } : undefined;
      if (data.readUInt32LE(4) === 5) return { zombie: true };
      if (process.getuid && data.readUInt32LE(20) !== process.getuid()) return;
      return { start: `darwin:${data.readBigUInt64LE(120)}:${data.readBigUInt64LE(128)}` };
    }
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[0] === "Z") return { zombie: true };
      if (!fields[19]) return;
      return { start: `linux:${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${fields[19]}` };
    }
  } catch {}
}

export function processStart(pid: number): string | undefined {
  return processInfo(pid)?.start;
}

export type Running = {
  pid: number;
  serverPid?: number;
  instanceId: string;
  configurationHash: string;
  port?: number;
  version: 2;
  supervisorStart?: string;
  serverStart?: string;
  serverState?: "not-started" | "started";
  /** The runtime generation ID that this service started with. */
  runtime?: string;
};
type Ownership = "owned" | "missing" | "different" | "unverified";
export function ownership(pid: number | undefined, expected: string | undefined): Ownership {
  if (!Number.isInteger(pid) || !pid || pid <= 1) return "missing";
  const info = processInfo(pid);
  if (info?.zombie) return "missing";
  const actual = info?.start;
  if (!actual) return alive(pid) ? "unverified" : "missing";
  return !expected ? "unverified" : actual === expected ? "owned" : "different";
}
export function observe(id: string, directory = dir(id)) {
  const record = json<Running>(join(directory, "running.json"));
  if (
    record !== undefined &&
    (!record ||
      typeof record !== "object" ||
      !Number.isSafeInteger(record.pid) ||
      record.pid < 0 ||
      record.pid === 1 ||
      typeof record.instanceId !== "string" ||
      !record.instanceId ||
      record.version !== 2 ||
      (record.serverPid !== undefined &&
        (!Number.isSafeInteger(record.serverPid) || record.serverPid <= 1)) ||
      (record.port !== undefined &&
        (!Number.isInteger(record.port) || record.port < 1024 || record.port > 65535)) ||
      (record.supervisorStart !== undefined && typeof record.supervisorStart !== "string") ||
      (record.serverStart !== undefined && typeof record.serverStart !== "string") ||
      (record.serverState !== undefined && !["started", "not-started"].includes(record.serverState)) ||
      (record.runtime !== undefined && !isRuntimeId(record.runtime)) ||
      (record.serverState === "started" && !record.serverPid) ||
      (record.serverState === "not-started" && !!record.serverPid))
  )
    throw Error(`${id}: invalid process record; inspect it before recovery.`);
  const supervisor = ownership(record?.pid, record?.supervisorStart);
  const server = ownership(record?.serverPid, record?.serverStart);
  const clean =
    !!record && json<{ instanceId: string }>(join(directory, "stopped.json"))?.instanceId === record.instanceId;
  return { record, supervisor, server, clean };
}
export function assertStoppedProfile(id: string, directory = dir(id)) {
  const o = observe(id, directory);
  if (o.record && (!o.clean ||
      [o.supervisor, o.server].some(value => value === "owned" || value === "unverified")))
    throw Error("Stop the profile cleanly before deleting it or changing its configuration.");
}
export function running(id: string): Running | undefined {
  const o = observe(id);
  // A reservation may still be claimed by a supervisor waiting on admission.lock.
  if (
    o.record &&
    ([o.supervisor, o.server].some((s) => s === "owned" || s === "unverified") ||
      (o.record.pid === 0 && !o.clean))
  )
    return o.record;
}

const runtimePhases = [
  "starting",
  "ready",
  "paused",
  "verification_failed",
  "blocked",
  "stopping",
  "stopped",
  "orphaned",
  "ownership_unknown",
  "unclean",
] as const;
export type RuntimePhase = (typeof runtimePhases)[number];
export function isRuntimePhase(value: unknown): value is RuntimePhase {
  return typeof value === "string" && (runtimePhases as readonly string[]).includes(value);
}
export function observeStatus(p: Profile) {
  const id = p.id, o = observe(id);
  const stored = json<Record<string, unknown>>(join(dir(id), "status.json")) || {};
  let phase: RuntimePhase =
    stored?.phase === undefined ? "starting" : isRuntimePhase(stored.phase) ? stored.phase : "unclean";
  if (!o.record) phase = "stopped";
  else if (o.supervisor === "unverified" || o.server === "unverified") phase = "ownership_unknown";
  else if (o.supervisor !== "owned" && o.server === "owned") phase = "orphaned";
  else if (o.supervisor === "owned" && o.record.serverState === "not-started") phase = "starting";
  else if (o.supervisor !== "owned" || o.server !== "owned")
    phase = o.clean && o.server !== "owned" && o.supervisor !== "owned" ? "stopped" : "unclean";
  return {
    profileId: id,
    ...stored,
    phase,
    ...(o.record
      ? {
          supervisorPid: o.record.pid || undefined,
          serverPid: o.record.serverPid,
          ownership: { supervisor: o.supervisor, server: o.server },
        }
      : {}),
  };
}
