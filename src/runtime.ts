import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { lock, observe, observeStatus, isRuntimePhase, processStart, running, type Running } from "./profile-process.ts";
export { assertStoppedProfile, lock, processStart, running, type Running } from "./profile-process.ts";
import { prepareProfileConfiguration, recoverProfileCatalog } from "./profile-configuration.ts";
import { normalizeProfileId } from "./profile-compat.ts";
import {
  pendingNetworkTransaction,
} from "./network-transaction.ts";
import {
  HOME_DIR,
  CONFIG_FILE,
  STATE,
  settings,
  profile,
  dir,
  initDir,
  save,
  json,
  base,
  configurationHash,
  entry,
  executable,
  type Profile,
} from "./config.ts";

function isLegacy(record: Running) {
  return record.version === undefined && record.supervisorStart === undefined &&
    record.serverStart === undefined && record.serverState === undefined;
}
export function status(id: string) {
  return observeStatus(profile(id));
}
export function assertRunning(id: string, validateConfiguration = false) {
  const p = profile(id),
    o = observe(id);
  if (!o.record) throw Error(`Profile is stopped. Run stelz start ${id}.`);
  if (o.supervisor !== "owned" || o.server !== "owned")
    throw Error(`${id}: process ownership or supervisor is unavailable. Run stelz doctor ${id}.`);
  if (validateConfiguration && o.record.configurationHash !== configurationHash(p))
    throw Error("Profile configuration changed. Stop the profile before you restart it.");
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
  const payload = normalizeProfileId(await response.json() as Record<string, unknown>);
  if (!response.ok) throw Error(String(payload.error || `Profile control returned ${response.status}.`));
  return payload;
}

// Legacy records cannot establish PID ownership. An explicit stop can still use
// the authenticated endpoint after matching its saved profile and instance.
// Never promote these PIDs to verified ownership or use the signal fallback.
async function stopLegacy(id: string, record: Running) {
  const p = profile(id);
  if (record.configurationHash !== configurationHash(p)) {
    throw Error(`${id}: restore the legacy launch configuration before stopping this profile.`);
  }
  const saved = normalizeProfileId(json<Record<string, unknown>>(join(dir(id), "status.json")) || {});
  if (saved?.profileId !== id || !saved.instanceId || typeof saved.instanceId !== "string") {
    throw Error(`${id}: the saved legacy service profile is missing. Inspect the service before stopping it.`);
  }
  const remote = await serviceRequest(p, "GET", "status", 2000);
  if (remote.profileId !== id || remote.instanceId !== saved.instanceId) {
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
  settings();
  await prepareProfileConfiguration(async () => {
    const p = profile(id), configHash = configurationHash(p);
    initDir(id);
    if (!existsSync(join(HOME_DIR, "runtime/versions.json"))) throw Error("Run stelz setup first.");
    const o = observe(id);
    if (running(id)) {
      if (o.supervisor !== "owned" || o.server === "unverified" || o.server === "different")
        throw Error(`${id}: the previous service needs inspection. Run stelz doctor ${id}.`);
      if (o.record?.configurationHash !== configHash)
        throw Error("Profile configuration changed. Stop the profile before you restart it.");
      if (["stopping", "stopped"].includes(String(status(id).phase)))
        throw Error("The browser is closing. Wait for shutdown before starting this profile.");
      return;
    }
    if (o.record && !o.clean)
      throw Error(
        `${id}: previous stop was not clean. Run stelz recover ${id} after inspecting its processes.`,
      );
    const profiles = readdirSync(STATE, { withFileTypes: true });
    if (profiles.some((item) => item.isSymbolicLink()))
      throw Error("Profile state contains a symbolic link.");
    const active = profiles.filter((item) => item.isDirectory() && running(item.name)).length;
    if (active >= settings().maxActive)
      throw Error("The browser limit is reached. Stop another profile first.");
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
        if (s.phase === "blocked") throw Error(String(s.error || "Profile is blocked."));
        if (["stopping", "stopped"].includes(String(s.phase))) throw Error("The browser closed during launch. Wait for shutdown before starting it again.");
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
  return lock(join(STATE, "admission.lock"), async () => {
    // A pending deletion may already have archived this directory. Never create
    // a replacement while recovering its catalog entry. Existing live profiles
    // remain stoppable even when another catalog transaction needs inspection.
    if (!existsSync(dir(id))) {
      await recoverProfileCatalog();
      return status(id);
    }
    return lock(join(dir(id), "lifecycle.lock"), async () => {
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
    });
  });
}

export async function recover(id: string) {
  profile(id);
  return lock(join(STATE, "admission.lock"), async () => {
    if (!existsSync(dir(id))) {
      await recoverProfileCatalog();
      return status(id);
    }
    return lock(join(dir(id), "lifecycle.lock"), async () => {
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
    });
  });
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
  return { profileId: id, server: read("server.log"), supervisor: read("supervisor.log") };
}
export async function doctor(target?: string) {
  const pending = pendingNetworkTransaction();
  const result: Record<string, unknown> = {
    home: HOME_DIR,
    initialized: existsSync(CONFIG_FILE),
    setup: existsSync(join(HOME_DIR, "runtime/versions.json")),
    node: !!Bun.which("node"),
    browserExecutable: existsSync(executable()),
    ...(pending ? { networkRecovery: pending.message } : {}),
  };
  if (!result.initialized) return result;
  const ids = target && target !== "all" ? [target] : settings().profiles.map((p) => p.id);
  result.profiles = await Promise.all(
    ids.map(async (id) => {
      const p = profile(id);
      let configuration: string = "ok";
      try {
        configurationHash(p);
      } catch (e) {
        configuration = (e as Error).message;
      }
      if (pending && (!pending.profileId || pending.profileId === id)) configuration = pending.message;
      return {
        ...(await reportStatus(id)),
        configuration,
        accessKey: existsSync(join(dir(id), "access-key")),
      };
    }),
  );
  return result;
}
