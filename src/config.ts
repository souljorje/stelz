import { readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

export const ROOT = resolve(import.meta.dir, "..");
export const UPSTREAM = join(ROOT, ".runtime/camofox");
export const COMMIT = "39c82094013480b373df6600d44c7f036f58356e";
export const STATE = resolve(process.env.STELZ_STATE_DIR || join(ROOT, ".state"));
export type Profile = { id: string; port: number; mode: "direct" | "proxy"; proxyEnv?: string; expectedIPEnv?: string };
export type Settings = { maxActive: number; profiles: Profile[] };
export function settings(): Settings {
  const value = JSON.parse(readFileSync(process.env.STELZ_CONFIG || join(ROOT, "profiles.json"), "utf8")) as Settings;
  if (!Number.isInteger(value.maxActive) || value.maxActive < 1 || !Array.isArray(value.profiles)) throw Error("Invalid profile configuration");
  const ids = new Set<string>(), ports = new Set<number>();
  for (const p of value.profiles) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(p.id) || !Number.isInteger(p.port) || p.port < 1024 || p.port > 65535 || !["direct", "proxy"].includes(p.mode) || ids.has(p.id) || ports.has(p.port)) throw Error("Invalid or duplicate profile ID/port");
    ids.add(p.id); ports.add(p.port);
  }
  return value;
}
export function profile(id: string): Profile {
  const p = settings().profiles.find(p => p.id === id);
  if (!p) throw Error(`Unknown profile: ${id}`);
  return p;
}
export const dir = (id: string) => join(STATE, id);
export const base = (p: Profile) => `http://127.0.0.1:${p.port}`;
export const executable = () => process.env.CAMOUFOX_EXECUTABLE || join(homedir(), "Library/Caches/camoufox/Camoufox.app/Contents/MacOS/camoufox");
export function json<T>(file: string): T | undefined {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw Error(`Unreadable state: ${file}`); }
}
export function save(file: string, value: unknown) {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(temp, file);
}
export function initDir(id: string) { mkdirSync(dir(id), { recursive: true, mode: 0o700 }); }
export function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}
export function proxyEnvironment(p: Profile): Record<string, string> {
  if (p.mode === "direct") return {};
  const raw = p.proxyEnv && process.env[p.proxyEnv];
  if (!raw) throw Error(`${p.id}: set ${p.proxyEnv || "proxyEnv"} in .env.local; proxy mode never falls back to direct`);
  let u: URL;
  try { u = new URL(raw); } catch { throw Error(`${p.id}: invalid proxy URL (credentials redacted)`); }
  if (!["http:", "https:", "socks5:"].includes(u.protocol) || !u.hostname || u.pathname !== "/" && u.pathname !== "" || u.search || u.hash) throw Error(`${p.id}: use http(s)://[user:pass@]host:port or unauthenticated socks5://host:port`);
  if (u.protocol === "socks5:" && (u.username || u.password)) throw Error(`${p.id}: authenticated SOCKS5 is unsupported; use an HTTP proxy; no relay or direct fallback is installed`);
  // Upstream normalizes credentials itself; retain URL encoding to avoid double decoding.
  const username = u.username, password = u.password;
  try { decodeURIComponent(username); decodeURIComponent(password); } catch { throw Error(`${p.id}: invalid percent-encoding in proxy credentials`); }
  return { PROXY_STRATEGY: "round_robin", PROXY_PROTOCOL: u.protocol.slice(0, -1), PROXY_HOST: u.hostname, PROXY_PORT: u.port || (u.protocol === "http:" ? "80" : u.protocol === "https:" ? "443" : "1080"), PROXY_USERNAME: username, PROXY_PASSWORD: password };
}
export async function control(p: Profile, method: string, action: string, body?: unknown) {
  const token = readFileSync(join(dir(p.id), "access-key"), "utf8").trim();
  const r = await fetch(`${base(p)}/local-profile/${action}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(45000) });
  const payload = await r.json() as Record<string, unknown>;
  if (!r.ok) throw Error(String(payload.error || `Profile control returned ${r.status}`));
  return payload;
}
