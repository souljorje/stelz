import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  HOME_DIR,
  STATE,
  runtimeDir as serviceRuntime,
  upstream,
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
  typingMode,
  ipCheckIntervalMs,
} from "../profiles/config.ts";
import { key, lock, processStart, rotateLog, type Running } from "./runtime.ts";
import { assertRuntimePlugin } from "./runtime-plugin.ts";
import { assertLocationCurrent } from "./location-preflight.ts";
import { ACTION_LIMIT_MS } from "../browser/deadlines.ts";
import { locationFailure, readLocationRecord, writeLocationRecord } from "../browser/location.ts";
import { commitFingerprint, writeInitialized, type FingerprintOwner } from "../browser/fingerprint-transaction.ts";

process.umask(0o077);
const p = profile(process.argv[2]!);
initDir(p.id);
const runtimeDir = dir(p.id),
  instanceId = process.argv[3];
if (!instanceId) throw Error("A supervisor requires a reserved service instance.");
const bootstrapToken = crypto.randomUUID() + crypto.randomUUID();
for (const name of ["storage", "cookies", "uploads", "traces", "tmp"])
  mkdirSync(join(runtimeDir, name), { recursive: true, mode: 0o700 });
const secrets: string[] = [];
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
  CAMOUFOX_EXECUTABLE: executable(),
  CAMOUFOX_FPGEN_DATA: join(serviceRuntime(), "fpgen"),
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
  // Upstream route limit for clicks, navigation, and other short actions.
  HANDLER_TIMEOUT_MS: String(ACTION_LIMIT_MS),
  MAX_SESSIONS: "1",
  TAB_INACTIVITY_MS: "31536000000",
  STELZ_TYPING_MODE: typingMode(),
  STELZ_IP_CHECK_INTERVAL_MS: String(ipCheckIntervalMs()),
  STELZ_PROFILE_ID: p.id,
  STELZ_PROFILE_DIR: runtimeDir,
  STELZ_EXPECTED_IP: "",
  STELZ_HOME: HOME_DIR,
  STELZ_RUNTIME: serviceRuntime(),
  STELZ_UPSTREAM: upstream(),
  STELZ_START_ID: instanceId,
  STELZ_CONFIGURATION_HASH: "",
  STELZ_BOOTSTRAP_TOKEN: bootstrapToken,
};

// The child waits on its private stdin until its PID and birth stamp are saved.
// If this supervisor dies first, EOF makes the child exit before loading Camofox.
const bootstrap = `let started = false;
process.stdin.once('data', async () => {
  started = true; process.stdin.destroy();
  // Install the instance-bound startup gate before upstream registers routes.
  const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
  const plugin = require('node:url').pathToFileURL(path.join(process.env.STELZ_UPSTREAM, 'plugins/local-profile/index.js')).href;
  let initializedFingerprint;
  try {
    ({ initializedFingerprint } = await import(plugin));
    if (typeof initializedFingerprint !== 'function') throw Error('Startup admission is unavailable.');
  } catch (error) { console.error(error); process.exit(1); return; }
  const createServer = http.createServer;
  let bootstrapUsed = false;
  http.createServer = function (...args) {
    const server = createServer.apply(this, args), emit = server.emit;
    server.emit = function (event, ...values) {
        if (event !== 'request' || server.address()?.port !== Number(process.env.CAMOFOX_PORT)) return emit.call(this, event, ...values);
        const [req, res] = values, next = () => emit.call(this, event, ...values), route = (req.url || '').split('?')[0];
        const directory = process.env.STELZ_PROFILE_DIR;
        const raw = name => {
          let fd;
          try {
            const file = path.join(directory, name), before = fs.lstatSync(file);
            fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            const after = fs.fstatSync(fd);
            if (!before.isFile() || !after.isFile() || after.nlink !== 1 || before.dev !== after.dev || before.ino !== after.ino ||
                (process.getuid && after.uid !== process.getuid())) return null;
            return fs.readFileSync(fd, 'utf8');
          } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
        };
        const read = name => { try { return JSON.parse(raw(name)); } catch { return null; } };
        const running = read('running.json'), state = read('status.json');
        const owned = running && running.instanceId === process.env.STELZ_START_ID &&
          running.configurationHash === process.env.STELZ_CONFIGURATION_HASH && running.serverPid === process.pid;
        const ready = owned && state && state.profileId === process.env.STELZ_PROFILE_ID && typeof state.instanceId === 'string' &&
          typeof state.pinSha256 === 'string' && ['ready', 'paused', 'verification_failed'].includes(state.phase) &&
          initializedFingerprint(directory, { profileId: process.env.STELZ_PROFILE_ID, attemptId: process.env.STELZ_START_ID,
            browserInstanceId: state.instanceId, configurationHash: process.env.STELZ_CONFIGURATION_HASH, serverPid: process.pid }, state.pinSha256);
        if (ready) return next();
        if (['/health', '/local-profile/status', '/local-profile/windows', '/local-profile/network-bridge',
             '/local-profile/window-bridge', '/local-profile/stop'].includes(route)) return next();
        if (owned && req.method === 'POST' && route === '/local-profile/release') return next();
        const secret = req.headers['x-stelz-bootstrap'] === process.env.STELZ_BOOTSTRAP_TOKEN;
        if (owned && secret && req.method === 'POST' && route === '/tabs' && !bootstrapUsed) {
          bootstrapUsed = true; return next();
        }
        if (owned && secret && req.method === 'POST' && route === '/local-profile/startup-ack') return next();
        res.statusCode = 409; res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'Profile startup is not admitted.' }));
        return true;
    };
    return server;
  };
  require('node:module').syncBuiltinESMExports();
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
  try {
    const current = profile(p.id);
    if (record.configurationHash !== configurationHash(current)) throw Error("Profile configuration changed during startup.");
    env.STELZ_CONFIGURATION_HASH = record.configurationHash;
    assertRuntimePlugin();
    const proxy = proxyEnvironment(current);
    secrets.push(...[proxy.PROXY_USERNAME, proxy.PROXY_PASSWORD].filter(Boolean).flatMap(value => [value!, decodeURIComponent(value!)]));
    Object.assign(env, proxy, { STELZ_EXPECTED_IP: current.expectedIPEnv ? secret(current.expectedIPEnv) || "" : "" });
    if (current.proxyEnv) {
      const location = readLocationRecord(runtimeDir);
      if (!location?.prepared || location.attemptId !== instanceId || location.result.status !== "ready") throw Error("Location preflight is missing for this startup.");
      await assertLocationCurrent(current.id, location.inputId);
      Object.assign(env, { STELZ_LOCATION_LAUNCH: JSON.stringify(location) });
    }
  } catch (error) {
    const location = readLocationRecord(runtimeDir);
    if (location?.attemptId === instanceId) {
      const failure = locationFailure("LOCATION_INPUT_CHANGED", location.result);
      writeLocationRecord(runtimeDir, { ...location, result: failure.location });
    }
    // This owned reservation has not created a server or browser.
    save(join(runtimeDir, "stopped.json"), { instanceId });
    save(join(runtimeDir, "status.json"), { profileId: p.id, phase: "stopped" });
    throw error;
  }
  const reserved = { ...record, pid: process.pid, supervisorStart };
  save(file, reserved);
  const child = Bun.spawn(["node", "-e", bootstrap, join(env.STELZ_UPSTREAM, "server.js")], {
    cwd: env.STELZ_UPSTREAM,
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
      if (health.ok && (await health.json() as { browserRunning?: boolean }).browserRunning === true) {
        try {
          const r = await fetch(`${base(p)}/tabs`, {
            method: "POST",
            headers: { Authorization: `Bearer ${key(p.id)}`, "Content-Type": "application/json", "x-stelz-bootstrap": bootstrapToken },
            body: JSON.stringify({ userId: p.id, sessionKey: "default", stelzStartup: true }),
            signal: AbortSignal.timeout(65000),
          });
          if (!r.ok) throw Error("Original browser context could not be initialized");
          const response = await fetch(`${base(p)}/local-profile/status`, { headers: { Authorization: `Bearer ${key(p.id)}` },
            signal: AbortSignal.timeout(2000) });
          if (!response.ok) throw Error("Prepared browser status is unavailable.");
          const prepared = await response.json() as { instanceId?: unknown; startupPrepared?: unknown; pinSha256?: unknown; phase?: unknown };
          if (typeof prepared.instanceId !== "string" || typeof prepared.pinSha256 !== "string" ||
              prepared.startupPrepared !== true || prepared.phase !== "starting") throw Error("Browser verification did not prepare startup.");
          await lock(join(STATE, "admission.lock"), async () => lock(join(runtimeDir, "lifecycle.lock"), async () => {
            const current = json<Running>(join(runtimeDir, "running.json"));
            const status = json<typeof prepared>(join(runtimeDir, "status.json"));
            if (stopping || !current || current.instanceId !== instanceId || current.pid !== process.pid ||
                current.serverPid !== server.pid || current.supervisorStart !== processStart(process.pid) ||
                current.serverStart !== processStart(server.pid) || current.serverState !== "started" ||
                current.configurationHash !== configurationHash(profile(p.id)) || status?.instanceId !== prepared.instanceId ||
                status?.startupPrepared !== true || status.phase !== "starting" || status.pinSha256 !== prepared.pinSha256)
              throw Error("The service reservation changed before fingerprint admission.");
            const owner: FingerprintOwner = { profileId: p.id, attemptId: instanceId, browserInstanceId: prepared.instanceId as string,
              configurationHash: current.configurationHash, serverPid: server.pid };
            commitFingerprint(runtimeDir, owner, prepared.pinSha256 as string);
            writeInitialized(runtimeDir, { instanceId, browserInstanceId: owner.browserInstanceId,
              configurationHash: owner.configurationHash, fingerprintSha256: prepared.pinSha256 as string });
          }));
          const ack = await fetch(`${base(p)}/local-profile/startup-ack`, { method: "POST",
            headers: { Authorization: `Bearer ${key(p.id)}`, "Content-Type": "application/json", "x-stelz-bootstrap": bootstrapToken },
            body: JSON.stringify({ instanceId, browserInstanceId: prepared.instanceId }), signal: AbortSignal.timeout(5000) });
          if (!ack.ok) throw Error("Browser startup acknowledgment failed.");
          return;
        } catch (error) {
          log(`Startup failed: ${String(error)}`);
          stop();
          return;
        }
      }
    } catch (e) {
      if (stopping) return;
    }
    await Bun.sleep(250);
  }
};
void initialize();
const exitCode = await server.exited;
await Promise.race([logs, Bun.sleep(1000)]);
const old = json<Record<string, unknown>>(join(runtimeDir, "status.json")) || {};
const failed = old.phase === "blocked";
const clean = exitCode === 0 && (old.phase === "stopped" || failed);
save(join(runtimeDir, "status.json"), {
  ...old,
  profileId: p.id,
  phase: failed ? "blocked" : clean ? "stopped" : "unclean",
  exitCode,
});
if (clean) save(join(runtimeDir, "stopped.json"), { instanceId });
process.exit(exitCode);
