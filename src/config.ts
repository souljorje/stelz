import { readFileSync, mkdirSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { createHash } from "node:crypto";
import { UPSTREAM_VERSION } from "./versions.ts";
import { parseTypingMode } from "./typing.ts";
export { UPSTREAM_VERSION, COMMIT } from "./versions.ts";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const HOME_DIR = resolve(process.env.STELZ_HOME || join(homedir(), ".local/share/stelz"));
export const STATE = join(HOME_DIR, "identities");
export const UPSTREAM = join(HOME_DIR, "runtime", `camofox-${UPSTREAM_VERSION}`);
export type Profile = { id: string; port: number; mode: "direct" | "proxy"; proxyEnv?: string; expectedIPEnv?: string; storage?: "native" | "checkpoint" };
export type Settings = { maxActive: number; identities: Profile[] };
export function initialize() {
  mkdirSync(STATE, { recursive: true, mode: 0o700 });
  const config = join(HOME_DIR, "identities.json");
  if (!existsSync(config)) save(config, { maxActive: 2, identities: [] });
  const secrets = join(HOME_DIR, "secrets.env");
  if (!existsSync(secrets)) writeFileSync(secrets, "", { mode: 0o600, flag: "wx" });
}
export function settings(): Settings {
  const value = json<Settings>(join(HOME_DIR, "identities.json"));
  if (!value) throw Error("Run stelz init first.");
  return validateSettings(value);
}
export function validateSettings(value: Settings): Settings {
  if (!value || typeof value !== "object" || !Number.isInteger(value.maxActive) || value.maxActive < 1 || value.maxActive > 2 || !Array.isArray(value.identities) || value.identities.length > 1000) throw Error("Configure at most 1000 saved identities and two active browsers.");
  const ids = new Set<string>(), ports = new Set<number>();
  for (const p of value.identities) {
    if (!p || typeof p !== "object" || typeof p.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(p.id) || !Number.isInteger(p.port) || p.port < 1024 || p.port > 65535 || !["direct", "proxy"].includes(p.mode) || ids.has(p.id) || ports.has(p.port)) throw Error("Identity IDs and ports must be valid and unique.");
    if (p.storage !== undefined && !["native", "checkpoint"].includes(p.storage)) throw Error("Storage must be native or checkpoint.");
    for (const name of [p.proxyEnv, p.expectedIPEnv]) {
      if (name !== undefined && (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name))) throw Error("Environment variable names must be valid.");
    }
    ids.add(p.id); ports.add(p.port);
  }
  return value;
}
export function profile(id: string): Profile {
  const p = settings().identities.find(p => p.id === id);
  if (!p) throw Error(`Unknown identity: ${id}`);
  return p;
}
export const dir = (id: string) => join(STATE, id);
export const base = (p: Profile) => `http://127.0.0.1:${p.port}`;
export function secret(name: string) {
  const file = join(HOME_DIR, "secrets.env");
  return process.env[name] ?? (existsSync(file) ? parseEnv(readFileSync(file, "utf8"))[name] : undefined);
}
export const executable = () => secret("CAMOUFOX_EXECUTABLE") || join(homedir(), "Library/Caches/camoufox/Camoufox.app/Contents/MacOS/camoufox");
export const typingMode = () => parseTypingMode(secret("STELZ_TYPING_MODE"));
export function entry(name: string) {
  const built = join(ROOT, "dist", `${name}.js`);
  return existsSync(built) ? built : join(ROOT, "src", `${name}.ts`);
}
export function json<T>(file: string): T | undefined {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw Error(`Cannot read state: ${file}`); }
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
  const raw = p.proxyEnv && secret(p.proxyEnv);
  if (!raw) throw Error(`${p.id}: set ${p.proxyEnv || "proxyEnv"} in ${join(HOME_DIR, "secrets.env")}. Direct fallback is disabled.`);
  const u = validateProxy(raw, p.id);
  return { PROXY_STRATEGY: "round_robin", PROXY_PROTOCOL: u.protocol.slice(0, -1), PROXY_HOST: u.hostname, PROXY_PORT: u.port || (u.protocol === "http:" ? "80" : u.protocol === "https:" ? "443" : "1080"), PROXY_USERNAME: u.username, PROXY_PASSWORD: u.password };
}
export function validateProxy(raw: string, id = "Identity"): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw Error(`${id}: proxy URL is invalid. Credentials are hidden.`); }
  if (!["http:", "https:", "socks5:"].includes(u.protocol) || !u.hostname || u.pathname !== "/" && u.pathname !== "" || u.search || u.hash) throw Error(`${id}: use HTTP(S) or unauthenticated SOCKS5.`);
  if (u.protocol === "socks5:" && (u.username || u.password)) throw Error(`${id}: SOCKS5 authentication is not supported. Use an HTTP proxy.`);
  try { decodeURIComponent(u.username); decodeURIComponent(u.password); } catch { throw Error(`${id}: proxy credentials have invalid percent encoding.`); }
  return u;
}
export const configurationHash = (p: Profile) => createHash("sha256").update(JSON.stringify({ ...p, proxy: proxyEnvironment(p), expectedIP: p.expectedIPEnv ? secret(p.expectedIPEnv) || "" : "", ...(typingMode() === "instant" ? { typingMode: "instant" } : {}) })).digest("hex");
export async function control(p: Profile, method: string, action: string, body?: unknown) {
  const token = readFileSync(join(dir(p.id), "access-key"), "utf8").trim();
  const r = await fetch(`${base(p)}/local-profile/${action}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120000) });
  const payload = await r.json() as Record<string, unknown>;
  if (!r.ok) throw Error(String(payload.error || `Identity control returned ${r.status}.`));
  return payload;
}
