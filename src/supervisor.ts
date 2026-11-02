import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, UPSTREAM, profile, dir, base, proxyEnvironment, executable, json, save, initDir } from "./config.ts";
import { key } from "./runtime.ts";

process.umask(0o077);
const p = profile(process.argv[2]!); initDir(p.id);
const runtimeDir = dir(p.id);
for (const name of ["storage", "cookies", "uploads", "traces", "tmp"]) mkdirSync(join(runtimeDir, name), { recursive: true, mode: 0o700 });
const proxy = proxyEnvironment(p), secrets = [proxy.PROXY_USERNAME, proxy.PROXY_PASSWORD].filter(Boolean).flatMap(s => [s!, decodeURIComponent(s!)]) as string[];
function redact(s: string) {
  let value = s.replace(/(https?|socks5):\/\/[^\s/@]+:[^\s/@]+@/g, "$1://[redacted]@");
  for (const secret of secrets) { value = value.replaceAll(secret, "[redacted]").replaceAll(encodeURIComponent(secret), "[redacted]"); }
  return value;
}
const inherited: Record<string, string> = {};
for (const name of ["PATH", "HOME", "LANG", "LC_ALL", "USER", "LOGNAME", "SHELL", "TMPDIR"]) if (process.env[name]) inherited[name] = process.env[name]!;
const env = {
  ...inherited, ...proxy,
  CAMOUFOX_EXECUTABLE: executable(), CAMOFOX_BIND_HOST: "127.0.0.1", CAMOFOX_PORT: String(p.port),
  CAMOFOX_INTERACTIVE: "desktop", CAMOFOX_ACCESS_KEY: key(p.id), CAMOFOX_API_KEY: key(p.id),
  CAMOFOX_PROFILE_DIR: join(runtimeDir, "storage"), CAMOFOX_COOKIES_DIR: join(runtimeDir, "cookies"),
  CAMOFOX_UPLOADS_DIR: join(runtimeDir, "uploads"), CAMOFOX_TRACES_DIR: join(runtimeDir, "traces"),
  CAMOFOX_DISABLE_DEFAULT_ADDONS: "1", CAMOFOX_CRASH_REPORT_ENABLED: "false",
  SESSION_TIMEOUT_MS: "0", BROWSER_IDLE_TIMEOUT_MS: "0", MAX_SESSIONS: "1",
  TAB_INACTIVITY_MS: "31536000000",
  STELZ_PROFILE_ID: p.id, STELZ_PROFILE_DIR: runtimeDir, STELZ_MODE: p.mode,
  STELZ_EXPECTED_IP: p.expectedIPEnv ? process.env[p.expectedIPEnv] || "" : "",
};
const instanceId = process.argv[3] || crypto.randomUUID();
const server = Bun.spawn(["node", join(UPSTREAM, "server.js")], { cwd: UPSTREAM, env, stdout: "pipe", stderr: "pipe" });
save(join(runtimeDir, "running.json"), { pid: process.pid, serverPid: server.pid, instanceId });
async function capture(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder(); let pending = "";
  for await (const bytes of stream) {
    pending += decoder.decode(bytes, { stream: true });
    const lines = pending.split("\n"); pending = lines.pop()!;
    for (const line of lines) appendFileSync(join(runtimeDir, "server.log"), `${redact(line)}\n`, { mode: 0o600 });
  }
  if (pending) appendFileSync(join(runtimeDir, "server.log"), redact(pending), { mode: 0o600 });
}
const logs = Promise.all([capture(server.stdout), capture(server.stderr)]);
let stopping = false;
function stop() { if (!stopping) { stopping = true; server.kill("SIGTERM"); } }
process.on("SIGTERM", stop); process.on("SIGINT", stop);
// Create the original context explicitly; MCP requests never launch a substitute.
const initialize = async () => {
  for (let n = 0; n < 240 && !stopping; n++) {
    try {
      const health = await fetch(`${base(p)}/health`, { signal: AbortSignal.timeout(1000) });
      if (health.ok) {
        const r = await fetch(`${base(p)}/tabs`, { method: "POST", headers: { Authorization: `Bearer ${key(p.id)}`, "Content-Type": "application/json" }, body: JSON.stringify({ userId: p.id, sessionKey: "default", url: `${base(p)}/health` }), signal: AbortSignal.timeout(65000) });
        if (!r.ok) throw Error("Original browser context could not be initialized");
        save(join(runtimeDir, "initialized.json"), { instanceId });
        return;
      }
    } catch (e) {
      if (String(e).includes("initialized")) { appendFileSync(join(runtimeDir, "server.log"), `${redact(String(e))}\n`); stop(); return; }
    }
    await Bun.sleep(250);
  }
};
void initialize();
const exitCode = await server.exited;
await logs;
const old = json<Record<string, unknown>>(join(runtimeDir, "status.json"));
const clean = exitCode === 0 && old?.phase === "stopped";
save(join(runtimeDir, "status.json"), { ...old, profileId: p.id, phase: clean ? "stopped" : "unclean", exitCode });
if (clean) save(join(runtimeDir, "stopped.json"), { instanceId });
process.exit(exitCode);
