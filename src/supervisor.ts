import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  HOME_DIR,
  STATE,
  UPSTREAM,
  profile,
  dir,
  base,
  proxyEnvironment,
  executable,
  json,
  save,
  initDir,
  secret,
  configurationHash,
} from "./config.ts";
import { key, lock, processStart, rotateLog, type Running } from "./runtime.ts";

process.umask(0o077);
const p = profile(process.argv[2]!);
initDir(p.id);
const runtimeDir = dir(p.id),
  instanceId = process.argv[3];
if (!instanceId) throw Error("A supervisor requires a reserved service instance.");
for (const name of ["storage", "cookies", "uploads", "traces", "tmp"])
  mkdirSync(join(runtimeDir, name), { recursive: true, mode: 0o700 });
const proxy = proxyEnvironment(p),
  secrets = [proxy.PROXY_USERNAME, proxy.PROXY_PASSWORD]
    .filter(Boolean)
    .flatMap((s) => [s!, decodeURIComponent(s!)]) as string[];
function redact(s: string) {
  let value = s.replace(/(https?|socks5):\/\/[^\s/@]+:[^\s/@]+@/g, "$1://[redacted]@");
  for (const secret of secrets) {
    value = value.replaceAll(secret, "[redacted]").replaceAll(encodeURIComponent(secret), "[redacted]");
  }
  return value;
}
function log(line: string) {
  const file = join(runtimeDir, "server.log"),
    value = `${redact(line)}\n`;
  rotateLog(file, Buffer.byteLength(value));
  appendFileSync(file, value, { mode: 0o600 });
}
const inherited: Record<string, string> = {};
for (const name of ["PATH", "HOME", "LANG", "LC_ALL", "USER", "LOGNAME", "SHELL", "TMPDIR"])
  if (process.env[name]) inherited[name] = process.env[name]!;
const env = {
  ...inherited,
  ...proxy,
  CAMOUFOX_EXECUTABLE: executable(),
  CAMOFOX_BIND_HOST: "127.0.0.1",
  CAMOFOX_PORT: String(p.port),
  CAMOFOX_INTERACTIVE: "desktop",
  CAMOFOX_ACCESS_KEY: key(p.id),
  CAMOFOX_API_KEY: key(p.id),
  CAMOFOX_PROFILE_DIR: join(runtimeDir, "storage"),
  CAMOFOX_COOKIES_DIR: join(runtimeDir, "cookies"),
  CAMOFOX_UPLOADS_DIR: join(runtimeDir, "uploads"),
  CAMOFOX_TRACES_DIR: join(runtimeDir, "traces"),
  CAMOFOX_DISABLE_DEFAULT_ADDONS: "1",
  CAMOFOX_CRASH_REPORT_ENABLED: "false",
  SESSION_TIMEOUT_MS: "0",
  BROWSER_IDLE_TIMEOUT_MS: "0",
  MAX_SESSIONS: "1",
  TAB_INACTIVITY_MS: "31536000000",
  STELZ_STORAGE_MODE: p.storage || "checkpoint",
  STELZ_PROFILE_ID: p.id,
  STELZ_PROFILE_DIR: runtimeDir,
  STELZ_MODE: p.mode,
  STELZ_EXPECTED_IP: p.expectedIPEnv ? secret(p.expectedIPEnv) || "" : "",
  STELZ_HOME: HOME_DIR,
  STELZ_UPSTREAM: UPSTREAM,
};

// The child waits on its private stdin until its PID and birth stamp are saved.
// If this supervisor dies first, EOF makes the child exit before loading Camofox.
const bootstrap = `let started = false;
process.stdin.once('data', () => {
  started = true; process.stdin.destroy();
  import(require('node:url').pathToFileURL(process.argv[1]).href).catch(e => { console.error(e); process.exit(1); });
});
process.stdin.once('end', () => { if (!started) process.exit(1); });
process.stdin.resume();`;
const server = await lock(join(STATE, "admission.lock"), async () => {
  const file = join(runtimeDir, "running.json"),
    record = json<Running>(file),
    supervisorStart = processStart(process.pid);
  if (
    !record ||
    record.instanceId !== instanceId ||
    record.serverState !== "not-started" ||
    !supervisorStart ||
    (record.pid && (record.pid !== process.pid || record.supervisorStart !== supervisorStart))
  )
    throw Error("The service reservation is no longer valid.");
  if (record.configurationHash !== configurationHash(p))
    throw Error("Identity configuration changed during startup.");
  const reserved = { ...record, pid: process.pid, supervisorStart };
  save(file, reserved);
  const child = Bun.spawn(["node", "-e", bootstrap, join(UPSTREAM, "server.js")], {
    cwd: UPSTREAM,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const serverStart = processStart(child.pid);
  if (!serverStart) {
    child.stdin.end();
    throw Error("Could not verify the new server process.");
  }
  save(file, {
    ...reserved,
    serverPid: child.pid,
    serverStart,
    serverState: "started",
    configurationHash: configurationHash(p),
  });
  child.stdin.write("start\n");
  child.stdin.end();
  return child;
});
async function capture(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let pending = "",
    dropping = false;
  for await (const bytes of stream) {
    const parts = decoder.decode(bytes, { stream: true }).split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (!dropping) {
        pending += parts[i];
        if (pending.length > 16384) {
          pending = "";
          dropping = true;
        }
      }
      if (i < parts.length - 1) {
        log(dropping ? "[oversized log line omitted]" : pending);
        pending = "";
        dropping = false;
      }
    }
  }
  if (dropping) log("[oversized log line omitted]");
  else if (pending) log(pending);
}
const logs = Promise.all([capture(server.stdout), capture(server.stderr)]).catch((e) => {
  log(`Log capture failed: ${(e as Error).message}`);
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  const record = json<Running>(join(runtimeDir, "running.json"));
  if (
    record?.instanceId === instanceId &&
    record.serverPid === server.pid &&
    record.serverStart &&
    processStart(server.pid) === record.serverStart
  )
    server.kill("SIGTERM");
  else log("Server ownership could not be verified; no signal was sent.");
  // Leave an unresponsive owned server recorded instead of killing an unknown
  // browser tree or hanging the supervisor forever.
  setTimeout(() => {
    log("Server shutdown timed out; the service remains recorded.");
    process.exit(1);
  }, 12000).unref();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
// Create the original context explicitly; MCP requests never launch a substitute.
const initialize = async () => {
  for (let n = 0; n < 240 && !stopping; n++) {
    try {
      const health = await fetch(`${base(p)}/health`, { signal: AbortSignal.timeout(1000) });
      if (health.ok) {
        const r = await fetch(`${base(p)}/tabs`, {
          method: "POST",
          headers: { Authorization: `Bearer ${key(p.id)}`, "Content-Type": "application/json" },
          body: JSON.stringify({ userId: p.id, sessionKey: "default", url: `${base(p)}/health` }),
          signal: AbortSignal.timeout(65000),
        });
        if (!r.ok) throw Error("Original browser context could not be initialized");
        save(join(runtimeDir, "initialized.json"), { instanceId });
        return;
      }
    } catch (e) {
      if (String(e).includes("initialized")) {
        log(String(e));
        return;
      }
    }
    await Bun.sleep(250);
  }
};
void initialize();
const exitCode = await server.exited;
await Promise.race([logs, Bun.sleep(1000)]);
const old = json<Record<string, unknown>>(join(runtimeDir, "status.json"));
const clean = exitCode === 0 && old?.phase === "stopped";
save(join(runtimeDir, "status.json"), {
  ...old,
  identityId: p.id,
  phase: clean ? "stopped" : "unclean",
  exitCode,
});
if (clean) save(join(runtimeDir, "stopped.json"), { instanceId });
process.exit(exitCode);
