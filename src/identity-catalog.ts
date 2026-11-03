import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { createServer, isIP } from "node:net";
import { join } from "node:path";
import { isDeepStrictEqual, parseEnv } from "node:util";
import { HOME_DIR, STATE, dir, validateProxy, validateSettings, type Profile, type Settings } from "./config.ts";
import { assertStoppedIdentity, lock, recoverNetworkConfiguration } from "./runtime.ts";
import type { UiIdentityCreate } from "./ui-types.ts";

export const CATALOG_JOURNAL = join(HOME_DIR, ".identity-transaction.json");
const configFile = join(HOME_DIR, "identities.json"), secretsFile = join(HOME_DIR, "secrets.env");
const trash = join(HOME_DIR, "trash"), LIMIT = 1024 * 1024;
type Files = { config: string; secrets: string | null };
type Transaction = {
  version: 1; operation: "create" | "delete"; id: string; token: string;
  before: Files; after: Files;
};
const validId = (id: unknown): id is string => typeof id === "string" && /^[a-z][a-z\d-]{0,63}$/.test(id);
const keys = (value: unknown, names: string[]): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));

export class IdentityCatalogError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message); this.name = "IdentityCatalogError"; }
}
function fail(): never {
  throw new IdentityCatalogError(409, "Identity save requires inspection. Check identities.json, secrets.env, trash, and the private identity journal.");
}
function directory(path: string, optional = false): boolean {
  try {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink() || process.getuid && info.uid !== process.getuid()) fail();
    return true;
  } catch (error) { if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function read(path: string, privateFile = false, limit = LIMIT): string | null {
  let fd: number | undefined;
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail();
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (opened.dev !== info.dev || opened.ino !== info.ino || opened.nlink !== 1 || opened.size > limit ||
        process.getuid && opened.uid !== process.getuid() || privateFile && (opened.mode & 0o7777) !== 0o600) fail();
    const bytes = readFileSync(fd), text = bytes.toString("utf8");
    if (!Buffer.from(text).equals(bytes)) fail();
    return text;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
}
function sync(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); }
  catch (error) { if (!["EINVAL", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code || "")) throw error; }
  finally { closeSync(fd); }
}
function replace(path: string, value: string, check: () => void) {
  const temp = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, value); fsyncSync(fd); closeSync(fd); fd = undefined;
    check(); renameSync(temp, path); sync(HOME_DIR);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
function files(): Files {
  directory(HOME_DIR);
  const config = read(configFile);
  if (config === null) throw new IdentityCatalogError(409, "Run stelz init before creating identities.");
  return { config, secrets: read(secretsFile) };
}
export function catalogRevision(config: Settings | undefined): string {
  return createHash("sha256").update(JSON.stringify(config ?? null)).digest("hex");
}
function validate(value: unknown): Transaction {
  if (!keys(value, ["version", "operation", "id", "token", "before", "after"]) || value.version !== 1 ||
      !["create", "delete"].includes(value.operation as string) || !validId(value.id) ||
      typeof value.token !== "string" || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(value.token)) fail();
  const t = value as unknown as Transaction;
  for (const state of [t.before, t.after]) {
    if (!keys(state, ["config", "secrets"]) || typeof state.config !== "string" || Buffer.byteLength(state.config) > LIMIT ||
        state.secrets !== null && (typeof state.secrets !== "string" || Buffer.byteLength(state.secrets) > LIMIT)) fail();
  }
  const before = validateSettings(JSON.parse(t.before.config)), after = validateSettings(JSON.parse(t.after.config));
  const removed = (config: Settings) => ({ ...config, identities: config.identities.filter(p => p.id !== t.id) });
  const old = before.identities.find(p => p.id === t.id), next = after.identities.find(p => p.id === t.id);
  if (!isDeepStrictEqual(removed(before), removed(after))) fail();
  if (t.operation === "delete") {
    if (!old || next || t.before.secrets !== t.after.secrets) fail();
  } else {
    if (old || !next || next.storage !== "native" || t.id === "all") fail();
    const previousSecrets = parseEnv(t.before.secrets || ""), nextSecrets = parseEnv(t.after.secrets || "");
    const references = [next.proxyEnv, next.expectedIPEnv].filter((name): name is string => !!name);
    if (new Set(references).size !== references.length) fail();
    for (const name of references) {
      if (Object.hasOwn(previousSecrets, name) || before.identities.some(p => [p.proxyEnv, p.expectedIPEnv].includes(name))) fail();
    }
    for (const name of new Set([...Object.keys(previousSecrets), ...Object.keys(nextSecrets)])) {
      if (previousSecrets[name] === nextSecrets[name]) continue;
      if (!references.includes(name)) fail();
    }
    if (next.mode === "proxy" && (!next.proxyEnv || !nextSecrets[next.proxyEnv])) fail();
    if (next.proxyEnv) validateProxy(nextSecrets[next.proxyEnv] || "");
    if (next.expectedIPEnv && (!isIP(nextSecrets[next.expectedIPEnv] || "") || nextSecrets[next.expectedIPEnv]!.includes("%"))) fail();
  }
  return t;
}
function journal(): Transaction | undefined {
  directory(HOME_DIR, true);
  const text = read(CATALOG_JOURNAL, true, LIMIT * 12);
  if (text === null) return;
  try { return validate(JSON.parse(text)); } catch { fail(); }
}
function unchanged(t: Transaction): Files {
  if (!isDeepStrictEqual(journal(), t)) fail();
  const current = files();
  for (const key of ["config", "secrets"] as const) {
    if (current[key] !== t.before[key] && current[key] !== t.after[key])
      throw new IdentityCatalogError(409, "Identity save conflicts with manually changed service files. Inspect the private identity journal.");
  }
  return current;
}
const archiveDirectory = (t: Transaction) => join(trash, `${t.id}-${t.token}`);
function identityDirectory(t: Transaction): string | undefined {
  const original = directory(dir(t.id), true);
  directory(trash, true);
  const archive = archiveDirectory(t);
  const archived = directory(archive, true) && directory(join(archive, "profile"), true);
  if (original && archived) fail();
  return original ? dir(t.id) : archived ? join(archive, "profile") : undefined;
}
function checkStopped(t: Transaction, path: string) {
  directory(path);
  for (const name of ["running.json", "stopped.json", "status.json"]) read(join(path, name));
  assertStoppedIdentity(t.id, path);
}
function archive(t: Transaction) {
  unchanged(t);
  const path = identityDirectory(t);
  if (!path) fail();
  checkStopped(t, path);
  if (!directory(trash, true)) mkdirSync(trash, { mode: 0o700 });
  const target = archiveDirectory(t);
  if (!directory(target, true)) mkdirSync(target, { mode: 0o700 });
  if (readdirSync(target).some(name => !["identity.json", "profile"].includes(name))) fail();
  const metadata = JSON.stringify({ identity: validateSettings(JSON.parse(t.before.config)).identities.find(p => p.id === t.id) }, null, 2) + "\n";
  const saved = read(join(target, "identity.json"));
  if (saved !== null && saved !== metadata) fail();
  if (saved === null) replace(join(target, "identity.json"), metadata, () => { unchanged(t); });
  if (path === dir(t.id)) {
    unchanged(t); checkStopped(t, path);
    renameSync(path, join(target, "profile"));
    sync(STATE); sync(target);
  }
  sync(trash);
}
function complete(t: Transaction) {
  unchanged(t);
  if (t.operation === "delete") archive(t);
  // New secrets must be durable before their identity becomes visible.
  for (const [key, path] of [["secrets", secretsFile], ["config", configFile]] as const) {
    if (unchanged(t)[key] === t.after[key]) continue;
    if (t.after[key] === null) fail();
    replace(path, t.after[key]!, () => { unchanged(t); });
  }
  if (!isDeepStrictEqual(unchanged(t), t.after)) fail();
  unlinkSync(CATALOG_JOURNAL); sync(HOME_DIR);
}
function commit(t: Transaction) {
  validate(t);
  replace(CATALOG_JOURNAL, JSON.stringify(t) + "\n", () => {
    if (journal() || !isDeepStrictEqual(files(), t.before)) fail();
  });
  try { complete(t); }
  catch { throw new IdentityCatalogError(409, "Identity save is pending. Retry after inspecting the private identity journal and service files."); }
}

// The caller holds admission.lock. Recovery never starts or stops a browser.
export async function recoverIdentityCatalog() {
  const t = journal();
  if (!t) return;
  unchanged(t);
  if (t.operation === "create") { complete(t); return; }
  const path = identityDirectory(t);
  if (!path) fail();
  await lock(join(path, "lifecycle.lock"), async () => { checkStopped(t, path); complete(t); });
}
export function pendingIdentityCatalog(): string | null {
  try { const t = journal(); if (!t) return null; unchanged(t); return "An identity save is pending. Retry the operation to complete it."; }
  catch (error) { return error instanceof IdentityCatalogError ? error.message : "Identity save requires inspection of the private identity journal."; }
}
export function catalogSecretValues(): string[] {
  try { const t = journal(); return t ? [t.before, t.after].flatMap(state => Object.values(parseEnv(state.secrets || "")).filter((v): v is string => v !== undefined)) : []; }
  catch { return []; }
}
function revisionMatches(revision: string, config: Settings) {
  if (!/^[a-f\d]{64}$/.test(revision) || revision !== catalogRevision(config))
    throw new IdentityCatalogError(409, "Identities changed. Refresh before continuing.");
}
function validateInput(value: UiIdentityCreate) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !["revision", "id", "proxyUrl", "expectedIp"].includes(key)) ||
      typeof value.revision !== "string" || !validId(value.id))
    throw new IdentityCatalogError(400, "Use an identity name with 1–64 lowercase letters, digits, or hyphens. Start with a letter.");
  if (value.id === "all") throw new IdentityCatalogError(400, "The identity name all is reserved for lifecycle commands. Choose another name.");
  if (value.proxyUrl !== undefined) {
    if (typeof value.proxyUrl !== "string" || !value.proxyUrl || value.proxyUrl.length > 8192 ||
        /[\s\\\x00-\x1f\x7f]/.test(value.proxyUrl) || !/^(?:https?|socks5):\/\//i.test(value.proxyUrl))
      throw new IdentityCatalogError(400, "Proxy URL is invalid. Use HTTP(S) or unauthenticated SOCKS5.");
    try { encodeURIComponent(value.proxyUrl); validateProxy(value.proxyUrl); }
    catch { throw new IdentityCatalogError(400, "Proxy URL is invalid. Use HTTP(S) or unauthenticated SOCKS5."); }
  }
  if (value.expectedIp !== undefined && (typeof value.expectedIp !== "string" || value.expectedIp && (!isIP(value.expectedIp) || value.expectedIp.includes("%"))))
    throw new IdentityCatalogError(400, "Expected IP must be empty or an IPv4 or IPv6 address.");
}
async function admission<T>(action: () => Promise<T>) {
  directory(HOME_DIR); directory(STATE);
  return lock(join(STATE, "admission.lock"), async () => {
    await recoverIdentityCatalog(); await recoverNetworkConfiguration(); return action();
  });
}
function portAvailable(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", error => ["EADDRINUSE", "EACCES"].includes((error as NodeJS.ErrnoException).code || "") ? resolve(false) : reject(error));
    server.listen(port, "127.0.0.1", () => server.close(error => error ? reject(error) : resolve(true)));
  });
}
export async function createIdentity(input: UiIdentityCreate): Promise<string> {
  validateInput(input);
  return admission(async () => {
    const before = files(), config = validateSettings(JSON.parse(before.config));
    revisionMatches(input.revision, config);
    if (config.identities.some(p => p.id === input.id) || existsSync(dir(input.id)))
      throw new IdentityCatalogError(409, "This identity name already has configuration or saved state. Choose another name.");
    if (config.identities.length >= 1000) throw new IdentityCatalogError(409, "The saved identity limit is reached.");
    const ports = new Set(config.identities.map(p => p.port));
    for (const entry of readdirSync(STATE, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) fail();
      if (!entry.isDirectory()) continue;
      const record = read(join(STATE, entry.name, "running.json"));
      if (record) {
        const port = JSON.parse(record).port;
        if (Number.isInteger(port)) ports.add(port);
      }
    }
    let port = 9377;
    while (port <= 65535 && (ports.has(port) || !await portAvailable(port))) port++;
    if (port > 65535) throw new IdentityCatalogError(409, "No identity port is available.");
    const p: Profile = { id: input.id, port, mode: input.proxyUrl ? "proxy" : "direct", storage: "native" };
    const secrets = parseEnv(before.secrets || "");
    const used = new Set([...Object.keys(secrets), ...Object.keys(process.env), ...config.identities.flatMap(p => [p.proxyEnv, p.expectedIPEnv])]);
    let nextSecrets = before.secrets;
    for (const [field, value] of [["proxyEnv", input.proxyUrl], ["expectedIPEnv", input.expectedIp]] as const) {
      if (!value) continue;
      let name: string;
      do { name = `STELZ_${randomUUID().replaceAll("-", "").toUpperCase()}_${field === "proxyEnv" ? "PROXY_URL" : "EXPECTED_IP"}`; } while (used.has(name));
      used.add(name); p[field] = name;
      nextSecrets = (nextSecrets || "") + (nextSecrets && !nextSecrets.endsWith("\n") ? "\n" : "") + `${name}=${value}\n`;
      if (parseEnv(nextSecrets)[name] !== value) throw new IdentityCatalogError(409, "Inspect the secrets file before adding this proxy.");
    }
    const next = validateSettings({ ...config, identities: [...config.identities, p] });
    commit({ version: 1, operation: "create", id: p.id, token: randomUUID(), before,
      after: { config: JSON.stringify(next, null, 2) + "\n", secrets: nextSecrets } });
    return p.id;
  });
}
export async function deleteIdentity(id: string, revision: string): Promise<void> {
  if (!validId(id) || typeof revision !== "string") throw new IdentityCatalogError(400, "Identity deletion input is invalid.");
  await admission(async () => {
    const before = files(), config = validateSettings(JSON.parse(before.config));
    revisionMatches(revision, config);
    if (!config.identities.some(p => p.id === id)) throw new IdentityCatalogError(404, "Identity is not configured.");
    directory(dir(id), true);
    mkdirSync(dir(id), { recursive: true, mode: 0o700 });
    await lock(join(dir(id), "lifecycle.lock"), async () => {
      for (const name of ["running.json", "stopped.json", "status.json"]) read(join(dir(id), name));
      assertStoppedIdentity(id);
      const next = { ...config, identities: config.identities.filter(p => p.id !== id) };
      commit({ version: 1, operation: "delete", id, token: randomUUID(), before,
        after: { config: JSON.stringify(next, null, 2) + "\n", secrets: before.secrets } });
    });
  });
}
