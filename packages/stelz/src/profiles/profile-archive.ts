import { createHash } from "node:crypto";
import { constants, close as closeFd, fstat, open as openFd, read as readFd, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, opendir, realpath, rm, rmdir, type FileHandle } from "node:fs/promises";
import { isIP } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";
import * as yauzl from "yauzl";
import { ZipFile } from "yazl";
import {
  ProfileTransferError, transferLimits,
  type ArchiveFile, type ArchiveMetadata, type PortableProfile, type ProfileArchiveManifest,
  type TransferLimits, type TransferOptions,
} from "./profile-transfer-types.ts";

export type WriteProfileArchiveOptions = TransferOptions & {
  snapshotDirectory: string; metadata: ArchiveMetadata; outputFile: string;
};
export type ReadProfileArchiveOptions = TransferOptions & { archiveFile: string; stagingDirectory: string };

const digestPattern = /^[a-f0-9]{64}$/;
const profilePattern = /^[a-z][a-z0-9-]{0,63}$/;
const rootLocks = new Set([".parentlock", "parent.lock", "lock"]);
const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const writeFlags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
type Kind = "file" | "directory";
type JsonObject = Record<string, unknown>;

function invalid(message: string): never { throw new ProfileTransferError(400, message); }
function limit(message: string): never { throw new ProfileTransferError(413, message); }
function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function keys(value: unknown, required: string[], optional: string[] = []): value is JsonObject {
  return object(value) && required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0 && !/[\x00-\x1f\x7f]/.test(value); }
function validId(value: unknown): value is string { return typeof value === "string" && profilePattern.test(value) && value !== "all"; }
function safeError(error: unknown, status: 400 | 500, message: string): ProfileTransferError {
  return error instanceof ProfileTransferError ? error : new ProfileTransferError(status, message);
}
function operation(options: TransferOptions, status: 400 | 500, message: string) {
  const controller = new AbortController();
  const cancel = () => controller.abort(new ProfileTransferError(400, "Profile transfer was cancelled."));
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  return {
    signal: controller.signal,
    check() { if (controller.signal.aborted) throw controller.signal.reason; },
    fail(error: unknown): ProfileTransferError {
      if (!controller.signal.aborted) controller.abort(safeError(error, status, message));
      return controller.signal.reason as ProfileTransferError;
    },
    progress(bytes: number, files: number, totalBytes?: number) {
      this.check();
      options.onProgress?.({ bytes, files, ...(totalBytes === undefined ? {} : { totalBytes }) });
      this.check();
    },
    dispose() { options.signal?.removeEventListener("abort", cancel); },
  };
}
function addBytes(current: number, amount: number, maximum: number, message: string) {
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > maximum - current) limit(message);
  return current + amount;
}

function validateMetadata(value: unknown, limits: TransferLimits): asserts value is ArchiveMetadata {
  if (!keys(value, ["format", "version", "createdAt", "source", "profiles"]) || value.format !== "stelz-profiles" || value.version !== 1)
    invalid("The archive format or version is invalid.");
  if (typeof value.createdAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value.createdAt) ||
      !Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString().replace(".000Z", "Z") !== value.createdAt.replace(".000Z", "Z"))
    invalid("The archive creation time is invalid.");
  if (!keys(value.source, ["stelzVersion", "platform", "arch", "engineSha256"]) ||
      !text(value.source.stelzVersion) || !text(value.source.platform) || !text(value.source.arch) ||
      typeof value.source.engineSha256 !== "string" || !digestPattern.test(value.source.engineSha256))
    invalid("The archive source metadata is invalid.");
  if (!Array.isArray(value.profiles) || value.profiles.length === 0) invalid("The archive must contain profile metadata.");
  if (value.profiles.length > limits.entries) limit("The archive exceeds the entry limit.");
  const ids = new Set<string>();
  for (const profile of value.profiles) {
    if (!keys(profile, ["id", "storage"], ["name", "typingMode", "proxy", "expectedIp"]) || !validId(profile.id) || ids.has(profile.id))
      invalid("Archive profile IDs must be valid, unique, and different from all.");
    ids.add(profile.id);
    if (profile.storage !== "native" && profile.storage !== "checkpoint") invalid("Archive profile storage must be native or checkpoint.");
    if (Object.hasOwn(profile, "name") && (typeof profile.name !== "string" || profile.name !== profile.name.trim() ||
        !profile.name || profile.name.length > 80 || /[\p{Cc}\p{Bidi_Control}\u2028\u2029\u206a-\u206f]/u.test(profile.name)))
      invalid("An archive profile display name is invalid.");
    if (Object.hasOwn(profile, "typingMode") && !["auto", "keyboard", "instant"].includes(profile.typingMode as string))
      invalid("An archive profile typing mode is invalid.");
    if (Object.hasOwn(profile, "expectedIp") && (typeof profile.expectedIp !== "string" ||
        profile.expectedIp !== "" && (!isIP(profile.expectedIp) || profile.expectedIp.includes("%"))))
      invalid("An archive profile expected IP is invalid.");
    if (Object.hasOwn(profile, "proxy")) {
      if (!keys(profile.proxy, [], ["url"])) invalid("An archive profile proxy is invalid.");
      if (Object.hasOwn(profile.proxy, "url")) {
        const raw = profile.proxy.url;
        if (typeof raw !== "string" || !raw || raw.length > 8192 || /[\s\\\x00-\x1f\x7f]/.test(raw))
          invalid("An archive profile proxy URL is invalid.");
        try {
          const url = new URL(raw);
          if (!["http:", "https:", "socks5:"].includes(url.protocol) || !url.hostname ||
              url.pathname !== "" && url.pathname !== "/" || url.search || url.hash ||
              url.protocol === "socks5:" && (url.username || url.password)) throw Error();
          decodeURIComponent(url.username); decodeURIComponent(url.password);
        } catch { invalid("An archive profile proxy URL is invalid. Credentials are hidden."); }
      }
    }
  }
}

function safePath(path: unknown): asserts path is string {
  if (typeof path !== "string" || !path || /[\\\x00-\x1f\x7f]/.test(path) || path.startsWith("/") || /^[a-zA-Z]:/.test(path) ||
      Buffer.byteLength(path) > 0xffff || Buffer.from(path).toString("utf8") !== path ||
      path.split("/").some(part => !part || part === "." || part === ".."))
    invalid("The archive contains an unsafe path.");
}
function durablePath(path: string, kind: Kind, profiles?: Map<string, PortableProfile>) {
  safePath(path);
  const [root, id, durable, ...rest] = path.split("/");
  if (root !== "profiles" || id !== undefined && !validId(id)) invalid("The archive contains a path outside the profile layout.");
  if (!id) {
    if (kind !== "directory") invalid("The profiles root must be a directory.");
    return;
  }
  const profile = profiles?.get(id);
  if (profiles && !profile) invalid("An archive path has no profile metadata.");
  if (!durable) {
    if (kind !== "directory") invalid("A profile root must be a directory.");
    return;
  }
  if (["fingerprint.json", "native-profile.json", "storage-state.json"].includes(durable)) {
    if (kind !== "file" || rest.length) invalid("An archive profile state path is invalid.");
  } else if (["browser-data", "cookies", "uploads"].includes(durable)) {
    if (!rest.length && kind !== "directory") invalid("An archive profile data root must be a directory.");
    if (durable === "browser-data" && rest.length === 1 && rootLocks.has(rest[0]!))
      invalid("The archive contains a native browser lock.");
  } else invalid("The archive contains profile state that cannot be transferred.");
  if (profile?.storage === "checkpoint" && ["native-profile.json", "browser-data"].includes(durable))
    invalid("A checkpoint profile contains native browser data.");
  if (profile?.storage === "native" && durable === "storage-state.json")
    invalid("A native profile contains checkpoint data.");
}

// Track implicit parents too. Reject aliases on case-insensitive filesystems.
type PathNode = { segment: string; kind: Kind; explicit: boolean; children: Map<string, PathNode> };
class Paths {
  private nodes = new Map<string, PathNode>();
  add(path: string, kind: Kind) {
    safePath(path);
    const parts = path.split("/");
    let nodes = this.nodes;
    for (let index = 0; index < parts.length; index++) {
      const segment = parts[index]!;
      const explicit = index === parts.length - 1, expected = explicit ? kind : "directory";
      const key = segment.normalize("NFC").toLowerCase(), previous = nodes.get(key);
      if (previous && (previous.segment !== segment || previous.kind !== expected || explicit && previous.explicit))
        invalid("The archive contains duplicate or conflicting paths.");
      const node: PathNode = previous ?? { segment, kind: expected, explicit: false, children: new Map() };
      node.explicit ||= explicit;
      nodes.set(key, node); nodes = node.children;
    }
  }
}

function validateManifest(value: unknown, limits: TransferLimits): asserts value is ProfileArchiveManifest {
  if (!keys(value, ["format", "version", "createdAt", "source", "profiles", "directories", "files"]))
    invalid("The archive manifest schema is invalid.");
  const { files, directories, ...metadata } = value;
  validateMetadata(metadata, limits);
  if (!Array.isArray(files) || !Array.isArray(directories)) invalid("The archive manifest must list files and directories.");
  if (files.length + directories.length + 1 > limits.entries) limit("The archive exceeds the entry limit.");
  const profiles = new Map(metadata.profiles.map(profile => [profile.id, profile])), paths = new Paths(), represented = new Set<string>();
  let expanded = 0;
  for (const path of directories) {
    safePath(path); durablePath(path, "directory", profiles); paths.add(path, "directory");
    if (path.split("/")[1]) represented.add(path.split("/")[1]!);
  }
  for (const file of files) {
    if (!keys(file, ["path", "size", "sha256"]) || typeof file.size !== "number" || !Number.isSafeInteger(file.size) || file.size < 0 ||
        typeof file.sha256 !== "string" || !digestPattern.test(file.sha256)) invalid("An archive manifest file record is invalid.");
    safePath(file.path); durablePath(file.path, "file", profiles); paths.add(file.path, "file");
    represented.add(file.path.split("/")[1]!);
    expanded = addBytes(expanded, file.size, limits.expandedBytes, "The archive exceeds the expanded size limit.");
  }
  for (const profile of metadata.profiles) if (!represented.has(profile.id)) invalid("Archive profile metadata has no corresponding entries.");
}

function regular(info: Stats) {
  if (!info.isFile() || info.nlink !== 1) invalid("Profile transfer requires regular files without filesystem links.");
}
function directory(info: Stats) {
  if (!info.isDirectory() || info.isSymbolicLink()) invalid("Profile transfer requires directories without filesystem links.");
}
function unchanged(before: Stats, after: Stats) {
  regular(after);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
    invalid("A profile transfer input changed during the operation.");
}
async function parents(root: string, relative: string, create = false) {
  directory(await lstat(root));
  let current = root;
  for (const part of relative.split("/").filter(Boolean)) {
    current = join(current, part);
    if (create) {
      try { await mkdir(current, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    directory(await lstat(current));
  }
}
function parentPath(path: string) { const slash = path.lastIndexOf("/"); return slash < 0 ? "" : path.slice(0, slash); }

// This stream owns writes, not the descriptor. Completion permits fsync before close.
function fileSink(file: FileHandle, signal: AbortSignal) {
  let pending = Promise.resolve();
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      pending = (async () => {
        for (let offset = 0; offset < chunk.length;) {
          if (signal.aborted) throw signal.reason;
          const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset, null);
          if (bytesWritten === 0) throw new ProfileTransferError(500, "A profile transfer file write made no progress.");
          offset += bytesWritten;
        }
      })();
      void pending.then(() => callback(), error => callback(error as Error));
    },
    destroy(error, callback) {
      // Do not close a descriptor while an interrupted write still uses it.
      void pending.then(() => callback(error), () => callback(error));
    },
  });
}

type Snapshot = { manifest: ProfileArchiveManifest; files: { record: ArchiveFile; info: Stats }[]; totalBytes: number };
async function snapshot(root: string, metadata: ArchiveMetadata, limits: TransferLimits, check: () => void): Promise<Snapshot> {
  const manifest: ProfileArchiveManifest = { ...metadata, directories: [], files: [] }, files: Snapshot["files"] = [];
  let manifestBytes = Buffer.byteLength(JSON.stringify(manifest)), totalBytes = 0, count = 1;
  if (manifestBytes > limits.manifestBytes) limit("The archive manifest exceeds the size limit.");
  const pending = [""], paths = new Paths(), profiles = new Map(metadata.profiles.map(profile => [profile.id, profile]));
  while (pending.length) {
    check();
    const relative = pending.pop()!;
    await parents(root, relative);
    const entries = await opendir(join(root, relative));
    for await (const entry of entries) {
      check();
      const path = relative ? `${relative}/${entry.name}` : entry.name, info = await lstat(join(root, path));
      const kind: Kind = info.isDirectory() ? "directory" : "file";
      if (kind === "directory") directory(info); else regular(info);
      durablePath(path, kind, profiles); paths.add(path, kind);
      if (++count > limits.entries) limit("The archive exceeds the entry limit.");
      if (kind === "directory") {
        manifestBytes += Buffer.byteLength(JSON.stringify(path)) + (manifest.directories.length ? 1 : 0);
        manifest.directories.push(path); pending.push(path);
      } else {
        totalBytes = addBytes(totalBytes, info.size, limits.expandedBytes, "The archive exceeds the expanded size limit.");
        const record: ArchiveFile = { path, size: info.size, sha256: "0".repeat(64) };
        manifestBytes += Buffer.byteLength(JSON.stringify(record)) + (manifest.files.length ? 1 : 0);
        manifest.files.push(record); files.push({ record, info });
      }
      if (manifestBytes > limits.manifestBytes) limit("The archive manifest exceeds the size limit.");
    }
  }
  validateManifest(manifest, limits);
  addBytes(totalBytes, manifestBytes, limits.expandedBytes, "The archive exceeds the expanded size limit.");
  return { manifest, files, totalBytes };
}

/** Stream durable snapshot files into a ZIP. Directory paths in the manifest have no trailing slash. */
export async function writeProfileArchive(options: WriteProfileArchiveOptions): Promise<ProfileArchiveManifest> {
  const op = operation(options, 500, "Cannot write the profile archive.");
  let output: FileHandle | undefined, outputInfo: Stats | undefined, outputPath: string | undefined;
  let copying: Promise<unknown> | undefined;
  const sources = new Set<Readable>(), completions = new Set<Promise<void>>();
  try {
    op.check();
    const limits = transferLimits();
    validateMetadata(options.metadata, limits);
    const metadata = JSON.parse(JSON.stringify(options.metadata)) as ArchiveMetadata;
    directory(await lstat(options.snapshotDirectory));
    const root = await realpath(options.snapshotDirectory), state = await snapshot(root, metadata, limits, () => op.check());
    op.progress(0, 0, state.totalBytes);
    outputPath = join(await realpath(dirname(resolve(options.outputFile))), basename(options.outputFile));
    try { output = await open(outputPath, writeFlags, 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ProfileTransferError(409, "The archive output already exists.");
      throw error;
    }
    outputInfo = await output.stat();
    const zip = new ZipFile(), zipOutput = zip.outputStream as Readable;
    const fail = (error: unknown) => {
      const failure = op.fail(error);
      zipOutput.destroy(failure);
      for (const source of sources) source.destroy(failure);
    };
    zip.on("error", fail);
    const abort = () => fail(op.signal.reason);
    op.signal.addEventListener("abort", abort, { once: true });
    let archiveBytes = 0, expanded = 0, bytes = 0, files = 0;
    const countArchive = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      try {
        archiveBytes = addBytes(archiveBytes, chunk.length, limits.archiveBytes, "The archive exceeds the compressed size limit.");
        callback(null, chunk);
      } catch (error) { callback(error as Error); }
    } });
    const destination = fileSink(output, op.signal);
    copying = pipeline(zipOutput, countArchive, destination, { signal: op.signal }).then(() => undefined, error => { fail(error); return error; });
    const track = (source: Readable) => {
      sources.add(source);
      source.on("error", fail);
      const completion = finished(source, { cleanup: true }).then(() => {}, () => {});
      completions.add(completion);
      void completion.then(() => { sources.delete(source); completions.delete(completion); });
      return source;
    };
    try {
      for (const path of state.manifest.directories) { op.check(); zip.addEmptyDirectory(path, { mode: 0o40700 }); }
      for (const { record, info } of state.files) {
        op.check();
        zip.addReadStreamLazy(record.path, { size: record.size, mode: 0o100600 }, callback => {
          const source = Readable.from((async function* () {
            op.check();
            await parents(root, parentPath(record.path));
            const input = await open(join(root, record.path), readFlags);
            try {
              unchanged(info, await input.stat());
              const hash = createHash("sha256");
              let size = 0;
              for (;;) {
                op.check();
                const chunk = Buffer.allocUnsafe(64 * 1024);
                const { bytesRead } = await input.read(chunk, 0, chunk.length, null);
                op.check();
                if (!bytesRead) break;
                const buffer = chunk.subarray(0, bytesRead);
                size = addBytes(size, buffer.length, record.size, "A snapshot file exceeds its declared size.");
                expanded = addBytes(expanded, buffer.length, limits.expandedBytes, "The archive exceeds the expanded size limit.");
                hash.update(buffer); bytes += buffer.length; op.progress(bytes, files, state.totalBytes);
                yield buffer;
              }
              if (size !== record.size) invalid("A snapshot file has an inconsistent size.");
              unchanged(info, await input.stat());
              record.sha256 = hash.digest("hex");
              op.progress(bytes, ++files, state.totalBytes);
            } finally { await input.close().catch(() => {}); }
          })(), { objectMode: false, highWaterMark: 64 * 1024, signal: op.signal });
          callback(null, track(source));
        });
      }
      zip.addReadStreamLazy("manifest.json", { mode: 0o100600 }, callback => {
        try {
          op.check();
          const buffer = Buffer.from(JSON.stringify(state.manifest));
          if (buffer.length > limits.manifestBytes) limit("The archive manifest exceeds the size limit.");
          expanded = addBytes(expanded, buffer.length, limits.expandedBytes, "The archive exceeds the expanded size limit.");
          callback(null, track(Readable.from([buffer], { objectMode: false, signal: op.signal })));
        } catch (error) { callback(op.fail(error), undefined as never); }
      });
      zip.end();
      const error = await copying;
      if (error) throw error;
      op.check();
      await output.sync();
      op.check();
      await output.close(); output = undefined;
      return state.manifest;
    } finally { op.signal.removeEventListener("abort", abort); }
  } catch (error) {
    const failure = op.fail(error);
    for (const source of sources) source.destroy(failure);
    await copying;
    await Promise.allSettled([...completions]);
    await output?.close().catch(() => {}); output = undefined;
    if (outputInfo && outputPath) {
      const current = await lstat(outputPath).catch(() => undefined);
      if (current?.dev === outputInfo.dev && current.ino === outputInfo.ino) await rm(outputPath, { force: true }).catch(() => {});
    }
    throw failure;
  } finally { op.dispose(); }
}

function descriptorInfo(fd: number): Promise<Stats> { return new Promise((accept, reject) => fstat(fd, (error, info) => error ? reject(error) : accept(info))); }
function closeDescriptor(fd: number): Promise<void> { return new Promise((accept, reject) => closeFd(fd, error => error ? reject(error) : accept())); }
async function openArchive(file: string, limits: TransferLimits) {
  const fd = await new Promise<number>((accept, reject) => openFd(file, readFlags, (error, value) => error ? reject(error) : accept(value)));
  try {
    const info = await descriptorInfo(fd); regular(info);
    if (info.size > limits.archiveBytes) limit("The archive exceeds the compressed size limit.");
    const zip = await yauzl.fromFdPromise(fd, { autoClose: false, lazyEntries: true, decodeStrings: true, strictFileNames: true, validateEntrySizes: true });
    return { zip, fd, info };
  } catch (error) { await closeDescriptor(fd).catch(() => {}); throw error; }
}
function nextEntry(zip: yauzl.ZipFile, signal: AbortSignal): Promise<yauzl.Entry | undefined> {
  return new Promise((accept, reject) => {
    const cleanup = () => {
      zip.removeListener("entry", entry); zip.removeListener("end", end); zip.removeListener("error", fail);
      signal.removeEventListener("abort", abort);
    };
    const entry = (value: yauzl.Entry) => { cleanup(); accept(value); };
    const end = () => { cleanup(); accept(undefined); };
    const fail = (error: unknown) => { cleanup(); reject(error); };
    const abort = () => fail(signal.reason);
    if (signal.aborted) { reject(signal.reason); return; }
    zip.once("entry", entry); zip.once("end", end); zip.once("error", fail);
    signal.addEventListener("abort", abort, { once: true });
    try { zip.readEntry(); } catch (error) { fail(error); }
  });
}

function zipEntry(entry: yauzl.Entry): { path: string; kind: Kind } {
  const kind: Kind = entry.fileName.endsWith("/") ? "directory" : "file";
  const path = kind === "directory" ? entry.fileName.slice(0, -1) : entry.fileName;
  safePath(path);
  const raw = entry.fileNameRaw.toString("latin1");
  safePath(kind === "directory" ? raw.slice(0, -1) : raw);
  if (entry.generalPurposeBitFlag & 0x800) {
    try { new TextDecoder("utf-8", { fatal: true }).decode(entry.fileNameRaw); }
    catch { invalid("A ZIP entry name is not valid UTF-8."); }
  }
  if (entry.generalPurposeBitFlag & 0x2041) invalid("Encrypted ZIP entries are not supported.");
  if (![0, 8].includes(entry.compressionMethod)) invalid("The archive uses an unsupported ZIP compression method.");
  const type = (entry.externalFileAttributes >>> 16) & 0o170000;
  if (type !== 0 && type !== (kind === "file" ? 0o100000 : 0o040000) ||
      entry.externalFileAttributes & 0x448 || kind === "file" && (entry.externalFileAttributes & 0x10))
    invalid("ZIP entries must be regular files or directories without filesystem links.");
  for (const extra of entry.extraFields) {
    if (extra.id === 0x000d && extra.data.length > 12 || extra.id === 0x756e &&
        (extra.data.length !== 14 || ![0, kind === "file" ? 0o100000 : 0o040000].includes(extra.data.readUInt16LE(4) & 0o170000)))
      invalid("The archive contains ZIP filesystem link metadata.");
  }
  if (kind === "directory" && (entry.uncompressedSize !== 0 || entry.compressedSize !== 0 || entry.compressionMethod !== 0 || entry.crc32 !== 0))
    invalid("A ZIP directory has inconsistent sizes or data.");
  if (path !== "manifest.json") durablePath(path, kind);
  else if (kind !== "file") invalid("The archive manifest must be a regular file.");
  return { path, kind };
}
function uint64(buffer: Buffer, offset: number) {
  if (offset + 8 > buffer.length) invalid("A ZIP64 size field is incomplete.");
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) invalid("A ZIP64 size field exceeds the supported integer range.");
  return Number(value);
}
async function readAt(fd: number, position: number, length: number) {
  const buffer = Buffer.alloc(length);
  const bytes = await new Promise<number>((accept, reject) => readFd(fd, buffer, 0, length, position, (error, size) => error ? reject(error) : accept(size)));
  return buffer.subarray(0, bytes);
}
async function localEntry(zip: yauzl.ZipFile, fd: number, entry: yauzl.Entry, centralStart: number) {
  const local = await zip.readLocalFileHeaderPromise(entry);
  if (!local.fileName.equals(entry.fileNameRaw) || local.generalPurposeBitFlag !== entry.generalPurposeBitFlag || local.compressionMethod !== entry.compressionMethod)
    invalid("ZIP local headers do not match the directory records.");
  let size = local.uncompressedSize, compressed = local.compressedSize, offset = 0;
  if (size === 0xffffffff || compressed === 0xffffffff) {
    const extra = yauzl.parseExtraFields(local.extraField).find(field => field.id === 1);
    if (!extra) invalid("A ZIP64 local header has no size fields.");
    if (size === 0xffffffff) { size = uint64(extra.data, offset); offset += 8; }
    if (compressed === 0xffffffff) compressed = uint64(extra.data, offset);
  }
  const streaming = (local.generalPurposeBitFlag & 8) !== 0;
  if ((!streaming || size !== 0) && size !== entry.uncompressedSize ||
      (!streaming || compressed !== 0) && compressed !== entry.compressedSize ||
      (!streaming || local.crc32 !== 0) && local.crc32 !== entry.crc32)
    invalid("A ZIP local header has inconsistent sizes or checksum.");
  let end = local.fileDataStart + entry.compressedSize;
  if (!Number.isSafeInteger(end) || entry.relativeOffsetOfLocalHeader < 0 || end > centralStart)
    invalid("ZIP file data overlaps the central directory.");
  if (streaming) {
    const data = await readAt(fd, end, Math.min(24, centralStart - end));
    let descriptorLength = 0;
    for (const start of [0, 4]) {
      if (start === 4 && (data.length < 4 || data.readUInt32LE(0) !== 0x08074b50)) continue;
      if (data.length < start + 12 || data.readUInt32LE(start) !== entry.crc32) continue;
      if (data.readUInt32LE(start + 4) === entry.compressedSize && data.readUInt32LE(start + 8) === entry.uncompressedSize)
        descriptorLength = start + 12;
      if (data.length >= start + 20 && data.readBigUInt64LE(start + 4) === BigInt(entry.compressedSize) &&
          data.readBigUInt64LE(start + 12) === BigInt(entry.uncompressedSize)) descriptorLength = start + 20;
      if (descriptorLength) break;
    }
    if (!descriptorLength) invalid("A ZIP data descriptor has inconsistent sizes or checksum.");
    end += descriptorLength;
  }
  return { start: entry.relativeOffsetOfLocalHeader, end };
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let index = 0; index < 8; index++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function updateCrc(crc: number, buffer: Buffer) {
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8);
  return crc;
}

/** Extract files and verify their contents against the manifest. Preserve source IDs for import. */
export async function readProfileArchive(options: ReadProfileArchiveOptions): Promise<ProfileArchiveManifest> {
  const op = operation(options, 400, "Cannot read the profile archive. The ZIP data or local files are invalid.");
  let archive: Awaited<ReturnType<typeof openArchive>> | undefined, staging: string | undefined, created = false;
  const createdFiles: string[] = [], createdDirectories: string[] = [];
  try {
    op.check();
    const limits = transferLimits();
    archive = await openArchive(options.archiveFile, limits);
    const { zip, fd, info } = archive;
    zip.on("error", error => { op.fail(error); });
    if (!Number.isSafeInteger(zip.entryCount) || zip.entryCount < 1) invalid("The archive ZIP entry count is invalid.");
    if (zip.entryCount > limits.entries) limit("The archive exceeds the entry limit.");
    const centralStart = (zip as unknown as { readEntryCursor: number }).readEntryCursor;
    if (!Number.isSafeInteger(centralStart) || centralStart < 0 || centralStart > info.size) invalid("The ZIP central directory offset is invalid.");
    const target = resolve(options.stagingDirectory);
    let initial: Stats | undefined;
    try { initial = await lstat(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (initial) {
      directory(initial);
      for await (const _entry of await opendir(target)) throw new ProfileTransferError(409, "The archive staging directory must be empty.");
    } else { await mkdir(target, { mode: 0o700 }); created = true; staging = target; }
    staging = await realpath(target);
    await chmod(staging, 0o700);
    const ensureDirectories = async (path: string) => {
      let current = staging!;
      directory(await lstat(current));
      for (const part of path.split("/").filter(Boolean)) {
        current = join(current, part);
        try { await mkdir(current, { mode: 0o700 }); createdDirectories.push(current); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        directory(await lstat(current));
      }
    };
    op.progress(0, 0);
    const paths = new Paths(), files = new Map<string, ArchiveFile>(), directories = new Set<string>(), ranges: { start: number; end: number }[] = [];
    let manifest: ProfileArchiveManifest | undefined, expanded = 0, declared = 0, bytes = 0, count = 0, manifestSize = 0, recordBytes = 0;
    for (;;) {
      op.check();
      const entry = await nextEntry(zip, op.signal);
      if (!entry) break;
      if (++count > limits.entries) limit("The archive exceeds the entry limit.");
      const { path, kind } = zipEntry(entry);
      if (path !== "manifest.json") {
        recordBytes = addBytes(recordBytes, Buffer.byteLength(JSON.stringify(kind === "directory" ? path :
          { path, size: entry.uncompressedSize, sha256: "0".repeat(64) })), limits.manifestBytes,
        "The archive entry records exceed the manifest size limit.");
      }
      paths.add(path, kind);
      for (const size of [entry.compressedSize, entry.uncompressedSize, entry.relativeOffsetOfLocalHeader])
        if (!Number.isSafeInteger(size) || size < 0) invalid("A ZIP entry has an invalid size or offset.");
      if (entry.compressedSize > info.size) invalid("A ZIP entry exceeds the archive size.");
      declared = addBytes(declared, entry.uncompressedSize, limits.expandedBytes, "The archive exceeds the declared expanded size limit.");
      if (path === "manifest.json" && entry.uncompressedSize > limits.manifestBytes) limit("The archive manifest exceeds the size limit.");
      ranges.push(await localEntry(zip, fd, entry, centralStart));
      op.check();
      if (kind === "directory") {
        await ensureDirectories(path); directories.add(path); continue;
      }
      await ensureDirectories(parentPath(path));
      const destination = join(staging, path);
      let output: FileHandle;
      try { output = await open(destination, writeFlags, 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") invalid("An archive output path already exists or conflicts with another entry.");
        throw error;
      }
      createdFiles.push(destination);
      const hash = createHash("sha256"), chunks: Buffer[] = [];
      let size = 0, crc = 0xffffffff;
      const counter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        try {
          op.check();
          expanded = addBytes(expanded, chunk.length, limits.expandedBytes, "The archive exceeds the actual expanded size limit.");
          size += chunk.length;
          if (!Number.isSafeInteger(size) || size > entry.uncompressedSize) invalid("A ZIP entry exceeds its declared size.");
          hash.update(chunk); crc = updateCrc(crc, chunk);
          if (path === "manifest.json") {
            if (size > limits.manifestBytes) limit("The archive manifest exceeds the size limit.");
            chunks.push(chunk);
          } else { bytes += chunk.length; op.progress(bytes, files.size); }
          callback(null, chunk);
        } catch (error) { callback(error as Error); }
      } });
      try {
        const source = await zip.openReadStreamPromise(entry, { decodeFileData: false });
        const inflater = entry.compressionMethod === 8 ? createInflateRaw() : undefined;
        const targetStream = fileSink(output, op.signal);
        if (inflater) await pipeline(source, inflater, counter, targetStream, { signal: op.signal });
        else await pipeline(source, counter, targetStream, { signal: op.signal });
        if (inflater && inflater.bytesWritten !== entry.compressedSize) invalid("A ZIP entry has an inconsistent compressed size.");
      } finally { await output.close().catch(() => {}); }
      if (size !== entry.uncompressedSize || ((crc ^ 0xffffffff) >>> 0) !== entry.crc32)
        invalid("A ZIP entry has an inconsistent size or checksum.");
      if (path === "manifest.json") {
        manifestSize = size;
        let value: unknown;
        try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))); }
        catch { invalid("The archive manifest is not valid UTF-8 JSON."); }
        validateManifest(value, limits); manifest = value;
      } else {
        files.set(path, { path, size, sha256: hash.digest("hex") });
        op.progress(bytes, files.size);
      }
    }
    if (!manifest) invalid("The archive has no manifest.json file.");
    if (count !== zip.entryCount) invalid("The ZIP entry count is inconsistent.");
    addBytes(manifest.files.reduce((total, file) => total + file.size, 0), manifestSize, limits.expandedBytes, "The archive exceeds the expanded size limit.");
    if (files.size !== manifest.files.length || directories.size !== manifest.directories.length ||
        manifest.directories.some(path => !directories.has(path))) invalid("ZIP entries do not match the archive manifest.");
    for (const expected of manifest.files) {
      const actual = files.get(expected.path);
      if (!actual || actual.size !== expected.size || actual.sha256 !== expected.sha256)
        invalid("An archive file does not match its manifest size or SHA-256 digest.");
    }
    ranges.sort((left, right) => left.start - right.start);
    for (let index = 1; index < ranges.length; index++) if (ranges[index]!.start < ranges[index - 1]!.end)
      invalid("ZIP entries contain overlapping file data.");
    unchanged(info, await descriptorInfo(fd));
    op.progress(bytes, files.size, bytes);
    zip.close(); archive = undefined;
    return manifest;
  } catch (error) {
    const failure = op.fail(error);
    archive?.zip.close(); archive = undefined;
    // Remove only paths this call created. Preserve an existing empty staging root.
    for (const file of createdFiles.reverse()) await rm(file, { force: true }).catch(() => {});
    for (const path of createdDirectories.reverse()) await rmdir(path).catch(() => {});
    if (created && staging) await rmdir(staging).catch(() => {});
    throw failure;
  } finally { op.dispose(); }
}
