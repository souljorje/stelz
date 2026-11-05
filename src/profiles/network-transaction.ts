import { randomUUID } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync,
  renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { isDeepStrictEqual, parseEnv } from "node:util";
import { CONFIG_FILE, HOME_DIR, STATE, dir, validateProxy, validateSettings, type Settings } from "./config.ts";
import { normalizeProfileId } from "./profile-compat.ts";
import { withoutLegacyConnectionMode } from "./network-compat.ts";

export const NETWORK_JOURNAL = join(HOME_DIR, ".network-transaction.json");
const configFile = CONFIG_FILE, secretsFile = join(HOME_DIR, "secrets.env");
const LIMIT = 1024 * 1024;
export type NetworkFiles = { config: string; secrets: string | null };
type Transaction = {
  version: 1;
  token: string;
  profileId: string;
  direction: "commit" | "rollback";
  before: NetworkFiles;
  after: NetworkFiles;
};

const quote = (value: string) => /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
function instruction(id?: string) {
  return `env STELZ_HOME=${quote(HOME_DIR)} stelz ${id ? `start ${id}` : "doctor all"}`;
}
export class NetworkTransactionError extends Error {
  readonly status = 409;
  constructor(reason: string, id?: string) {
    super(`${reason} Inspect profiles.json, secrets.env, and the private network journal. Then retry: ${instruction(id)}`);
    this.name = "NetworkTransactionError";
  }
}
function fail(id?: string): never { throw new NetworkTransactionError("Network save recovery requires inspection.", id); }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function keys(value: unknown, names: string[]): value is Record<string, unknown> {
  return object(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}
function directory(file: string, optional = false) {
  try {
    const info = lstatSync(file);
    if (!info.isDirectory() || info.isSymbolicLink()) fail();
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}
function read(file: string, privateFile = false, limit = LIMIT): string | null {
  let fd: number | undefined;
  try {
    const path = lstatSync(file);
    if (!path.isFile() || path.isSymbolicLink() || path.nlink !== 1) fail();
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > limit || path.dev !== info.dev || path.ino !== info.ino ||
        process.getuid && info.uid !== process.getuid() || privateFile && (info.mode & 0o7777) !== 0o600) fail();
    const bytes = readFileSync(fd), text = bytes.toString("utf8");
    if (!Buffer.from(text).equals(bytes)) fail();
    return text;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}
function syncHome() {
  const fd = openSync(HOME_DIR, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    try { fsyncSync(fd); }
    catch (error) { if (!["EINVAL", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code || "")) throw error; }
  } finally { closeSync(fd); }
}
function sameFiles(value: NetworkFiles, other: NetworkFiles) {
  return value.config === other.config && value.secrets === other.secrets;
}
function files(): NetworkFiles {
  directory(HOME_DIR);
  const config = read(configFile, false, Infinity);
  if (config === null) fail();
  return { config, secrets: read(secretsFile) };
}
function validate(value: unknown): Transaction {
  if (object(value)) value = normalizeProfileId(value);
  if (!keys(value, ["version", "token", "profileId", "direction", "before", "after"]) || value.version !== 1 ||
      typeof value.token !== "string" || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(value.token) ||
      typeof value.profileId !== "string" || !/^[a-z][a-z\d-]{0,63}$/.test(value.profileId) ||
      !["commit", "rollback"].includes(value.direction as string)) fail();
  const transaction = value as unknown as Transaction;
  const configs: Settings[] = [];
  for (const state of [transaction.before, transaction.after]) {
    if (!keys(state, ["config", "secrets"]) || typeof state.config !== "string" ||
        state.secrets !== null && (typeof state.secrets !== "string" || Buffer.byteLength(state.secrets) > LIMIT)) fail();
    configs.push(validateSettings(JSON.parse(state.config)));
  }
  const [before, after] = configs;
  const oldProfile = before!.profiles.find(p => p.id === transaction.profileId);
  const newProfile = after!.profiles.find(p => p.id === transaction.profileId);
  if (!oldProfile || !newProfile) fail();
  // A journal can change only this profile's network fields, including legacy fields.
  const withoutNetwork = (config: Settings) => ({ ...config, profiles: config.profiles.map(p => {
    if (p.id !== transaction.profileId) return p;
    const { proxyEnv: _proxy, expectedIPEnv: _expected, ...rest } = withoutLegacyConnectionMode(p);
    return rest;
  }) });
  if (!isDeepStrictEqual(withoutNetwork(before!), withoutNetwork(after!)) ||
      oldProfile.proxyEnv && newProfile.proxyEnv && oldProfile.proxyEnv !== newProfile.proxyEnv ||
      oldProfile.expectedIPEnv && oldProfile.expectedIPEnv !== newProfile.expectedIPEnv) fail();
  const oldSecrets = parseEnv(transaction.before.secrets || ""), newSecrets = parseEnv(transaction.after.secrets || "");
  for (const field of ["proxyEnv", "expectedIPEnv"] as const) {
    const name = newProfile[field];
    if (!oldProfile[field] && name && (Object.hasOwn(oldSecrets, name) ||
        before!.profiles.some(p => [p.proxyEnv, p.expectedIPEnv].includes(name)))) fail();
  }
  const references = [newProfile.proxyEnv, newProfile.expectedIPEnv];
  for (const name of new Set([...Object.keys(oldSecrets), ...Object.keys(newSecrets)])) {
    if (oldSecrets[name] === newSecrets[name]) continue;
    if (!references.includes(name) || after!.profiles.some(p => p.id !== transaction.profileId && [p.proxyEnv, p.expectedIPEnv].includes(name))) fail();
    if (name === newProfile.proxyEnv) {
      if (!newSecrets[name]) fail();
      validateProxy(newSecrets[name]!);
    }
    if (name === newProfile.expectedIPEnv && newSecrets[name] && (!isIP(newSecrets[name]!) || newSecrets[name]!.includes("%"))) fail();
  }
  return transaction;
}
function readJournal(): Transaction | undefined {
  directory(HOME_DIR, true);
  // The journal contains complete catalog snapshots. Only secrets and state files have byte limits.
  const text = read(NETWORK_JOURNAL, true, Infinity);
  if (text === null) return;
  try { return validate(JSON.parse(text)); } catch { fail(); }
}
function profilePaths(transaction: Transaction) {
  directory(STATE);
  directory(dir(transaction.profileId));
  for (const name of ["running.json", "stopped.json"]) read(join(dir(transaction.profileId), name));
}
function unchanged(transaction: Transaction) {
  if (!isDeepStrictEqual(readJournal(), transaction)) fail(transaction.profileId);
  profilePaths(transaction);
  const current = files();
  for (const key of ["config", "secrets"] as const) {
    if (current[key] !== transaction.before[key] && current[key] !== transaction.after[key])
      throw new NetworkTransactionError("Network save conflicts with manually changed service files.", transaction.profileId);
  }
  return current;
}
function replace(file: string, value: string, check: () => void) {
  const temp = `${file}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, value);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    check();
    renameSync(temp, file);
    syncHome();
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
function journal(transaction: Transaction, previous?: Transaction) {
  replace(NETWORK_JOURNAL, JSON.stringify(transaction) + "\n", () => {
    if (!isDeepStrictEqual(readJournal(), previous)) fail(transaction.profileId);
    if (!previous && !sameFiles(files(), transaction.before)) fail(transaction.profileId);
  });
}
function complete(transaction: Transaction) {
  const desired = transaction.direction === "commit" ? transaction.after : transaction.before;
  unchanged(transaction);
  for (const [key, file] of [["config", configFile], ["secrets", secretsFile]] as const) {
    if (unchanged(transaction)[key] === desired[key]) continue;
    if (desired[key] === null) { unchanged(transaction); unlinkSync(file); syncHome(); }
    else replace(file, desired[key], () => { unchanged(transaction); });
  }
  if (!sameFiles(unchanged(transaction), desired)) fail(transaction.profileId);
  unlinkSync(NETWORK_JOURNAL);
  syncHome();
}

export function networkTransactionProfile(): string | undefined {
  try {
    const transaction = readJournal();
    if (!transaction) return;
    unchanged(transaction);
    return transaction.profileId;
  } catch (error) {
    if (error instanceof NetworkTransactionError) throw error;
    fail();
  }
}

// Call only under admission.lock and the journal profile's lifecycle.lock.
export function recoverNetworkTransaction() {
  try { const transaction = readJournal(); if (transaction) complete(transaction); }
  catch (error) {
    if (error instanceof NetworkTransactionError) throw error;
    fail();
  }
}

// The caller validates the stopped profile while both locks are held.
export function saveNetworkTransaction(profileId: string, before: NetworkFiles, after: NetworkFiles) {
  const transaction = validate({ version: 1, token: randomUUID(), profileId, direction: "commit", before, after });
  if (readJournal()) fail(profileId);
  journal(transaction);
  try { complete(transaction); }
  catch (error) {
    // Record rollback intent before undoing a write. A second interruption can then resume rollback.
    try {
      unchanged(transaction);
      const rollback: Transaction = { ...transaction, direction: "rollback" };
      journal(rollback, transaction);
      complete(rollback);
    } catch {
      if (error instanceof NetworkTransactionError) throw error;
      throw new NetworkTransactionError("Network save is pending after an interrupted write.", profileId);
    }
    throw new NetworkTransactionError("Network save failed. The previous configuration was restored.", profileId);
  }
}

export function pendingNetworkTransaction(): { profileId: string | null; message: string; blocked: boolean } | null {
  let transaction: Transaction | undefined;
  try {
    transaction = readJournal();
    if (!transaction) return null;
    unchanged(transaction);
    return { profileId: transaction.profileId, blocked: false, message: `Network save is pending. Complete it with: ${instruction(transaction.profileId)}` };
  } catch (error) {
    return { profileId: transaction?.profileId || null, blocked: true,
      message: error instanceof NetworkTransactionError ? error.message : new NetworkTransactionError("Network save recovery requires inspection.", transaction?.profileId).message };
  }
}

export function networkTransactionSecretValues(): string[] {
  try {
    const transaction = readJournal();
    return transaction ? [transaction.before, transaction.after].flatMap(state => Object.values(parseEnv(state.secrets || "")).filter((value): value is string => value !== undefined)) : [];
  } catch { return []; }
}
