import { randomUUID } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isIP } from "node:net";
import { isDeepStrictEqual, parseEnv } from "node:util";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { CONFIG_FILE, HOME_DIR, STATE, dir, validateProxy, validateSettings } from "./config.ts";

export const PROFILE_IMPORT_JOURNAL = join(HOME_DIR, ".profile-import-transaction.json");
const secretsFile = join(HOME_DIR, "secrets.env"), LIMIT = 1024 * 1024;
export type ImportCatalogFiles = { config: string; secrets: string | null };
type Identity = { dev: string; ino: string };
export type ImportPath = { path: string; kind: "file" | "directory" };
type Entry = Identity & ImportPath & { size?: string; modified?: string };
type ImportedDirectory = { id: string; root: Identity; paths: ImportPath[]; tree: Entry[] | null };
type Transaction = {
  version: 1; token: string; direction: "commit" | "rollback"; stage: Identity;
  profiles: ImportedDirectory[]; before: ImportCatalogFiles; after: ImportCatalogFiles;
};

export class ProfileImportTransactionError extends Error {
  readonly status = 409;
  constructor(message = "Profile import requires inspection. Check the private import journal and service files before continuing.") {
    super(message); this.name = "ProfileImportTransactionError";
  }
}
function fail(): never { throw new ProfileImportTransactionError(); }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const keys = (value: unknown, names: string[]): value is Record<string, unknown> =>
  object(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const validId = (id: unknown): id is string => typeof id === "string" && id !== "all" && /^[a-z][a-z\d-]{0,63}$/.test(id);
const identity = (info: { dev: bigint; ino: bigint }): Identity => ({ dev: String(info.dev), ino: String(info.ino) });
const sameIdentity = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
const validIdentity = (value: unknown): value is Identity => object(value) &&
  typeof value.dev === "string" && /^\d+$/.test(value.dev) && typeof value.ino === "string" && /^[1-9]\d*$/.test(value.ino);
const stagePath = (t: Transaction) => join(STATE, `.profile-import-${t.token}`);
function stat(path: string) {
  try {
    const info = lstatSync(path, { bigint: true });
    if (info.isSymbolicLink() || !info.isDirectory() && (!info.isFile() || info.nlink !== 1n) ||
        process.getuid && info.uid !== BigInt(process.getuid())) fail();
    return info;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
}
function directory(path: string, expected?: Identity, optional = false) {
  const info = stat(path);
  if (!info && optional) return;
  if (!info?.isDirectory() || expected && !sameIdentity(identity(info), expected)) fail();
  return info;
}
function read(path: string, limit = Infinity, privateFile = false): string | null {
  const info = stat(path);
  if (!info) return null;
  if (!info.isFile() || info.size > BigInt(Number.isFinite(limit) ? limit : Number.MAX_SAFE_INTEGER) ||
      privateFile && (info.mode & 0o7777n) !== 0o600n) fail();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!sameIdentity(identity(opened), identity(info)) || opened.nlink !== 1n) fail();
    const bytes = readFileSync(fd), text = bytes.toString("utf8");
    if (!Buffer.from(text).equals(bytes)) fail();
    return text;
  } finally { closeSync(fd); }
}
function files(): ImportCatalogFiles {
  directory(HOME_DIR); directory(STATE);
  const config = read(CONFIG_FILE);
  if (config === null) fail();
  return { config, secrets: read(secretsFile, LIMIT) };
}
function sync(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); }
  catch (error) { if (!["EINVAL", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code || "")) throw error; }
  finally { closeSync(fd); }
}
function replace(path: string, value: string, check: () => void, exclusive = false) {
  const temp = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, value); fsyncSync(fd); closeSync(fd); fd = undefined;
    check();
    if (exclusive) renameExclusive(temp, path);
    else renameSync(temp, path);
    sync(dirname(path));
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
function portablePath(path: unknown): path is string {
  return typeof path === "string" && !path.includes("\\") && !/[\x00-\x1f\x7f]/.test(path) &&
    (path === "" || path.split("/").every(part => !!part && part !== "." && part !== ".."));
}
function allowedPath(entry: ImportPath) {
  if (!entry.path) return entry.kind === "directory";
  const [root, ...rest] = entry.path.split("/");
  if (["browser-data", "cookies", "uploads"].includes(root!)) return rest.length > 0 || entry.kind === "directory";
  if (["fingerprint.json", "native-profile.json"].includes(root!)) return !rest.length && entry.kind === "file";
  return false;
}
function validate(value: unknown): Transaction {
  if (!keys(value, ["version", "token", "direction", "stage", "profiles", "before", "after"]) || value.version !== 1 ||
      typeof value.token !== "string" || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(value.token) ||
      !["commit", "rollback"].includes(value.direction as string) || !keys(value.stage, ["dev", "ino"]) ||
      !validIdentity(value.stage) || !Array.isArray(value.profiles) || !value.profiles.length) fail();
  const t = value as unknown as Transaction;
  const ids = new Set<string>();
  for (const p of t.profiles) {
    if (!keys(p, ["id", "root", "paths", "tree"]) || !validId(p.id) || ids.has(p.id) ||
        !keys(p.root, ["dev", "ino"]) || !validIdentity(p.root) || !Array.isArray(p.paths)) fail();
    ids.add(p.id);
    const planned = new Map<string, ImportPath>();
    for (const entry of p.paths) {
      if (!keys(entry, ["path", "kind"]) || !portablePath(entry.path) || !["file", "directory"].includes(entry.kind) ||
          !allowedPath(entry) || planned.has(entry.path)) fail();
      planned.set(entry.path, entry);
    }
    if (planned.get("")?.kind !== "directory") fail();
    for (const entry of p.paths) if (entry.path && planned.get(dirname(entry.path) === "." ? "" : dirname(entry.path))?.kind !== "directory") fail();
    if (p.tree === null) { if (t.direction !== "rollback") fail(); continue; }
    if (!Array.isArray(p.tree) || !p.tree.length) fail();
    const paths = new Map<string, Entry>();
    for (const e of p.tree) {
      if (!object(e) || !validIdentity(e) || !portablePath(e.path) || paths.has(e.path) ||
          !["file", "directory"].includes(e.kind) || !allowedPath(e) ||
          !keys(e, e.kind === "file" ? ["path", "kind", "dev", "ino", "size", "modified"] : ["path", "kind", "dev", "ino"]) ||
          e.kind === "file" && (typeof e.size !== "string" || !/^\d+$/.test(e.size) ||
            typeof e.modified !== "string" || !/^-?\d+$/.test(e.modified))) fail();
      paths.set(e.path, e);
    }
    if (paths.get("")?.kind !== "directory" || !sameIdentity(paths.get("")!, p.root) || paths.size !== planned.size ||
        p.tree.some(entry => planned.get(entry.path)?.kind !== entry.kind)) fail();
    for (const e of p.tree) if (e.path && paths.get(dirname(e.path) === "." ? "" : dirname(e.path))?.kind !== "directory") fail();
  }
  for (const state of [t.before, t.after]) {
    if (!keys(state, ["config", "secrets"]) || typeof state.config !== "string" ||
        state.secrets !== null && (typeof state.secrets !== "string" || Buffer.byteLength(state.secrets) > LIMIT)) fail();
  }
  const before = validateSettings(JSON.parse(t.before.config)), after = validateSettings(JSON.parse(t.after.config));
  const added = after.profiles.slice(before.profiles.length);
  if (!isDeepStrictEqual(before, { ...after, profiles: after.profiles.slice(0, before.profiles.length) }) ||
      !isDeepStrictEqual(added.map(p => p.id), [...ids]) || added.some(p => p.storage !== "native" ||
        Object.keys(p).some(key => !["id", "name", "port", "storage", "typingMode", "proxyEnv", "expectedIPEnv"].includes(key)))) fail();
  const old = parseEnv(t.before.secrets || ""), next = parseEnv(t.after.secrets || ""), references = new Set<string>();
  const oldReferences = new Set(before.profiles.flatMap(p => [p.proxyEnv, p.expectedIPEnv]));
  for (const p of added) for (const field of ["proxyEnv", "expectedIPEnv"] as const) {
    const name = p[field];
    if (!name) continue;
    if (references.has(name) || Object.hasOwn(old, name) || Object.hasOwn(process.env, name) ||
        oldReferences.has(name)) fail();
    references.add(name);
    const value = next[name];
    if (field === "proxyEnv" && value) validateProxy(value);
    if (field === "expectedIPEnv" && value && (!isIP(value) || value.includes("%"))) fail();
  }
  for (const name of new Set([...Object.keys(old), ...Object.keys(next)])) {
    if (Object.hasOwn(old, name) ? next[name] !== old[name] : !references.has(name)) fail();
  }
  if (t.before.secrets && !t.after.secrets?.startsWith(t.before.secrets)) fail();
  return t;
}
function journal(): Transaction | undefined {
  directory(HOME_DIR, undefined, true);
  const text = read(PROFILE_IMPORT_JOURNAL, Infinity, true);
  if (text === null) return;
  directory(STATE);
  try { return validate(JSON.parse(text)); } catch { fail(); }
}
function unchanged(t: Transaction) {
  if (!isDeepStrictEqual(journal(), t)) fail();
  const current = files();
  for (const key of ["config", "secrets"] as const) if (current[key] !== t.before[key] && current[key] !== t.after[key])
    throw new ProfileImportTransactionError("Profile import conflicts with changed service files. Inspect the private import journal before continuing.");
  return current;
}
function saveJournal(t: Transaction, previous?: Transaction) {
  validate(t);
  replace(PROFILE_IMPORT_JOURNAL, JSON.stringify(t) + "\n", () => {
    if (!isDeepStrictEqual(journal(), previous) || !previous && !isDeepStrictEqual(files(), t.before)) fail();
  }, !previous);
}
function tree(path: string, relative = "", durable = false): Entry[] {
  const info = stat(path);
  if (!info) fail();
  const kind = info.isDirectory() ? "directory" : "file";
  const result: Entry[] = [{ path: relative, kind, ...identity(info),
    ...(kind === "file" ? { size: String(info.size), modified: String(info.mtimeNs) } : {}) }];
  if (kind === "directory") for (const name of readdirSync(path).sort()) {
    for (const entry of tree(join(path, name), relative ? `${relative}/${name}` : name, durable)) result.push(entry);
  }
  if (durable) sync(path);
  return result;
}
function checkTree(path: string, expected: Entry[], partial = false) {
  const actual = tree(path), wanted = new Map(expected.map(e => [e.path, e]));
  if (!partial && actual.length !== expected.length || actual.some(e => !isDeepStrictEqual(e, wanted.get(e.path)))) fail();
}
function stage(t: Transaction) {
  const path = stagePath(t), info = directory(path, t.stage, true);
  if (!info) return false;
  const ids = new Set(t.profiles.map(p => p.id));
  if ((info.mode & 0o7777n) !== 0o700n || readdirSync(path).some(name => !ids.has(name))) fail();
  return true;
}
function locations(t: Transaction, partial = false) {
  const hasStage = stage(t);
  return t.profiles.map(p => {
    const source = join(stagePath(t), p.id), target = dir(p.id);
    const a = hasStage ? stat(source) : undefined, b = stat(target);
    if (a && b || b && !p.tree || !partial && !a && !b) fail();
    const path = a ? source : b ? target : undefined;
    if (path) {
      directory(path, p.root);
      if (p.tree) checkTree(path, p.tree, partial);
      else {
        // The private root owns an incomplete preparation. It never owns an installed path.
        const entries = tree(path);
        const planned = new Map(p.paths.map(entry => [entry.path, entry.kind]));
        if (entries.some(e => planned.get(e.path) !== e.kind)) fail();
      }
    }
    return { p, path, installed: !!b };
  });
}

// Both supported kernels offer an atomic rename that refuses an occupied destination.
// A check followed by renameSync() can replace an unrelated empty directory.
function renameExclusive(source: string, target: string) {
  const oldPath = Buffer.from(source + "\0"), newPath = Buffer.from(target + "\0");
  if (process.platform === "darwin") {
    const libc = dlopen("/usr/lib/libSystem.B.dylib", {
      renamex_np: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    });
    try { if (libc.symbols.renamex_np(ptr(oldPath), ptr(newPath), 4) !== 0) fail(); }
    finally { libc.close(); }
  } else if (process.platform === "linux") {
    const libc = dlopen("libc.so.6", {
      renameat2: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    });
    try { if (libc.symbols.renameat2(-100, ptr(oldPath), -100, ptr(newPath), 1) !== 0) fail(); }
    finally { libc.close(); }
  } else fail();
}
function install(source: string, target: string) {
  renameExclusive(source, target);
  sync(STATE); sync(dirname(source));
}
function removeTree(path: string, expected: Entry[]) {
  checkTree(path, expected, true);
  for (const e of [...expected].sort((a, b) => b.path.split("/").length - a.path.split("/").length || b.path.length - a.path.length)) {
    const target = e.path ? join(path, e.path) : path, info = stat(target);
    if (!info) continue;
    if (!sameIdentity(identity(info), e)) fail();
    if (e.kind === "file") unlinkSync(target);
    else rmdirSync(target);
    sync(dirname(target));
  }
}
function finish(t: Transaction) {
  unchanged(t);
  // Preflight the complete batch before changing any service file or installed directory.
  const found = locations(t, t.direction === "rollback");
  if (t.direction === "commit") {
    for (const item of found) if (!item.installed) {
      unchanged(t); directory(stagePath(t), t.stage); checkTree(item.path!, item.p.tree!);
      if (stat(dir(item.p.id))) fail();
      install(item.path!, dir(item.p.id));
    }
    if (locations(t).some(item => !item.installed)) fail();
    if (unchanged(t).secrets !== t.after.secrets) {
      if (t.after.secrets === null) fail();
      replace(secretsFile, t.after.secrets, () => { unchanged(t); locations(t); });
    }
    sync(HOME_DIR);
    // This is the only publication point. The complete batch is visible together.
    if (unchanged(t).config !== t.after.config)
      replace(CONFIG_FILE, t.after.config, () => { unchanged(t); locations(t); });
    sync(CONFIG_FILE); sync(HOME_DIR);
  } else {
    if (unchanged(t).config !== t.before.config) fail();
    if (unchanged(t).secrets !== t.before.secrets) {
      if (t.before.secrets === null) { unchanged(t); unlinkSync(secretsFile); sync(HOME_DIR); }
      else replace(secretsFile, t.before.secrets, () => { unchanged(t); locations(t, true); });
    }
    for (const item of found) if (item.path) {
      unchanged(t);
      removeTree(item.path, item.p.tree || tree(item.path));
    }
  }
  if (stage(t)) rmdirSync(stagePath(t));
  sync(STATE);
  const desired = t.direction === "commit" ? t.after : t.before;
  if (!isDeepStrictEqual(unchanged(t), desired)) fail();
  unlinkSync(PROFILE_IMPORT_JOURNAL); sync(HOME_DIR);
}

// The caller holds admission.lock. Preparation cannot publish catalog entries.
export async function commitProfileImportTransaction(input: {
  before: ImportCatalogFiles; after: ImportCatalogFiles; ids: string[];
  layouts: ImportPath[][];
  prepare: (directory: string) => Promise<void>;
}) {
  if (journal() || !isDeepStrictEqual(files(), input.before)) fail();
  for (const id of input.ids) if (!validId(id) || stat(dir(id))) fail();
  const token = randomUUID(), path = join(STATE, `.profile-import-${token}`);
  mkdirSync(path, { mode: 0o700 }); sync(STATE);
  const profiles = input.ids.map((id, index) => {
    const profile = join(path, id); mkdirSync(profile, { mode: 0o700 });
    return { id, root: identity(directory(profile)!), paths: input.layouts[index]!, tree: null };
  });
  sync(path);
  let t: Transaction = { version: 1, token, direction: "rollback", stage: identity(directory(path)!),
    profiles, before: input.before, after: input.after };
  try {
    saveJournal(t);
    await input.prepare(path);
    unchanged(t); locations(t, true);
    const ready: Transaction = { ...t, direction: "commit", profiles: t.profiles.map(p => ({ ...p, tree: tree(join(path, p.id), "", true) })) };
    sync(path); sync(STATE);
    saveJournal(ready, t); t = ready;
    finish(t);
  } catch (error) {
    try {
      // A fault can occur after a journal rename. Read the durable direction again.
      const saved = journal();
      if (!saved) {
        if (isDeepStrictEqual(files(), input.after) && input.ids.every(id => directory(dir(id), undefined, true))) return;
        // Before journal publication, only the recorded empty roots can be removed.
        directory(path, t.stage);
        for (const p of t.profiles) {
          const target = join(path, p.id);
          if (directory(target, p.root, true)) { rmdirSync(target); sync(path); }
        }
        if (directory(path, t.stage, true) && readdirSync(path).length === 0) { rmdirSync(path); sync(STATE); }
        else if (stat(path)) fail();
      } else {
        if (saved.token !== token) fail();
        t = saved;
        if (unchanged(t).config === t.after.config) throw new ProfileImportTransactionError();
        if (t.direction !== "rollback") { const rollback: Transaction = { ...t, direction: "rollback" }; saveJournal(rollback, t); t = rollback; }
        finish(t);
      }
    } catch {
      throw new ProfileImportTransactionError("Profile import is pending. Inspect the private import journal, then retry the operation.");
    }
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ProfileImportTransactionError("Profile import failed. The previous catalog and secrets were restored.");
  }
}

// Recovery uses the durable direction. It never starts or stops a browser.
export function recoverProfileImportTransaction() {
  try { const t = journal(); if (t) finish(t); }
  catch (error) { if (error instanceof ProfileImportTransactionError) throw error; fail(); }
}
export function pendingProfileImport(): string | null {
  try {
    directory(HOME_DIR, undefined, true);
    const info = stat(PROFILE_IMPORT_JOURNAL);
    if (!info) return null;
    if (!info.isFile() || (info.mode & 0o7777n) !== 0o600n) fail();
    return "A profile import is pending. Retry the operation to complete recovery.";
  } catch { return "Profile import requires inspection. Check the private import journal and service files before continuing."; }
}
export function profileImportSecretValues(): string[] {
  try {
    directory(HOME_DIR, undefined, true);
    // Redact both snapshots even if another journal field needs manual repair.
    const raw: unknown = JSON.parse(read(PROFILE_IMPORT_JOURNAL, Infinity, true) || "null");
    if (!object(raw)) return [];
    return [raw.before, raw.after].flatMap(state => object(state) && typeof state.secrets === "string"
      ? Object.values(parseEnv(state.secrets)).filter((value): value is string => value !== undefined) : []);
  } catch { return []; }
}
