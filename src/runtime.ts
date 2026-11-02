import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { dlopen, FFIType, ptr } from "bun:ffi";
import {
  HOME_DIR,
  STATE,
  settings,
  profile,
  dir,
  initDir,
  save,
  json,
  alive,
  base,
  configurationHash,
  entry,
  executable,
  type Profile,
} from "./config.ts";

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

type Lock = { pid: number; token: string; version?: number };
export async function lock<T>(path: string, action: () => Promise<T>, timeout = 45000): Promise<T> {
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
        // Refuse an unlinked/replaced inode, including one left by an older client.
        let same = false;
        try {
          const a = fstatSync(fd);
          const b = lstatSync(path);
          same =
            a.isFile() && b.isFile() && a.nlink === 1 && b.nlink === 1 && a.dev === b.dev && a.ino === b.ino;
        } catch {}
        if (!same) throw Error(`Lock file changed during acquisition: ${path}`);
        let previous: Lock | undefined;
        try {
          const buffer = Buffer.alloc(4096);
          const length = readSync(fd, buffer, 0, buffer.length, 0);
          previous = JSON.parse(buffer.subarray(0, length).toString("utf8")) as Lock;
        } catch {}
        // Old versions did not use flock. Do not run alongside a live old owner.
        if (
          !previous ||
          previous.version === 2 ||
          !Number.isInteger(previous.pid) ||
          previous.pid <= 1 ||
          !alive(previous.pid)
        ) {
          ftruncateSync(fd, 0);
          writeSync(fd, JSON.stringify({ version: 2, pid: process.pid, token }));
          break;
        }
        system.symbols.flock(fd, 8);
        held = false;
      }
      if (Date.now() >= end) throw Error("Identity operation is busy. Wait for the current action.");
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
  version?: 2;
  supervisorStart?: string;
  serverStart?: string;
  serverState?: "not-started" | "started";
};
type Ownership = "owned" | "missing" | "different" | "unverified";
function isLegacy(record: Running) {
  return record.version === undefined && record.supervisorStart === undefined &&
    record.serverStart === undefined && record.serverState === undefined;
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
function isRuntimePhase(value: unknown): value is RuntimePhase {
  return typeof value === "string" && (runtimePhases as readonly string[]).includes(value);
}
function ownership(pid: number | undefined, expected: string | undefined): Ownership {
  if (!Number.isInteger(pid) || !pid || pid <= 1) return "missing";
  const info = processInfo(pid);
  if (info?.zombie) return "missing";
  const actual = info?.start;
  if (!actual) return alive(pid) ? "unverified" : "missing";
  return !expected ? "unverified" : actual === expected ? "owned" : "different";
}
function observe(id: string) {
  const record = json<Running>(join(dir(id), "running.json"));
  if (
    record !== undefined &&
    (!record ||
      typeof record !== "object" ||
      !Number.isSafeInteger(record.pid) ||
      record.pid < 0 ||
      record.pid === 1 ||
      typeof record.instanceId !== "string" ||
      !record.instanceId ||
      (record.serverPid !== undefined &&
        (!Number.isSafeInteger(record.serverPid) || record.serverPid <= 1)) ||
      (record.port !== undefined &&
        (!Number.isInteger(record.port) || record.port < 1024 || record.port > 65535)) ||
      (record.supervisorStart !== undefined && typeof record.supervisorStart !== "string") ||
      (record.serverStart !== undefined && typeof record.serverStart !== "string") ||
      (record.serverState !== undefined && !["started", "not-started"].includes(record.serverState)) ||
      (record.serverState === "started" && !record.serverPid) ||
      (record.serverState === "not-started" && !!record.serverPid))
  )
    throw Error(`${id}: invalid process record; inspect it before recovery.`);
  const supervisor = ownership(record?.pid, record?.supervisorStart);
  const server = ownership(record?.serverPid, record?.serverStart);
  const clean =
    !!record && json<{ instanceId: string }>(join(dir(id), "stopped.json"))?.instanceId === record.instanceId;
  return { record, supervisor, server, clean };
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
export function status(id: string) {
  const p = profile(id),
    o = observe(id);
  const stored = json<Record<string, unknown>>(join(dir(id), "status.json"));
  let phase: RuntimePhase =
    stored?.phase === undefined ? "starting" : isRuntimePhase(stored.phase) ? stored.phase : "unclean";
  if (!o.record) phase = "stopped";
  else if (o.supervisor === "unverified" || o.server === "unverified") phase = "ownership_unknown";
  else if (o.supervisor !== "owned" && o.server === "owned") phase = "orphaned";
  else if (o.supervisor === "owned" && o.record.serverState === "not-started") phase = "starting";
  else if (o.supervisor !== "owned" || o.server !== "owned")
    phase = o.clean && o.server !== "owned" && o.supervisor !== "owned" ? "stopped" : "unclean";
  return {
    identityId: id,
    mode: p.mode,
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
export function assertRunning(id: string, validateConfiguration = false) {
  const p = profile(id),
    o = observe(id);
  if (!o.record) throw Error(`Identity is stopped. Run stelz start ${id}.`);
  if (o.supervisor !== "owned" || o.server !== "owned")
    throw Error(`${id}: process ownership or supervisor is unavailable. Run stelz doctor ${id}.`);
  if (validateConfiguration && o.record.configurationHash !== configurationHash(p))
    throw Error("Identity configuration changed. Stop the identity before you restart it.");
  return p;
}

// Lifecycle and diagnostic calls must not inherit the 120-second MCP timeout.
async function request(id: string, method: string, action: string, timeout: number, allowOrphan = false) {
  const p = profile(id),
    o = observe(id);
  if (o.server !== "owned" || (!allowOrphan && o.supervisor !== "owned"))
    throw Error(`${id}: cannot verify process ownership. Run stelz doctor ${id}.`);
  if (!o.record?.port) throw Error(`${id}: the recorded server port is missing. Run stelz doctor ${id}.`);
  return serviceRequest({ ...p, port: o.record.port }, method, action, timeout);
}
async function serviceRequest(p: Profile, method: string, action: string, timeout: number) {
  const token = key(p.id);
  const response = await fetch(`${base(p)}/local-profile/${action}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(timeout),
    redirect: "error",
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw Error(String(payload.error || `Identity control returned ${response.status}.`));
  return payload;
}

// Legacy records cannot establish PID ownership. An explicit stop can still use
// the authenticated endpoint after matching its saved identity and instance.
// Never promote these PIDs to verified ownership or use the signal fallback.
async function stopLegacy(id: string, record: Running) {
  const p = profile(id);
  if (record.configurationHash !== configurationHash(p)) {
    throw Error(`${id}: restore the legacy launch configuration before stopping this identity.`);
  }
  const saved = json<{ identityId?: string; instanceId?: string }>(join(dir(id), "status.json"));
  if (saved?.identityId !== id || !saved.instanceId || typeof saved.instanceId !== "string") {
    throw Error(`${id}: the saved legacy service identity is missing. Inspect the service before stopping it.`);
  }
  const remote = await serviceRequest(p, "GET", "status", 2000);
  if (remote.identityId !== id || remote.instanceId !== saved.instanceId) {
    throw Error(`${id}: the endpoint does not match the saved legacy service. No stop was requested.`);
  }
  const unchanged = () => JSON.stringify(observe(id).record) === JSON.stringify(record);
  if (!unchanged()) throw Error(`${id}: the legacy process record changed. Retry the stop command.`);
  const response = await serviceRequest(p, "POST", "stop", 75000);
  if (response.stopping !== true) throw Error(`${id}: the legacy service did not acknowledge shutdown.`);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (!unchanged()) throw Error(`${id}: the legacy process record changed during shutdown.`);
    const current = observe(id);
    if (current.supervisor === "missing" && current.server === "missing") return status(id);
    await Bun.sleep(100);
  }
  throw Error(`${id}: legacy shutdown was not confirmed. State remains intact; inspect the service.`);
}
export async function reportStatus(id: string) {
  const local = status(id),
    o = observe(id);
  if (o.supervisor !== "owned" || o.server !== "owned") return local;
  try {
    const remote = await request(id, "GET", "status", 2000);
    // Re-observe: a supervisor can die while the request is in flight.
    const current = status(id);
    if (current.phase === "orphaned" || current.phase === "ownership_unknown" || current.phase === "unclean")
      return current;
    return { ...remote, ...current, phase: isRuntimePhase(remote.phase) ? remote.phase : current.phase };
  } catch (e) {
    return { ...status(id), controlError: (e as Error).message };
  }
}

export async function start(id: string) {
  const p = profile(id);
  initDir(id);
  const configHash = configurationHash(p);
  if (!existsSync(join(HOME_DIR, "runtime/versions.json"))) throw Error("Run stelz setup first.");
  await lock(join(STATE, "admission.lock"), async () => {
    const o = observe(id);
    if (running(id)) {
      if (o.supervisor !== "owned" || o.server === "unverified" || o.server === "different")
        throw Error(`${id}: the previous service needs inspection. Run stelz doctor ${id}.`);
      if (o.record?.configurationHash !== configHash)
        throw Error("Identity configuration changed. Stop the identity before you restart it.");
      return;
    }
    if (o.record && !o.clean)
      throw Error(
        `${id}: previous stop was not clean. Run stelz recover ${id} after inspecting its processes.`,
      );
    const identities = readdirSync(STATE, { withFileTypes: true });
    if (identities.some((item) => item.isSymbolicLink()))
      throw Error("Identity state contains a symbolic link.");
    const active = identities.filter((item) => item.isDirectory() && running(item.name)).length;
    if (active >= settings().maxActive)
      throw Error("The browser limit is reached. Stop another identity first.");
    if (!existsSync(join(dir(id), "access-key")))
      writeFileSync(join(dir(id), "access-key"), crypto.randomUUID(), { mode: 0o600, flag: "wx" });
    const instanceId = crypto.randomUUID(),
      file = join(dir(id), "running.json");
    const reservation: Running = {
      version: 2,
      pid: 0,
      instanceId,
      configurationHash: configHash,
      port: p.port,
      serverState: "not-started",
    };
    save(file, reservation);
    rotateLog(join(dir(id), "supervisor.log"));
    const logFd = openSync(join(dir(id), "supervisor.log"), "a", 0o600);
    try {
      const child = spawn(process.execPath, ["--no-env-file", entry("supervisor"), id, instanceId], {
        cwd: HOME_DIR,
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: { ...process.env, STELZ_HOME: HOME_DIR },
      });
      if (!child.pid) throw Error(`${id}: could not launch supervisor.`);
      const supervisorStart = processStart(child.pid);
      if (!supervisorStart) {
        // The supervisor cannot pass admission until this lock is released.
        // Withdraw the reservation instead of signalling an unverified PID.
        renameSync(file, join(dir(id), `running.failed-${instanceId}.json`));
        child.unref();
        throw Error(`${id}: could not verify the new supervisor.`);
      }
      save(file, { ...reservation, pid: child.pid, supervisorStart });
      child.unref();
    } finally {
      closeSync(logFd);
    }
  });
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const o = observe(id);
    if (!o.record || o.supervisor !== "owned")
      throw Error(`${id}: supervisor stopped during launch. Run stelz doctor ${id}.`);
    if (o.server === "owned") {
      try {
        const s = await request(id, "GET", "status", 2000);
        const initialized = json<{ instanceId: string }>(join(dir(id), "initialized.json"));
        if (
          ["ready", "paused", "verification_failed"].includes(String(s.phase)) &&
          initialized?.instanceId === o.record.instanceId
        )
          return s;
        if (s.phase === "blocked") throw Error(String(s.error || "Identity is blocked."));
      } catch (e) {
        if (!/fetch|connect|ECONN|timed out|timeout/i.test(String(e))) throw e;
      }
    }
    await Bun.sleep(300);
  }
  throw Error(`${id}: launch exceeded its time limit. The service was left intact; run stelz doctor ${id}.`);
}

export async function stop(id: string) {
  profile(id);
  initDir(id);
  return lock(join(STATE, "admission.lock"), () =>
    lock(join(dir(id), "lifecycle.lock"), async () => {
      const o = observe(id);
      if (
        !o.record ||
        (o.clean && [o.supervisor, o.server].every((s) => s === "missing" || s === "different"))
      )
        return status(id);
      if (isLegacy(o.record)) return stopLegacy(id, o.record);
      if (o.server !== "owned" || o.supervisor === "unverified")
        throw Error(`${id}: process ownership cannot be verified. Run stelz doctor ${id}.`);
      try {
        await request(id, "POST", "stop", 75000, true);
      } catch (e) {
        const current = observe(id),
          error = e as Error;
        const unavailable =
          error instanceof TypeError || error.name === "TimeoutError" || error.name === "AbortError";
        if (
          unavailable &&
          current.record?.instanceId === o.record.instanceId &&
          ["missing", "different"].includes(current.supervisor) &&
          current.server === "owned" &&
          current.record.serverPid &&
          processStart(current.record.serverPid) === current.record.serverStart
        ) {
          // The explicit stop request permits a graceful signal to a reverified
          // orphan. Keep the record unclean; never escalate to SIGKILL.
          process.kill(current.record.serverPid, "SIGTERM");
        } else throw Error(`${id}: stop request failed or timed out; state remains intact. ${error.message}`);
      }
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const current = observe(id);
        if (
          current.server !== "owned" &&
          current.supervisor !== "owned" &&
          current.server !== "unverified" &&
          current.supervisor !== "unverified"
        )
          return status(id);
        await Bun.sleep(100);
      }
      throw Error(`${id}: clean stop exceeded its time limit. State remains intact.`);
    }),
  );
}

export async function recover(id: string) {
  profile(id);
  initDir(id);
  return lock(join(STATE, "admission.lock"), () =>
    lock(join(dir(id), "lifecycle.lock"), async () => {
      const o = observe(id);
      if (!o.record) return status(id);
      if ([o.supervisor, o.server].some((s) => s === "owned" || s === "unverified"))
        throw Error(
          `${id}: a recorded process is live or its ownership is unknown. Stop it or inspect it before recovery.`,
        );
      if (!o.clean && !o.record.serverPid && o.record.serverState !== "not-started")
        throw Error(
          `${id}: the old record does not identify its server. Inspect the browser processes before manual recovery.`,
        );
      const archived = join(dir(id), `running.recovered-${crypto.randomUUID()}.json`);
      renameSync(join(dir(id), "running.json"), archived);
      return { ...status(id), recovered: true, archived };
    }),
  );
}

export const key = (id: string) => readFileSync(join(dir(id), "access-key"), "utf8").trim();
export const intervention = (id: string, action: "pause" | "resume" | "handoff" | "check") =>
  request(id, "POST", action, 75000);

const LOG_LIMIT = 1024 * 1024;
export function rotateLog(file: string, incoming = 0) {
  try {
    if (statSync(file).size + incoming > LOG_LIMIT) renameSync(file, `${file}.1`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
export function logs(id: string, lines = 100) {
  profile(id);
  if (!Number.isInteger(lines) || lines < 1 || lines > 500)
    throw Error("Log lines must be between 1 and 500.");
  const read = (name: string) => {
    const file = join(dir(id), name);
    let fd: number | undefined;
    try {
      fd = openSync(file, "r");
      const size = fstatSync(fd).size,
        length = Math.min(size, 65536);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      let text = buffer.toString("utf8");
      if (size > length) text = text.slice(text.indexOf("\n") + 1);
      return text.replace(/\n$/, "").split("\n").slice(-lines).join("\n");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw e;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };
  return { identityId: id, server: read("server.log"), supervisor: read("supervisor.log") };
}
export async function doctor(target?: string) {
  const result: Record<string, unknown> = {
    home: HOME_DIR,
    initialized: existsSync(join(HOME_DIR, "identities.json")),
    setup: existsSync(join(HOME_DIR, "runtime/versions.json")),
    node: !!Bun.which("node"),
    browserExecutable: existsSync(executable()),
  };
  if (!result.initialized) return result;
  const ids = target && target !== "all" ? [target] : settings().identities.map((p) => p.id);
  result.identities = await Promise.all(
    ids.map(async (id) => {
      const p = profile(id);
      let configuration: string = "ok";
      try {
        configurationHash(p);
      } catch (e) {
        configuration = (e as Error).message;
      }
      return {
        ...(await reportStatus(id)),
        configuration,
        accessKey: existsSync(join(dir(id), "access-key")),
      };
    }),
  );
  return result;
}
