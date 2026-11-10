import { readFileSync, mkdirSync, writeFileSync, renameSync, existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { ROOT, entry } from "../paths.ts";
export { ROOT, entry } from "../paths.ts";
import { parseEnv } from "node:util";
import { createHash } from "node:crypto";
import { UPSTREAM_VERSION } from "../versions.ts";
import { isTypingMode, parseTypingMode, type TypingMode } from "../browser/typing.ts";
import { parseIpCheckInterval } from "../browser/ip-verification.ts";
import { validateProxy } from "./proxy-url.ts";
import { browserExecutable, pairedBrowser } from "../browser/camoufox.ts";
export { validateProxy } from "./proxy-url.ts";
export { UPSTREAM_VERSION, COMMIT } from "../versions.ts";

export const HOME_DIR = resolve(process.env.STELZ_HOME || join(homedir(), ".local/share/stelz"));
export const CONFIG_FILE = join(HOME_DIR, "profiles.json");
export const STATE = join(HOME_DIR, "profiles");
export const RUNTIME = join(HOME_DIR, "runtime");
export const RUNTIME_GENERATIONS = join(HOME_DIR, "runtime-generations");
export const isRuntimeId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{16}$/.test(value);
/** The runtime of this process. A service keeps the generation it started with; other callers resolve the current one per call. */
export function runtimeDir(): string {
  if (process.env.STELZ_RUNTIME) return process.env.STELZ_RUNTIME;
  try { if (!lstatSync(RUNTIME).isSymbolicLink()) return RUNTIME; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return RUNTIME; throw e; }
  // Never follow a link outside the generations. Start then asks for setup.
  return currentRuntimeId() ? realpathSync(RUNTIME) : join(RUNTIME_GENERATIONS, ".invalid");
}
/** The current generation ID, or undefined for a missing runtime or an earlier plain directory. */
export function currentRuntimeId(): string | undefined {
  try {
    if (!lstatSync(RUNTIME).isSymbolicLink()) return;
    const target = realpathSync(RUNTIME), id = basename(target);
    return dirname(target) === realpathSync(RUNTIME_GENERATIONS) && isRuntimeId(id) ? id : undefined;
  } catch { return; }
}
export const upstream = () => join(runtimeDir(), `camofox-${UPSTREAM_VERSION}`);
export type Profile = { id: string; name?: string; port: number; proxyEnv?: string; expectedIPEnv?: string; storage?: "native"; typingMode?: TypingMode };
export type Settings = { profiles: Profile[] };
export function parseProfileName(value: unknown): string {
  if (typeof value !== "string" || /[\p{Cc}\p{Bidi_Control}\u2028\u2029\u206a-\u206f]/u.test(value))
    throw Error("Use a display name with 1–80 characters and no control or directional format characters.");
  const name = value.trim();
  if (!name || name.length > 80)
    throw Error("Use a display name with 1–80 characters and no control or directional format characters.");
  return name;
}
export function initialize() {
  mkdirSync(STATE, { recursive: true, mode: 0o700 });
  if (!existsSync(CONFIG_FILE)) save(CONFIG_FILE, { profiles: [] });
  const secrets = join(HOME_DIR, "secrets.env");
  if (!existsSync(secrets)) writeFileSync(secrets, "", { mode: 0o600, flag: "wx" });
}
export function settings(): Settings {
  const value = json<unknown>(CONFIG_FILE);
  if (!value) throw Error("Run stelz setup first.");
  return validateSettings(value);
}
export function validateSettings(input: unknown): Settings {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("Configure a profile catalog.");
  if (Object.keys(input).some(key => key !== "profiles")) throw Error("The profile catalog accepts only profiles.");
  const value = input as Settings;
  if (!Array.isArray(value.profiles)) throw Error("Configure a profiles array.");
  const ids = new Set<string>(), ports = new Set<number>();
  for (const p of value.profiles) {
    if (!p || typeof p !== "object" || typeof p.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(p.id) || !Number.isInteger(p.port) || p.port < 1024 || p.port > 65535 || ids.has(p.id) || ports.has(p.port)) throw Error("Profile IDs and ports must be valid and unique.");
    if (Object.keys(p).some(key => !["id", "name", "port", "proxyEnv", "expectedIPEnv", "storage", "typingMode"].includes(key))) throw Error("Profile configuration contains an unknown field.");
    if (p.storage !== undefined && p.storage !== "native") throw Error("Storage must be native.");
    if (p.name !== undefined && parseProfileName(p.name) !== p.name) throw Error("Profile display names must have no leading or trailing whitespace.");
    if (p.typingMode !== undefined && !isTypingMode(p.typingMode)) throw Error("Typing mode must be balanced, keyboard, or instant.");
    for (const name of [p.proxyEnv, p.expectedIPEnv]) {
      if (name !== undefined && (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name))) throw Error("Environment variable names must be valid.");
    }
    ids.add(p.id); ports.add(p.port);
  }
  return value;
}

export function serializeSettings(value: Settings): string {
  return JSON.stringify(value, null, 2) + "\n";
}
export function profile(id: string): Profile {
  const p = settings().profiles.find(p => p.id === id);
  if (!p) throw Error(`Unknown profile: ${id}`);
  return p;
}
export const dir = (id: string) => join(STATE, id);
export const base = (p: Profile) => `http://127.0.0.1:${p.port}`;
export function secret(name: string) {
  const file = join(HOME_DIR, "secrets.env");
  return process.env[name] ?? (existsSync(file) ? parseEnv(readFileSync(file, "utf8"))[name] : undefined);
}
/** Setup keeps Stelz's private copy of the paired browser here. */
export const browserDirectory = (home = HOME_DIR) => join(home, "browsers", pairedBrowser());
export const executable = () => secret("CAMOUFOX_EXECUTABLE") || browserExecutable(browserDirectory());
export const typingMode = (p?: Profile) => p?.typingMode ?? parseTypingMode(secret("STELZ_TYPING_MODE"));
export const ipCheckIntervalMs = () => parseIpCheckInterval(secret("STELZ_IP_CHECK_INTERVAL_MS"));

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
  if (p.proxyEnv === undefined) return {};
  const raw = p.proxyEnv && secret(p.proxyEnv);
  if (!raw) throw Error(`${p.id}: set ${p.proxyEnv || "proxyEnv"} in ${join(HOME_DIR, "secrets.env")}. Direct fallback is disabled.`);
  const u = validateProxy(raw, p.id);
  return { PROXY_STRATEGY: "round_robin", PROXY_PROTOCOL: u.protocol.slice(0, -1), PROXY_HOST: u.hostname, PROXY_PORT: u.port || (u.protocol === "http:" ? "80" : u.protocol === "https:" ? "443" : "1080"), PROXY_USERNAME: u.username, PROXY_PASSWORD: u.password };
}
export function configurationHash(p: Profile) {
  // Display names and typing preferences do not change launch state.
  const { name: _name, typingMode: _typingMode, ...launchProfile } = p;
  const interval = ipCheckIntervalMs(), typing = typingMode();
  return createHash("sha256").update(JSON.stringify({ ...launchProfile, proxy: proxyEnvironment(p),
    expectedIP: p.expectedIPEnv ? secret(p.expectedIPEnv) || "" : "",
    typingMode: typing, ipCheckIntervalMs: interval,
  })).digest("hex");
}
export async function control(p: Profile, method: string, action: string, body?: unknown) {
  const token = readFileSync(join(dir(p.id), "access-key"), "utf8").trim();
  const r = await fetch(`${base(p)}/local-profile/${action}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120000) });
  const payload = await r.json() as Record<string, unknown>;
  if (!r.ok) throw Error(String(payload.error || `Profile control returned ${r.status}.`));
  return payload;
}
