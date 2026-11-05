import { randomUUID } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { isDeepStrictEqual, parseEnv } from "node:util";
import { CONFIG_FILE, HOME_DIR, STATE, dir, validateProxy, validateSettings, type Settings } from "./config.ts";
import { assertStoppedProfile, lock } from "../runtime/profile-process.ts";
import { existingProfilePath } from "./profile-compat.ts";

export const CATALOG_JOURNAL = existingProfilePath(HOME_DIR, ".profile-transaction.json", ".identity-transaction.json");
const configFile = CONFIG_FILE, secretsFile = join(HOME_DIR, "secrets.env");
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

export class ProfileCatalogError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message); this.name = "ProfileCatalogError"; }
}
function fail(): never {
  throw new ProfileCatalogError(409, "Profile save requires inspection. Check profiles.json, secrets.env, trash, and the private profile journal.");
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
  const config = read(configFile, false, Infinity);
  if (config === null) throw new ProfileCatalogError(409, "Run stelz init before creating profiles.");
  return { config, secrets: read(secretsFile) };
}
function validate(value: unknown): Transaction {
  if (!keys(value, ["version", "operation", "id", "token", "before", "after"]) || value.version !== 1 ||
      !["create", "delete"].includes(value.operation as string) || !validId(value.id) ||
      typeof value.token !== "string" || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(value.token)) fail();
  const t = value as unknown as Transaction;
  for (const state of [t.before, t.after]) {
    if (!keys(state, ["config", "secrets"]) || typeof state.config !== "string" ||
        state.secrets !== null && (typeof state.secrets !== "string" || Buffer.byteLength(state.secrets) > LIMIT)) fail();
  }
  const before = validateSettings(JSON.parse(t.before.config)), after = validateSettings(JSON.parse(t.after.config));
  const removed = (config: Settings) => ({ ...config, profiles: config.profiles.filter(p => p.id !== t.id) });
  const old = before.profiles.find(p => p.id === t.id), next = after.profiles.find(p => p.id === t.id);
  if (!isDeepStrictEqual(removed(before), removed(after))) fail();
  if (t.operation === "delete") {
    if (!old || next || t.before.secrets !== t.after.secrets) fail();
  } else {
    if (old || !next || next.storage !== "native" || t.id === "all") fail();
    const previousSecrets = parseEnv(t.before.secrets || ""), nextSecrets = parseEnv(t.after.secrets || "");
    const references = [next.proxyEnv, next.expectedIPEnv].filter((name): name is string => !!name);
    if (new Set(references).size !== references.length) fail();
    for (const name of references) {
      if (Object.hasOwn(previousSecrets, name) || before.profiles.some(p => [p.proxyEnv, p.expectedIPEnv].includes(name))) fail();
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
  // The journal contains complete catalog snapshots. Only secrets and state files have byte limits.
  const text = read(CATALOG_JOURNAL, true, Infinity);
  if (text === null) return;
  try { return validate(JSON.parse(text)); } catch { fail(); }
}
function unchanged(t: Transaction): Files {
  if (!isDeepStrictEqual(journal(), t)) fail();
  const current = files();
  for (const key of ["config", "secrets"] as const) {
    if (current[key] !== t.before[key] && current[key] !== t.after[key])
      throw new ProfileCatalogError(409, "Profile save conflicts with manually changed service files. Inspect the private profile journal.");
  }
  return current;
}
const archiveDirectory = (t: Transaction) => join(trash, `${t.id}-${t.token}`);
function profileDirectory(t: Transaction): string | undefined {
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
  assertStoppedProfile(t.id, path);
}
function archive(t: Transaction) {
  unchanged(t);
  const path = profileDirectory(t);
  if (!path) fail();
  checkStopped(t, path);
  if (!directory(trash, true)) mkdirSync(trash, { mode: 0o700 });
  const target = archiveDirectory(t);
  if (!directory(target, true)) mkdirSync(target, { mode: 0o700 });
  if (readdirSync(target).some(name => !["profile.json", "identity.json", "profile"].includes(name))) fail();
  const metadataFile = existingProfilePath(target, "profile.json", "identity.json");
  const metadata = JSON.stringify({ [metadataFile.endsWith("/identity.json") ? "identity" : "profile"]: validateSettings(JSON.parse(t.before.config)).profiles.find(p => p.id === t.id) }, null, 2) + "\n";
  const saved = read(metadataFile);
  if (saved !== null && saved !== metadata) fail();
  if (saved === null) replace(metadataFile, metadata, () => { unchanged(t); });
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
  // New secrets must be durable before their profile becomes visible.
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
  catch { throw new ProfileCatalogError(409, "Profile save is pending. Retry after inspecting the private profile journal and service files."); }
}

// The caller holds admission.lock. Recovery never starts or stops a browser.
export async function recoverProfileCatalog() {
  const t = journal();
  if (!t) return;
  unchanged(t);
  if (t.operation === "create") { complete(t); return; }
  const path = profileDirectory(t);
  if (!path) fail();
  await lock(join(path, "lifecycle.lock"), async () => { checkStopped(t, path); complete(t); });
}
export function pendingProfileCatalog(): string | null {
  try { const t = journal(); if (!t) return null; unchanged(t); return "A profile save is pending. Retry the operation to complete it."; }
  catch (error) { return error instanceof ProfileCatalogError ? error.message : "Profile save requires inspection of the private profile journal."; }
}
export function catalogSecretValues(): string[] {
  try { const t = journal(); return t ? [t.before, t.after].flatMap(state => Object.values(parseEnv(state.secrets || "")).filter((v): v is string => v !== undefined)) : []; }
  catch { return []; }
}

export { files as readCatalogFiles, directory as checkCatalogDirectory, read as readCatalogFile,
  fail as catalogNeedsInspection, commit as commitCatalogTransaction };
