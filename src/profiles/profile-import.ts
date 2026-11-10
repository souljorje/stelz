import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readdirSync, readSync, writeSync,
} from "node:fs";
import { createServer, isIP, type Server } from "node:net";
import { isAbsolute, join } from "node:path";
import { parseEnv } from "node:util";
import {
  HOME_DIR, STATE, executable, parseProfileName, serializeSettings, validateProxy, validateSettings, type Profile,
} from "./config.ts";
import { isTypingMode } from "../browser/typing.ts";
import { catalogRevision, prepareProfileConfiguration } from "./profile-configuration.ts";
import { readCatalogFile, readCatalogFiles } from "./profile-catalog.ts";
import { commitProfileImportTransaction, pendingProfileImport, type ImportPath } from "./profile-import-transaction.ts";
import { checkSavedFingerprint, engineFileSha256, readSavedFingerprint } from "./fingerprint-check.ts";
import {
  ProfileTransferError, type ArchiveFile, type ImportSelection, type PortableProfile,
  type ProfileArchiveManifest, type ProfileImportPreview, type ProfileImportResult, type TransferFingerprint, type TransferOptions,
} from "./profile-transfer-types.ts";

const validId = (id: unknown): id is string => typeof id === "string" && id !== "all" && /^[a-z][a-z\d-]{0,63}$/.test(id);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function invalid(): never { throw new ProfileTransferError(400, "Profile import data is invalid. Select a valid profile archive."); }
function changed(): never { throw new ProfileTransferError(409, "Import files changed. Upload the archive again before continuing."); }
function cancelled(signal?: AbortSignal) { if (signal?.aborted) throw new DOMException("Profile import was cancelled.", "AbortError"); }
function safePath(path: unknown): path is string {
  return typeof path === "string" && !path.includes("\\") && !/[\x00-\x1f\x7f]/.test(path) &&
    path.split("/").every(part => !!part && part !== "." && part !== "..");
}
function allowedRelative(path: string, kind: "file" | "directory") {
  const [root, ...rest] = path.split("/");
  if (["browser-data", "cookies", "uploads"].includes(root!)) return rest.length > 0 || kind === "directory";
  return kind === "file" && !rest.length && ["fingerprint.json", "native-profile.json"].includes(root!);
}
function validateManifest(manifest: ProfileArchiveManifest) {
  if (!object(manifest) || manifest.format !== "stelz-profiles" || manifest.version !== 1 ||
      !object(manifest.source) || typeof manifest.createdAt !== "string" ||
      ["stelzVersion", "platform", "arch"].some(key => typeof manifest.source[key as keyof typeof manifest.source] !== "string") ||
      !/^[a-f\d]{64}$/.test(manifest.source.engineSha256) || !Array.isArray(manifest.profiles) || !manifest.profiles.length ||
      !Array.isArray(manifest.files) || !Array.isArray(manifest.directories)) invalid();
  const ids = new Set<string>();
  for (const p of manifest.profiles) {
    if (!object(p) || !validId(p.id) || ids.has(p.id) || p.storage !== "native" ||
        Object.keys(p).some(key => !["id", "name", "storage", "typingMode", "proxy", "expectedIp"].includes(key)) ||
        p.typingMode !== undefined && !isTypingMode(p.typingMode)) invalid();
    ids.add(p.id);
    if (p.name !== undefined) { try { if (parseProfileName(p.name) !== p.name) invalid(); } catch { invalid(); } }
    if (Object.hasOwn(p, "proxy")) {
      if (!object(p.proxy) || Object.keys(p.proxy).some(key => key !== "url")) invalid();
      if (Object.hasOwn(p.proxy, "url")) {
        const value = p.proxy.url;
        if (typeof value !== "string" || !value || value.length > 8192 || /[\s\\\x00-\x1f\x7f]/.test(value))
          throw new ProfileTransferError(400, "The archive proxy URL is invalid. Credentials are hidden.");
        try { encodeURIComponent(value); validateProxy(value); }
        catch { throw new ProfileTransferError(400, "The archive proxy URL is invalid. Credentials are hidden."); }
      }
    }
    if (Object.hasOwn(p, "expectedIp") && (typeof p.expectedIp !== "string" ||
        p.expectedIp !== "" && (!isIP(p.expectedIp) || p.expectedIp.includes("%"))))
      throw new ProfileTransferError(400, "The archive expected IP must be empty or an IPv4 or IPv6 address.");
  }
  const paths = new Set<string>();
  const entry = (path: unknown, kind: "file" | "directory") => {
    if (!safePath(path) || paths.has(path)) invalid();
    paths.add(path);
    if (kind === "directory" && path === "profiles") return;
    const [root, id, ...rest] = path.split("/");
    if (root !== "profiles" || !id || !ids.has(id) ||
        (rest.length ? !allowedRelative(rest.join("/"), kind) : kind !== "directory")) invalid();
  };
  for (const path of manifest.directories) entry(path, "directory");
  for (const file of manifest.files) {
    if (!object(file) || !Number.isSafeInteger(file.size) || file.size < 0 ||
        typeof file.sha256 !== "string" || !/^[a-f\d]{64}$/.test(file.sha256)) invalid();
    entry(file.path, "file");
  }
}
function stat(path: string) {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isDirectory() && (!info.isFile() || info.nlink !== 1) ||
        process.getuid && info.uid !== process.getuid()) changed();
    return info;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
}
function directory(path: string, optional = false) {
  const info = stat(path);
  if (!info && optional) return false;
  if (!info?.isDirectory()) changed();
  return true;
}
type SourceProfile = { profile: PortableProfile; directory: string; files: { file: ArchiveFile; relative: string }[]; directories: string[]; issues: string[]; fingerprint: TransferFingerprint };
async function sources(manifest: ProfileArchiveManifest, stagingDirectory: string, validateContents = true, signal?: AbortSignal): Promise<SourceProfile[]> {
  if (typeof stagingDirectory !== "string" || !isAbsolute(stagingDirectory)) invalid();
  directory(stagingDirectory);
  const parent = join(stagingDirectory, "profiles"), hasParent = directory(parent, true);
  const ids = new Set(manifest.profiles.map(p => p.id));
  if (hasParent && readdirSync(parent).some(name => !ids.has(name))) changed();
  const fileLists = new Map<string, { file: ArchiveFile; relative: string }[]>(), directoryLists = new Map<string, Set<string>>();
  for (const file of manifest.files) {
    const [, id, ...rest] = file.path.split("/");
    const list = fileLists.get(id!) || []; list.push({ file, relative: rest.join("/") }); fileLists.set(id!, list);
  }
  for (const value of manifest.directories) {
    const [, id, ...rest] = value.split("/");
    if (!id || !rest.length) continue;
    const list = directoryLists.get(id) || new Set<string>(); list.add(rest.join("/")); directoryLists.set(id, list);
  }
  const result: SourceProfile[] = [];
  for (const profile of manifest.profiles) {
    cancelled(signal);
    const path = join(parent, profile.id);
    const listed = new Map((fileLists.get(profile.id) || []).map(item => [item.relative, item.file]));
    const listedDirectories = directoryLists.get(profile.id) || new Set<string>(), allowedDirectories = new Set(listedDirectories);
    for (const value of [...listed.keys(), ...listedDirectories]) {
      const parts = value.split("/");
      for (let index = 1; index < parts.length; index++) allowedDirectories.add(parts.slice(0, index).join("/"));
    }
    const files: SourceProfile["files"] = [], directories: string[] = [];
    const walk = (root: string, relative = "") => {
      if (!directory(root, true)) return;
      for (const name of readdirSync(root).sort()) {
        const child = join(root, name), current = relative ? `${relative}/${name}` : name, info = stat(child);
        if (!info) changed();
        const kind = info.isDirectory() ? "directory" : "file";
        if (!safePath(current) || !allowedRelative(current, kind)) changed();
        if (kind === "directory") {
          // Ancestor directories may be implicit in an archive. Extra empty directories are not imported.
          if (!allowedDirectories.has(current)) changed();
          directories.push(current); walk(child, current);
        } else {
          const file = listed.get(current);
          if (!file || info.size !== file.size) changed();
          files.push({ file, relative: current });
        }
      }
    };
    if (hasParent) walk(path);
    const presentDirectories = new Set(directories);
    if (files.length !== listed.size || [...listedDirectories].some(name => !presentDirectories.has(name))) changed();
    const issues: string[] = [], names = new Set(files.map(item => item.relative));
    const marker = names.has("native-profile.json"), native = directories.includes("browser-data");
    if (marker && !native) issues.push("A native marker has no browser-data directory.");
    const json = (name: string, limit: number): unknown => {
      try {
        const file = join(path, name), info = stat(file);
        if (!info?.isFile() || info.size > limit) return;
        const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const opened = fstatSync(fd);
          if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.nlink !== 1 || opened.size > limit) changed();
          const buffer = Buffer.alloc(Math.min(opened.size + 1, limit + 1));
          let length = 0;
          while (length < buffer.length) { const count = readSync(fd, buffer, length, buffer.length - length, null); if (!count) break; length += count; }
          if (length > limit || length !== opened.size) return;
          const bytes = buffer.subarray(0, length), text = bytes.toString("utf8");
          if (!Buffer.from(text).equals(bytes)) return;
          return JSON.parse(text);
        } finally { closeSync(fd); }
      } catch { return; }
    };
    if (validateContents && marker) { const value = json("native-profile.json", 64 * 1024); if (!object(value) || value.version !== 1) issues.push("The native marker is invalid or exceeds 64 KiB."); }
    let fingerprint: TransferFingerprint = { status: "uninitialized" };
    if (validateContents && names.has("fingerprint.json")) {
      const read = await readSavedFingerprint(join(path, "fingerprint.json"));
      if (read.status === "missing") changed();
      if (read.status === "present" && read.sha256 !== listed.get("fingerprint.json")!.sha256) changed();
      const validation = checkSavedFingerprint(read, { expectedEngineSha256: manifest.source.engineSha256, admissionRequired: true });
      fingerprint = { status: "checked", validation };
      if (validation.engineSha256 !== "PASS")
        issues.push("The fingerprint pin is unreadable, exceeds 16 MiB, or uses a different or unknown browser executable.");
    } else if (!names.has("fingerprint.json") && (native || marker)) issues.push("Saved browser data requires a fingerprint pin.");
    result.push({ profile, directory: path, files, directories, issues, fingerprint });
  }
  return result;
}
async function compatibility(manifest: ProfileArchiveManifest, signal?: AbortSignal): Promise<string[]> {
  const issues: string[] = [];
  if (manifest.source.platform !== process.platform) issues.push("The archive requires the same operating system.");
  if (manifest.source.arch !== process.arch) issues.push("The archive requires the same CPU architecture.");
  try {
    if (await engineFileSha256(executable(), signal) !== manifest.source.engineSha256)
      issues.push("The archive requires the exact browser executable. Engine migration is unavailable.");
  } catch { cancelled(signal); issues.push("The local browser executable is unavailable. Configure it before importing profiles."); }
  return issues;
}
function copyName(name: string, number: number) {
  const suffix = number === 1 ? " (copy)" : ` (copy ${number})`;
  return name.slice(0, 80 - suffix.length).trimEnd() + suffix;
}
function onDisk(id: string) {
  try { lstatSync(join(STATE, id)); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function suggestions(manifest: ProfileArchiveManifest, configured: string[]) {
  directory(HOME_DIR); directory(STATE);
  const occupied = new Set([...configured, ...readdirSync(STATE)]), used = new Set([...occupied, ...manifest.profiles.map(p => p.id)]);
  return manifest.profiles.map(p => {
    if (!occupied.has(p.id) && !onDisk(p.id)) return { sourceId: p.id, id: p.id, name: p.name ?? p.id };
    for (let number = 1; ; number++) {
      const suffix = number === 1 ? "-copy" : `-copy-${number}`, id = p.id.slice(0, 64 - suffix.length) + suffix;
      if (used.has(id) || onDisk(id)) continue;
      used.add(id);
      return { sourceId: p.id, id, name: copyName(p.name ?? p.id, number) };
    }
  });
}
function proxyDisplay(profile: PortableProfile) {
  if (!profile.proxy) return null;
  if (!profile.proxy.url) return "Proxy unavailable";
  const url = validateProxy(profile.proxy.url);
  return `${url.protocol}//${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "1080")}`;
}

export async function inspectProfileImport(manifest: ProfileArchiveManifest, stagingDirectory: string): Promise<ProfileImportPreview> {
  validateManifest(manifest);
  const before = readCatalogFiles(), config = validateSettings(JSON.parse(before.config));
  const [saved, issues] = await Promise.all([sources(manifest, stagingDirectory), compatibility(manifest)]);
  const pending = pendingProfileImport();
  if (pending) issues.push(pending);
  const proposed = suggestions(manifest, config.profiles.map(p => p.id));
  return {
    revision: catalogRevision(config), source: { ...manifest.source }, compatible: !issues.length, issues,
    profiles: saved.map((item, index) => ({ ...proposed[index]!, storage: item.profile.storage,
      proxyDisplay: proxyDisplay(item.profile), proxyUnavailable: !!item.profile.proxy && !item.profile.proxy.url,
      issues: item.issues, fingerprint: item.fingerprint })),
  };
}

async function reservePort(port: number): Promise<Server | undefined> {
  return new Promise((resolve, reject) => {
    const server = createServer(); server.unref();
    server.once("error", error => ["EADDRINUSE", "EACCES"].includes((error as NodeJS.ErrnoException).code || "") ? resolve(undefined) : reject(error));
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
function importedLayout(source: SourceProfile): ImportPath[] {
  const paths: ImportPath[] = [{ path: "", kind: "directory" }];
  for (const path of source.directories) paths.push({ path, kind: "directory" });
  for (const { relative } of source.files) paths.push({ path: relative, kind: "file" });
  return paths;
}
async function copyFile(source: SourceProfile, relative: string, target: string, expected: ArchiveFile, options: TransferOptions, progress: { bytes: number; files: number; totalBytes: number }) {
  cancelled(options.signal); directory(source.directory);
  const parts = relative.split("/");
  for (let index = 1; index < parts.length; index++) directory(join(source.directory, ...parts.slice(0, index)));
  const path = join(source.directory, relative), info = stat(path);
  if (!info?.isFile() || info.size !== expected.size) changed();
  const input = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let output: number | undefined;
  try {
    const opened = fstatSync(input);
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.nlink !== 1 || opened.size !== expected.size) changed();
    output = openSync(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    const hash = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
    let size = 0;
    for (;;) {
      cancelled(options.signal);
      const count = readSync(input, buffer, 0, buffer.length, null);
      if (!count) break;
      size += count; if (size > expected.size) changed();
      hash.update(buffer.subarray(0, count));
      for (let written = 0; written < count;) written += writeSync(output, buffer, written, count - written);
      progress.bytes += count; options.onProgress?.({ ...progress });
      await Bun.sleep(0);
    }
    const after = fstatSync(input), current = stat(path);
    if (size !== expected.size || hash.digest("hex") !== expected.sha256 || after.nlink !== 1 ||
        after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs ||
        !current || current.dev !== opened.dev || current.ino !== opened.ino) changed();
    fsyncSync(output);
    progress.files++; options.onProgress?.({ ...progress });
  } finally { closeSync(input); if (output !== undefined) closeSync(output); }
}

export async function commitProfileImport(input: {
  manifest: ProfileArchiveManifest; stagingDirectory: string; revision: string; profiles: ImportSelection[];
} & TransferOptions): Promise<ProfileImportResult> {
  validateManifest(input.manifest); cancelled(input.signal);
  if (typeof input.revision !== "string" || !/^[a-f\d]{64}$/.test(input.revision) || !Array.isArray(input.profiles) || !input.profiles.length) invalid();
  const selections = structuredClone(input.profiles), manifest = structuredClone(input.manifest);
  const metadata = new Map(manifest.profiles.map(p => [p.id, p]));
  const sourceIds = new Set<string>(), ids = new Set<string>();
  for (const selection of selections) {
    if (!object(selection) || !validId(selection.id) || !validId(selection.sourceId) || ids.has(selection.id) || sourceIds.has(selection.sourceId) ||
        !metadata.has(selection.sourceId) || Object.keys(selection).some(key => !["sourceId", "id", "name"].includes(key))) invalid();
    if (selection.name !== undefined) { try { selection.name = parseProfileName(selection.name); } catch { invalid(); } }
    ids.add(selection.id); sourceIds.add(selection.sourceId);
  }
  return prepareProfileConfiguration(async () => {
    cancelled(input.signal);
    const before = readCatalogFiles(), config = validateSettings(JSON.parse(before.config));
    if (catalogRevision(config) !== input.revision) throw new ProfileTransferError(409, "Profiles changed. Refresh the import preview before continuing.");
    const proposed = new Map(suggestions(manifest, config.profiles.map(p => p.id)).map(p => [p.sourceId, p]));
    const occupied = new Set([...config.profiles.map(p => p.id), ...readdirSync(STATE)]);
    for (const id of ids) if (occupied.has(id) || onDisk(id))
      throw new ProfileTransferError(409, "An import destination is occupied. Refresh the import preview before continuing.");
    const [saved, issues] = await Promise.all([sources(manifest, input.stagingDirectory, true, input.signal), compatibility(manifest, input.signal)]);
    if (issues.length || saved.some(p => sourceIds.has(p.profile.id) && p.issues.length))
      throw new ProfileTransferError(409, "The selected profiles are incompatible with this service. Inspect the import preview before continuing.");
    const ports = new Set(config.profiles.map(p => p.port)), reservations: Server[] = [];
    for (const entry of readdirSync(STATE, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) changed();
      if (!entry.isDirectory()) continue;
      const record = readCatalogFile(join(STATE, entry.name, "running.json"));
      if (record) {
        try { const value = JSON.parse(record); if (Number.isInteger(value.port)) ports.add(value.port); }
        catch { throw new ProfileTransferError(409, "A saved process record requires inspection before importing profiles."); }
      }
    }
    const oldSecrets = parseEnv(before.secrets || ""), used = new Set([
      ...Object.keys(oldSecrets), ...Object.keys(process.env), ...config.profiles.flatMap(p => [p.proxyEnv, p.expectedIPEnv]).filter((name): name is string => !!name),
    ]);
    let nextSecrets = before.secrets, port = 9377;
    const imported: Profile[] = [], result: ProfileImportResult = {
      profiles: [], fingerprintDiagnostics: saved.filter(p => sourceIds.has(p.profile.id))
        .map(p => ({ sourceId: p.profile.id, fingerprint: p.fingerprint })),
    };
    const addSecret = (p: Profile, field: "proxyEnv" | "expectedIPEnv", value?: string) => {
      let name: string;
      do { name = `STELZ_${randomUUID().replaceAll("-", "").toUpperCase()}_${field === "proxyEnv" ? "PROXY_URL" : "EXPECTED_IP"}`; } while (used.has(name));
      used.add(name); p[field] = name;
      if (value) {
        nextSecrets = (nextSecrets || "") + (nextSecrets && !nextSecrets.endsWith("\n") ? "\n" : "") + `${name}=${value}\n`;
        if (parseEnv(nextSecrets)[name] !== value) throw new ProfileTransferError(409, "The secrets file cannot safely store the imported credentials.");
      }
    };
    try {
      for (const selection of selections) {
        cancelled(input.signal);
        let reservation: Server | undefined;
        while (port <= 65535) {
          if (!ports.has(port)) reservation = await reservePort(port);
          if (reservation) break;
          port++;
        }
        if (!reservation) throw new ProfileTransferError(409, "No profile port is available.");
        reservations.push(reservation); ports.add(port);
        const source = metadata.get(selection.sourceId)!, suggestion = proposed.get(source.id)!;
        const name = selection.name ?? (selection.id === suggestion.id ? suggestion.name : selection.id === source.id ? source.name ?? source.id : copyName(source.name ?? source.id, 1));
        const p: Profile = { id: selection.id, port, storage: source.storage,
          ...(name !== selection.id ? { name } : {}), ...(source.typingMode !== undefined ? { typingMode: source.typingMode } : {}) };
        if (source.proxy) addSecret(p, "proxyEnv", source.proxy.url);
        if (Object.hasOwn(source, "expectedIp")) addSecret(p, "expectedIPEnv", source.expectedIp);
        imported.push(p); result.profiles.push({ sourceId: source.id, id: p.id, name });
      }
      if (nextSecrets !== null && Buffer.byteLength(nextSecrets) > 1024 * 1024)
        throw new ProfileTransferError(413, "Imported credentials exceed the secrets file size limit.");
      const values = parseEnv(nextSecrets || "");
      for (const [name, value] of Object.entries(oldSecrets)) if (values[name] !== value)
        throw new ProfileTransferError(409, "The secrets file cannot safely store the imported credentials.");
      const next = validateSettings({ ...config, profiles: [...config.profiles, ...imported] });
      const byId = new Map(saved.map(p => [p.profile.id, p]));
      await commitProfileImportTransaction({ before, after: { config: serializeSettings(next), secrets: nextSecrets }, ids: imported.map(p => p.id),
        layouts: selections.map(selection => importedLayout(byId.get(selection.sourceId)!)),
        prepare: async stage => {
          const refreshed = new Map((await sources(manifest, input.stagingDirectory, false, input.signal)).map(p => [p.profile.id, p]));
          const selected = selections.map(selection => ({ selection, source: refreshed.get(selection.sourceId)! }));
          const progress = { bytes: 0, files: 0, totalBytes: selected.reduce((sum, p) => sum + p.source.files.reduce((bytes, entry) => bytes + entry.file.size, 0), 0) };
          input.onProgress?.({ ...progress });
          for (const { selection, source } of selected) {
            cancelled(input.signal);
            const target = join(stage, selection.id); directory(target);
            for (const relative of source.directories) mkdirSync(join(target, relative), { mode: 0o700 });
            for (const { file, relative } of source.files) {
              let destination = join(target, relative);
              await copyFile(source, relative, destination, file, input, progress);
            }
            const pinFile = source.files.find(({ relative }) => relative === "fingerprint.json");
            if (pinFile) {
              // The engine check must describe the integrity-verified bytes that will be published.
              const read = await readSavedFingerprint(join(target, "fingerprint.json"));
              if (read.status === "missing") changed();
              if (read.status === "present" && read.sha256 !== pinFile.file.sha256) changed();
              const validation = checkSavedFingerprint(read, { expectedEngineSha256: manifest.source.engineSha256, admissionRequired: true });
              if (validation.engineSha256 !== "PASS")
                throw new ProfileTransferError(409, "The imported fingerprint uses a different or unknown browser executable.");
              const diagnostic = result.fingerprintDiagnostics?.find(item => item.sourceId === selection.sourceId);
              if (diagnostic) diagnostic.fingerprint = { status: "checked", validation };
            }
          }
          await sources(manifest, input.stagingDirectory, false, input.signal); cancelled(input.signal);
        },
      });
      return result;
    } finally { await Promise.all(reservations.map(server => new Promise<void>(resolve => server.close(() => resolve())))); }
  });
}
