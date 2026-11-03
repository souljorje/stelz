import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { createServer, isIP } from "node:net";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { CONFIG_FILE, HOME_DIR, STATE, dir, settings, serializeSettings, validateProxy, validateSettings, type Profile, type Settings } from "./config.ts";
import { assertStoppedProfile, lock, observe, observeStatus, running } from "./profile-process.ts";
import {
  ProfileCatalogError, recoverProfileCatalog, readCatalogFiles, checkCatalogDirectory,
  readCatalogFile, catalogNeedsInspection, commitCatalogTransaction,
} from "./profile-catalog.ts";
import {
  NetworkTransactionError, networkTransactionProfile, pendingNetworkTransaction,
  recoverNetworkTransaction, saveNetworkTransaction,
} from "./network-transaction.ts";
import type { ProfileCreate, NetworkUpdate } from "./profile-configuration-types.ts";
export type { ProfileCreate, NetworkUpdate } from "./profile-configuration-types.ts";
export { ProfileCatalogError, recoverProfileCatalog } from "./profile-catalog.ts";

export class ProfileConfigurationError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message); this.name = "ProfileConfigurationError"; }
}
const configFile = CONFIG_FILE, secretsFile = join(HOME_DIR, "secrets.env");
const validId = (id: unknown): id is string => typeof id === "string" && /^[a-z][a-z\d-]{0,63}$/.test(id);
type Data = Record<string, unknown>;
const data = (value: unknown): Data => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Data : {};
const ip = (value: unknown): value is string => typeof value === "string" && !value.includes("%") && isIP(value) !== 0;
// Do not follow service files or profile directories outside STELZ_HOME.
function localEntry(file: string, kind: "file" | "directory", optional = true) {
  try {
    const info = lstatSync(file);
    if (info.isSymbolicLink() || (kind === "file" ? !info.isFile() || info.nlink !== 1 : !info.isDirectory()))
      throw new ProfileConfigurationError(409, "Service state contains an unsafe file or directory. Inspect it before continuing.");
    return info;
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}
function readSettings(): Settings | undefined {
  try {
    localEntry(HOME_DIR, "directory");
    if (localEntry(configFile, "file")) return settings();
    const pending = pendingNetworkTransaction();
    if (pending) throw new ProfileConfigurationError(409, pending.message);
  } catch (error) {
    const pending = pendingNetworkTransaction();
    if (pending) throw new ProfileConfigurationError(409, pending.message);
    throw error;
  }
}
function readSecrets(): { text: string; values: ReturnType<typeof parseEnv> } {
  const info = localEntry(secretsFile, "file");
  if (info && info.size > 1024 * 1024) throw new ProfileConfigurationError(409, "The secrets file exceeds the size limit.");
  const text = info ? readFileSync(secretsFile, "utf8") : "";
  return { text, values: parseEnv(text) };
}
function checkProfileFiles(id: string) {
  localEntry(STATE, "directory");
  localEntry(dir(id), "directory");
  for (const name of ["running.json", "status.json", "stopped.json", "access-key"])
    localEntry(join(dir(id), name), "file");
}

function referencedElsewhere(config: Settings, p: Profile, name?: string) {
  return !!name && config.profiles.some(other => other.id !== p.id && [other.proxyEnv, other.expectedIPEnv].includes(name));
}

export function networkRevision(config: Settings, p: Profile, secrets: Pick<ReturnType<typeof readSecrets>, "values">): string {
  return createHash("sha256").update(JSON.stringify({
    config,
    proxy: p.proxyEnv ? [secrets.values[p.proxyEnv] ?? null, process.env[p.proxyEnv] ?? null] : null,
    expected: p.expectedIPEnv ? [secrets.values[p.expectedIPEnv] ?? null, process.env[p.expectedIPEnv] ?? null] : null,
  })).digest("hex");
}
function validateUpdate(value: NetworkUpdate): NetworkUpdate {
  const item = data(value);
  if (!value || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(item).some(key => !["revision", "mode", "proxyUrl", "expectedIp"].includes(key)) ||
      typeof item.revision !== "string" || !/^[a-f\d]{64}$/.test(item.revision) ||
      !["direct", "proxy"].includes(item.mode as string))
    throw new ProfileConfigurationError(400, "Network input is invalid. Supply a revision and a direct or proxy mode.");
  if (Object.hasOwn(item, "proxyUrl")) {
    if (typeof item.proxyUrl !== "string" || !item.proxyUrl || item.proxyUrl.length > 8192 ||
        /[\s\\\x00-\x1f\x7f]/.test(item.proxyUrl) || !/^(?:https?|socks5):\/\//i.test(item.proxyUrl))
      throw new ProfileConfigurationError(400, "Proxy URL must be a nonempty HTTP(S) or unauthenticated SOCKS5 URL.");
    try { encodeURIComponent(item.proxyUrl); validateProxy(item.proxyUrl); } catch { throw new ProfileConfigurationError(400, "Proxy URL is invalid. Use HTTP(S) or unauthenticated SOCKS5."); }
  }
  if (Object.hasOwn(item, "expectedIp") && (typeof item.expectedIp !== "string" || item.expectedIp !== "" && !ip(item.expectedIp)))
    throw new ProfileConfigurationError(400, "Expected IP must be empty or an IPv4 or IPv6 address.");
  return value;
}

// Replace only selected assignment values. Preserve comments, duplicate keys, and unrelated multiline values.
function editSecrets(text: string, updates: Map<string, string>): string {
  const edits: { start: number; end: number; value: string }[] = [], found = new Set<string>();
  for (let start = 0; start < text.length;) {
    const newline = text.indexOf("\n", start), lineEnd = newline < 0 ? text.length : newline;
    const match = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*/.exec(text.slice(start, lineEnd));
    let end = lineEnd;
    if (match) {
      const valueStart = start + match[0].length, quote = text[valueStart];
      let valueEnd: number;
      if (quote === "\"" || quote === "'") {
        const close = text.indexOf(quote, valueStart + 1);
        if (close < 0) throw new ProfileConfigurationError(409, "The secrets file contains an incomplete quoted value.");
        const next = text.indexOf("\n", close + 1);
        end = next < 0 ? text.length : next;
        valueEnd = close + 1;
      } else {
        const comment = text.indexOf("#", valueStart);
        valueEnd = comment >= 0 && comment < lineEnd ? comment : lineEnd;
        while (valueEnd > valueStart && /[ \t\r]/.test(text[valueEnd - 1]!)) valueEnd--;
      }
      if (updates.has(match[1]!)) {
        edits.push({ start: valueStart, end: valueEnd, value: updates.get(match[1]!) || '""' });
        found.add(match[1]!);
      }
    }
    start = end + 1;
  }
  let result = text;
  for (const edit of edits.reverse()) result = result.slice(0, edit.start) + edit.value + result.slice(edit.end);
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  for (const [name, value] of updates) if (!found.has(name)) {
    if (result && !result.endsWith("\n")) result += newline;
    result += `${name}=${value || '""'}${newline}`;
  }
  const before = parseEnv(text), after = parseEnv(result);
  for (const name of new Set([...Object.keys(before), ...Object.keys(after), ...updates.keys()])) {
    if (after[name] !== (updates.has(name) ? updates.get(name) : before[name]))
      throw new ProfileConfigurationError(409, "The secrets file cannot be edited safely. Inspect its assignment syntax.");
  }
  return result;
}

function findProfile(config: Settings | undefined, id: string) {
  const p = config?.profiles.find(p => p.id === id);
  if (!p) throw new ProfileConfigurationError(404, "Profile is not configured.");
  return p;
}

// The caller holds admission.lock. Recovery uses the same lock order as stop and UI saves.
async function recoverNetworkConfiguration() {
  const id = networkTransactionProfile();
  if (!id) return;
  try {
    await lock(join(dir(id), "lifecycle.lock"), async () => {
      const o = observe(id);
      if (o.record && (o.record.version !== undefined && o.record.version !== 2 || !o.clean ||
          [o.supervisor, o.server].some(value => value === "owned" || value === "unverified")))
        throw new NetworkTransactionError("Stop the journal profile cleanly before network recovery.", id);
      recoverNetworkTransaction();
    });
  } catch (error) {
    if (error instanceof NetworkTransactionError) throw error;
    throw new NetworkTransactionError("Cannot verify the stopped profile for network recovery.", id);
  }
}

export function catalogRevision(config: Settings | undefined): string {
  return createHash("sha256").update(JSON.stringify(config ?? null)).digest("hex");
}

function revisionMatches(revision: string, config: Settings) {
  if (!/^[a-f\d]{64}$/.test(revision) || revision !== catalogRevision(config))
    throw new ProfileCatalogError(409, "Profiles changed. Refresh before continuing.");
}
function validateInput(value: ProfileCreate) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !["revision", "id", "proxyUrl", "expectedIp"].includes(key)) ||
      typeof value.revision !== "string" || !validId(value.id))
    throw new ProfileCatalogError(400, "Use a profile name with 1–64 lowercase letters, digits, or hyphens. Start with a letter.");
  if (value.id === "all") throw new ProfileCatalogError(400, "The profile name all is reserved for lifecycle commands. Choose another name.");
  if (value.proxyUrl !== undefined) {
    if (typeof value.proxyUrl !== "string" || !value.proxyUrl || value.proxyUrl.length > 8192 ||
        /[\s\\\x00-\x1f\x7f]/.test(value.proxyUrl) || !/^(?:https?|socks5):\/\//i.test(value.proxyUrl))
      throw new ProfileCatalogError(400, "Proxy URL is invalid. Use HTTP(S) or unauthenticated SOCKS5.");
    try { encodeURIComponent(value.proxyUrl); validateProxy(value.proxyUrl); }
    catch { throw new ProfileCatalogError(400, "Proxy URL is invalid. Use HTTP(S) or unauthenticated SOCKS5."); }
  }
  if (value.expectedIp !== undefined && (typeof value.expectedIp !== "string" || value.expectedIp && (!isIP(value.expectedIp) || value.expectedIp.includes("%"))))
    throw new ProfileCatalogError(400, "Expected IP must be empty or an IPv4 or IPv6 address.");
}
// Complete both journals before the callback. Keep admission held until the callback returns.
export async function prepareProfileConfiguration<T>(action: () => Promise<T>) {
  checkCatalogDirectory(HOME_DIR); checkCatalogDirectory(STATE);
  return lock(join(STATE, "admission.lock"), async () => {
    await recoverProfileCatalog();
    await recoverNetworkConfiguration();
    return action();
  });
}
function portAvailable(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", error => ["EADDRINUSE", "EACCES"].includes((error as NodeJS.ErrnoException).code || "") ? resolve(false) : reject(error));
    server.listen(port, "127.0.0.1", () => server.close(error => error ? reject(error) : resolve(true)));
  });
}
export async function createProfile(input: ProfileCreate): Promise<string> {
  validateInput(input);
  return prepareProfileConfiguration(async () => {
    const before = readCatalogFiles(), config = validateSettings(JSON.parse(before.config));
    revisionMatches(input.revision, config);
    if (config.profiles.some(p => p.id === input.id) || existsSync(dir(input.id)))
      throw new ProfileCatalogError(409, "This profile name already has configuration or saved state. Choose another name.");
    if (config.profiles.length >= 1000) throw new ProfileCatalogError(409, "The saved profile limit is reached.");
    const ports = new Set(config.profiles.map(p => p.port));
    for (const entry of readdirSync(STATE, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) catalogNeedsInspection();
      if (!entry.isDirectory()) continue;
      const record = readCatalogFile(join(STATE, entry.name, "running.json"));
      if (record) {
        const port = JSON.parse(record).port;
        if (Number.isInteger(port)) ports.add(port);
      }
    }
    let port = 9377;
    while (port <= 65535 && (ports.has(port) || !await portAvailable(port))) port++;
    if (port > 65535) throw new ProfileCatalogError(409, "No profile port is available.");
    const p: Profile = { id: input.id, port, mode: input.proxyUrl ? "proxy" : "direct", storage: "native" };
    const secrets = parseEnv(before.secrets || "");
    const used = new Set([...Object.keys(secrets), ...Object.keys(process.env), ...config.profiles.flatMap(p => [p.proxyEnv, p.expectedIPEnv])]);
    let nextSecrets = before.secrets;
    for (const [field, value] of [["proxyEnv", input.proxyUrl], ["expectedIPEnv", input.expectedIp]] as const) {
      if (!value) continue;
      let name: string;
      do { name = `STELZ_${randomUUID().replaceAll("-", "").toUpperCase()}_${field === "proxyEnv" ? "PROXY_URL" : "EXPECTED_IP"}`; } while (used.has(name));
      used.add(name); p[field] = name;
      nextSecrets = (nextSecrets || "") + (nextSecrets && !nextSecrets.endsWith("\n") ? "\n" : "") + `${name}=${value}\n`;
      if (parseEnv(nextSecrets)[name] !== value) throw new ProfileCatalogError(409, "Inspect the secrets file before adding this proxy.");
    }
    const next = validateSettings({ ...config, profiles: [...config.profiles, p] });
    commitCatalogTransaction({ version: 1, operation: "create", id: p.id, token: randomUUID(), before,
      after: { config: serializeSettings(next, before.config), secrets: nextSecrets } });
    return p.id;
  });
}
export async function deleteProfile(id: string, revision: string): Promise<void> {
  if (!validId(id) || typeof revision !== "string") throw new ProfileCatalogError(400, "Profile deletion input is invalid.");
  await prepareProfileConfiguration(async () => {
    const before = readCatalogFiles(), config = validateSettings(JSON.parse(before.config));
    revisionMatches(revision, config);
    if (!config.profiles.some(p => p.id === id)) throw new ProfileCatalogError(404, "Profile is not configured.");
    checkCatalogDirectory(dir(id), true);
    mkdirSync(dir(id), { recursive: true, mode: 0o700 });
    await lock(join(dir(id), "lifecycle.lock"), async () => {
      for (const name of ["running.json", "stopped.json", "status.json"]) readCatalogFile(join(dir(id), name));
      assertStoppedProfile(id);
      const next = { ...config, profiles: config.profiles.filter(p => p.id !== id) };
      commitCatalogTransaction({ version: 1, operation: "delete", id, token: randomUUID(), before,
        after: { config: serializeSettings(next, before.config), secrets: before.secrets } });
    });
  });
}

export async function updateNetwork(id: string, input: NetworkUpdate) {
  const update = validateUpdate(input), initial = readSettings();
  findProfile(initial, id);
  localEntry(STATE, "directory");
  mkdirSync(STATE, { recursive: true, mode: 0o700 });
  return prepareProfileConfiguration(async () => {
    findProfile(readSettings(), id);
    localEntry(dir(id), "directory");
    mkdirSync(dir(id), { recursive: true, mode: 0o700 });
    return lock(join(dir(id), "lifecycle.lock"), async () => {
      const config = readSettings()!, p = findProfile(config, id), secrets = readSecrets();
      checkProfileFiles(id);
      const recordFile = join(dir(id), "running.json");
      if (existsSync(recordFile)) {
        const record = data(JSON.parse(readFileSync(recordFile, "utf8")));
        if (record.version !== undefined && record.version !== 2)
          throw new ProfileConfigurationError(409, "The process record version is unknown. Inspect it before changing the network.");
      }
      const observation = observeStatus(p);
      if (observation.phase !== "stopped" || running(id))
        throw new ProfileConfigurationError(409, "Stop the profile cleanly before changing its network.");
      if (update.revision !== networkRevision(config, p, secrets))
        throw new ProfileConfigurationError(409, "Network configuration changed. Refresh it before saving.");
      const candidate = structuredClone(config), next = candidate.profiles.find(item => item.id === id)!;
      next.mode = update.mode;
      const updates = new Map<string, string>();
      const used = new Set([...Object.keys(secrets.values), ...Object.keys(process.env), ...config.profiles.flatMap(item => [item.proxyEnv, item.expectedIPEnv].filter((name): name is string => !!name))]);
      const set = (field: "proxyEnv" | "expectedIPEnv", value: string) => {
        let name = next[field];
        if (name && (process.env[name] !== undefined || referencedElsewhere(config, p, name) || p.proxyEnv === p.expectedIPEnv))
          throw new ProfileConfigurationError(409, "This secret has an environment override or a shared reference. Edit it outside the UI.");
        if (!name) {
          do { name = `STELZ_${id.replaceAll("-", "_").toUpperCase()}_${field === "proxyEnv" ? "PROXY_URL" : "EXPECTED_IP"}_${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`; } while (used.has(name));
          next[field] = name;
          used.add(name);
        }
        updates.set(name, value);
      };
      if (update.proxyUrl !== undefined) set("proxyEnv", update.proxyUrl);
      if (update.expectedIp !== undefined && (update.expectedIp || next.expectedIPEnv)) set("expectedIPEnv", update.expectedIp);
      validateSettings(candidate);
      const changedSecrets = editSecrets(secrets.text, updates), candidateSecrets = { text: changedSecrets, values: parseEnv(changedSecrets) };
      const proxy = next.proxyEnv && (process.env[next.proxyEnv] ?? candidateSecrets.values[next.proxyEnv]);
      const expected = next.expectedIPEnv && (process.env[next.expectedIPEnv] ?? candidateSecrets.values[next.expectedIPEnv]);
      let error: string | null = null;
      if (next.mode === "proxy") {
        if (!proxy) error = "Proxy URL is missing. Configure a proxy before starting this profile.";
        else { try { validateProxy(proxy); } catch { error = "Proxy URL is invalid. Use HTTP(S) or unauthenticated SOCKS5."; } }
      }
      if (!error && expected && !ip(expected)) error = "Expected IP must be an IPv4 or IPv6 address.";
      if (error) throw new ProfileConfigurationError(400, error);

      const previousConfig = readFileSync(configFile, "utf8");
      const before = { config: previousConfig, secrets: existsSync(secretsFile) ? secrets.text : null };
      saveNetworkTransaction(id, before, { config: serializeSettings(candidate, previousConfig), secrets: updates.size ? changedSecrets : before.secrets });
      return { config: candidate, profile: next, secrets: candidateSecrets, observation };
    });
  });
}
