import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync, lstatSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { createWriteStream } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { deflateRawSync } from "node:zlib";
import { readProfileArchive, writeProfileArchive } from "../../src/profiles/profile-archive.ts";
import {
  ProfileTransferError, type ArchiveMetadata, type ProfileArchiveManifest, type TransferProgress,
} from "../../src/profiles/profile-transfer-types.ts";

// The runtime dependencies belong to the publishable workspace package.
const { ZipFile } = createRequire(new URL("../../package.json", import.meta.url))("yazl") as typeof import("yazl");
const temporary = new Set<string>();
afterEach(() => { for (const path of temporary) rmSync(path, { recursive: true, force: true }); temporary.clear(); });
function workspace() { const path = mkdtempSync(join(tmpdir(), "stelz-archive-")); temporary.add(path); return path; }
function put(root: string, path: string, value: string | Buffer) {
  const file = join(root, path); mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, value, { mode: 0o600 });
}
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
function metadata(): ArchiveMetadata {
  return {
    format: "stelz-profiles", version: 1, createdAt: "2026-11-05T08:00:00.000Z",
    source: { stelzVersion: "0.2.1", platform: "darwin", arch: "arm64", engineSha256: "e".repeat(64) },
    profiles: [{ id: "source", name: "Saved sessions", storage: "checkpoint", typingMode: "instant", expectedIp: "" }],
  };
}
const checkpoint = JSON.stringify({ cookies: [{ name: "session", value: "private-cookie" }], origins: [] });
const statePath = "profiles/source/storage-state.json";
function manifest(data: string | Buffer = checkpoint): ProfileArchiveManifest {
  return { ...metadata(), directories: ["profiles", "profiles/source"], files: [{ path: statePath, size: Buffer.byteLength(data), sha256: sha256(data) }] };
}

type RawEntry = {
  name: string; data?: string | Buffer; method?: number; flags?: number; mode?: number; attributes?: number;
  size?: number; compressedSize?: number; localSize?: number; localCompressedSize?: number;
  localName?: string; localFlags?: number; crc?: number; extra?: Buffer; localExtra?: Buffer; descriptor?: Buffer;
};
function crc32(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
// This fixture encoder intentionally permits paths and headers that yazl rejects.
function rawZip(entries: RawEntry[]) {
  const locals: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? ""), name = Buffer.from(entry.name), localName = Buffer.from(entry.localName ?? entry.name);
    const method = entry.method ?? 0, compressed = method === 8 ? deflateRawSync(data) : data;
    const size = entry.size ?? data.length, compressedSize = entry.compressedSize ?? compressed.length;
    const crc = entry.crc ?? crc32(data), flags = entry.flags ?? 0x800, extra = entry.extra ?? Buffer.alloc(0), localExtra = entry.localExtra ?? Buffer.alloc(0);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(entry.localFlags ?? flags, 6); header.writeUInt16LE(method, 8);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(entry.localCompressedSize ?? compressedSize, 18);
    header.writeUInt32LE(entry.localSize ?? size, 22); header.writeUInt16LE(localName.length, 26); header.writeUInt16LE(localExtra.length, 28);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(0x033f, 4); record.writeUInt16LE(20, 6);
    record.writeUInt16LE(flags, 8); record.writeUInt16LE(method, 10); record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(compressedSize, 20); record.writeUInt32LE(size, 24);
    record.writeUInt16LE(name.length, 28); record.writeUInt16LE(extra.length, 30);
    record.writeUInt32LE(entry.attributes ?? ((entry.mode ?? (entry.name.endsWith("/") ? 0o40700 : 0o100600)) << 16) >>> 0, 38);
    record.writeUInt32LE(offset, 42);
    let descriptor = entry.descriptor ?? Buffer.alloc(0);
    if (flags & 8 && !entry.descriptor) {
      descriptor = Buffer.alloc(16); descriptor.writeUInt32LE(0x08074b50, 0); descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(compressedSize, 8); descriptor.writeUInt32LE(size, 12);
    }
    locals.push(header, localName, localExtra, compressed, descriptor); central.push(record, name, extra);
    offset += header.length + localName.length + localExtra.length + compressed.length + descriptor.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
function entries(value: unknown = manifest(), data: string | Buffer = checkpoint): RawEntry[] {
  return [
    { name: "manifest.json", data: JSON.stringify(value), method: 8 },
    { name: "profiles/" }, { name: "profiles/source/" }, { name: statePath, data, method: 8 },
  ];
}
async function rejectArchive(data: Buffer, status?: ProfileTransferError["status"], match?: string) {
  const root = workspace(), archiveFile = join(root, "hostile.zip"), stagingDirectory = join(root, "staging");
  writeFileSync(archiveFile, data, { mode: 0o600 }); mkdirSync(stagingDirectory, { mode: 0o700 });
  const error: unknown = await readProfileArchive({ archiveFile, stagingDirectory }).then(() => undefined, error => error);
  expect(error).toBeInstanceOf(ProfileTransferError);
  if (status !== undefined) expect((error as ProfileTransferError).status).toBe(status);
  if (match) expect((error as Error).message).toContain(match);
  expect(existsSync(stagingDirectory)).toBe(true);
  expect(readdirSync(stagingDirectory)).toEqual([]);
  expect(readFileSync(archiveFile).equals(data)).toBe(true);
  return error as ProfileTransferError;
}
const environment = ["STELZ_TRANSFER_ARCHIVE_BYTES", "STELZ_TRANSFER_EXPANDED_BYTES", "STELZ_TRANSFER_ENTRIES", "STELZ_TRANSFER_MANIFEST_BYTES"];
async function limits(values: Record<string, string>, action: () => Promise<void>) {
  const previous = environment.map(key => [key, process.env[key]] as const);
  try {
    for (const key of environment) delete process.env[key];
    Object.assign(process.env, values); await action();
  } finally { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}
function multiSnapshot() {
  const root = workspace(), snapshotDirectory = join(root, "snapshot"), outputFile = join(root, "profiles.zip");
  const meta = metadata();
  meta.profiles.push({ id: "native-one", name: "Native browser", storage: "native", typingMode: "keyboard", proxy: { url: "https://user:secret@proxy.example:8443" } });
  const files = new Map<string, string | Buffer>([
    [statePath, checkpoint], ["profiles/source/fingerprint.json", '{"version":1,"opaque":true}'],
    ["profiles/source/cookies/input.json", '[{"name":"reusable","value":"private"}]'],
    ["profiles/native-one/fingerprint.json", '{"version":2,"opaque":true}'],
    ["profiles/native-one/native-profile.json", '{"version":1}'],
    ["profiles/native-one/browser-data/prefs.js", '// Native content remains opaque.\n'],
    ["profiles/native-one/browser-data/storage/default/lock", "Nested lock names are native data."],
    ["profiles/native-one/browser-data/storage/default/session.sqlite", Buffer.from(Array.from({ length: 256 * 1024 }, (_, index) => index % 251))],
    ["profiles/native-one/cookies/reusable.json", "[]"], ["profiles/native-one/uploads/input.bin", Buffer.from([0, 255, 42])],
  ]);
  for (const [path, data] of files) put(snapshotDirectory, path, data);
  for (const path of ["profiles/source/uploads", "profiles/native-one/browser-data/empty"])
    mkdirSync(join(snapshotDirectory, path), { recursive: true, mode: 0o700 });
  return { root, snapshotDirectory, outputFile, metadata: meta, files };
}

test("streaming multi-profile round trip preserves durable state, native cookie inputs, empty directories, and private modes", async () => {
  const fixture = multiSnapshot(), packing: TransferProgress[] = [], extracting: TransferProgress[] = [];
  const written = await writeProfileArchive({ ...fixture, onProgress: progress => packing.push(progress) });
  const stagingDirectory = join(fixture.root, "staging");
  const read = await readProfileArchive({ archiveFile: fixture.outputFile, stagingDirectory, onProgress: progress => extracting.push(progress) });
  expect(read).toEqual(written); expect(read.profiles).toEqual(fixture.metadata.profiles); expect(read.source).toEqual(fixture.metadata.source);
  expect(read.directories).toContain("profiles/native-one/browser-data/empty");
  expect(read.directories).toContain("profiles/source/uploads");
  expect(read.directories.every(path => !path.endsWith("/"))).toBe(true);
  expect(read.files).toHaveLength(fixture.files.size);
  let total = 0;
  for (const record of read.files) {
    const data = Buffer.from(fixture.files.get(record.path)!); total += data.length;
    expect(readFileSync(join(stagingDirectory, record.path))).toEqual(data);
    expect(record).toEqual({ path: record.path, size: data.length, sha256: sha256(data) });
    expect(statSync(join(stagingDirectory, record.path)).mode & 0o777).toBe(0o600);
  }
  for (const path of ["", ...read.directories]) expect(statSync(join(stagingDirectory, path)).mode & 0o777).toBe(0o700);
  expect(statSync(fixture.outputFile).mode & 0o777).toBe(0o600);
  expect(statSync(join(stagingDirectory, "manifest.json")).mode & 0o777).toBe(0o600);
  for (const progress of [packing, extracting]) {
    expect(progress.at(-1)).toEqual({ bytes: total, files: fixture.files.size, totalBytes: total });
    for (let index = 1; index < progress.length; index++) expect(progress[index]!.bytes).toBeGreaterThanOrEqual(progress[index - 1]!.bytes);
  }
});

test("empty native browser-data survives a round trip", async () => {
  const root = workspace(), snapshotDirectory = join(root, "snapshot"), outputFile = join(root, "empty.zip"), meta = metadata();
  meta.profiles = [{ id: "empty-native", storage: "native", proxy: {} }];
  put(snapshotDirectory, "profiles/empty-native/native-profile.json", '{"version":1}');
  mkdirSync(join(snapshotDirectory, "profiles/empty-native/browser-data"), { mode: 0o700 });
  const written = await writeProfileArchive({ snapshotDirectory, metadata: meta, outputFile });
  const stagingDirectory = join(root, "staging"), read = await readProfileArchive({ archiveFile: outputFile, stagingDirectory });
  expect(read).toEqual(written); expect(readdirSync(join(stagingDirectory, "profiles/empty-native/browser-data"))).toEqual([]);
});

test("profile count is bounded by archive entries without a separate profile ceiling", async () => {
  await limits({ STELZ_TRANSFER_ENTRIES: "300" }, async () => {
    const root = workspace(), snapshotDirectory = join(root, "snapshot"), outputFile = join(root, "many.zip"), meta = metadata();
    meta.profiles = Array.from({ length: 129 }, (_, index) => ({ id: `profile-${index}`, storage: "checkpoint" as const }));
    for (const profile of meta.profiles) mkdirSync(join(snapshotDirectory, "profiles", profile.id), { recursive: true, mode: 0o700 });
    const written = await writeProfileArchive({ snapshotDirectory, metadata: meta, outputFile });
    const read = await readProfileArchive({ archiveFile: outputFile, stagingDirectory: join(root, "staging") });
    expect(read.profiles).toHaveLength(129); expect(read).toEqual(written);
  });
}, 15_000);

test("reader accepts forced ZIP64 records and streaming ZIP64 data descriptors", async () => {
  const root = workspace(), archiveFile = join(root, "zip64.zip"), value = manifest(), zip = new ZipFile();
  const copying = pipeline(zip.outputStream, createWriteStream(archiveFile, { flags: "wx", mode: 0o600 }));
  for (const path of value.directories) zip.addEmptyDirectory(path, { mode: 0o40700 });
  zip.addReadStreamLazy(statePath, { size: Buffer.byteLength(checkpoint), forceZip64Format: true, mode: 0o100600 }, callback => callback(null, Readable.from([Buffer.from(checkpoint)])));
  zip.addBuffer(Buffer.from(JSON.stringify(value)), "manifest.json", { mode: 0o100600 });
  zip.end({ forceZip64Format: true, comment: "" }); await copying;
  expect(readFileSync(archiveFile).includes(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBe(true);
  expect(await readProfileArchive({ archiveFile, stagingDirectory: join(root, "staging") })).toEqual(value);
});

test("reader accepts a manifest after the profile entries", async () => {
  const root = workspace(), archiveFile = join(root, "manifest-last.zip"), value = entries();
  value.push(value.shift()!); writeFileSync(archiveFile, rawZip(value));
  expect(await readProfileArchive({ archiveFile, stagingDirectory: join(root, "staging") })).toEqual(manifest());
});

for (const name of [
  "/outside", "C:/outside", "C:outside", "profiles\\source\\upload.bin", "profiles/source/../outside",
  "profiles/./source/uploads/a", "profiles//source/uploads/a", "profiles/source/uploads/a\0b", "profiles/source/uploads/a\nb",
  "profiles/source/uploads/a\x7fb", "secrets.env", "profiles/source/access-key", "profiles/source/running.json",
  "profiles/source/storage/hash/storage-state.json", "profiles/unknown/uploads/a", "profiles/all/uploads/a",
]) test(`reader rejects unsafe or nondurable ZIP path ${JSON.stringify(name)}`, async () => {
  await rejectArchive(rawZip([...entries(), { name, data: "private-input" }]), 400);
});

for (const lock of [".parentlock", "parent.lock", "lock"]) test(`native root lock ${lock} is forbidden`, async () => {
  await rejectArchive(rawZip([...entries(), { name: `profiles/source/browser-data/${lock}`, data: "" }]), 400, "lock");
  const fixture = multiSnapshot(); put(fixture.snapshotDirectory, `profiles/native-one/browser-data/${lock}`, "");
  await expect(writeProfileArchive(fixture)).rejects.toBeInstanceOf(ProfileTransferError);
  expect(existsSync(fixture.outputFile)).toBe(false);
});

for (const mode of [0o120777, 0o010600, 0o020600, 0o060600, 0o140600, 0o040700])
  test(`reader rejects ZIP link or special file mode ${mode.toString(8)}`, async () => {
    const value = entries(); value.at(-1)!.mode = mode;
    await rejectArchive(rawZip(value), 400, "regular files");
  });

for (const flags of [0x801, 0x840, 0x2800]) test(`reader rejects encrypted ZIP flags ${flags.toString(16)}`, async () => {
  const value = entries(); value.at(-1)!.flags = flags;
  await rejectArchive(rawZip(value), 400);
});

test("reader rejects ZIP hardlink metadata", async () => {
  const value = entries(), data = Buffer.alloc(20); data.writeUInt16LE(0x000d, 0); data.writeUInt16LE(16, 2);
  data.write("link", 16); value.at(-1)!.extra = data;
  await rejectArchive(rawZip(value), 400, "link metadata");
});

test("reader rejects duplicate entries even when bytes and manifest hashes match", async () => {
  const value = entries(); value.push({ ...value.at(-1)! });
  await rejectArchive(rawZip(value), 400, "conflicting paths");
});
test("reader rejects a second root manifest", async () => {
  const value = entries(); value.push({ ...value[0]! });
  await rejectArchive(rawZip(value), 400, "conflicting paths");
});
test("reader rejects file and directory ancestor collisions", async () => {
  await rejectArchive(rawZip([...entries(), { name: "profiles/source/uploads/a", data: "file" }, { name: "profiles/source/uploads/a/child", data: "child" }]), 400, "conflicting paths");
});
test("reader rejects path aliases on case-insensitive filesystems", async () => {
  await rejectArchive(rawZip([...entries(), { name: "profiles/source/uploads/A", data: "file" }, { name: "profiles/source/uploads/a", data: "alias" }]), 400, "conflicting paths");
});
test("reader rejects Unicode normalization aliases", async () => {
  await rejectArchive(rawZip([...entries(), { name: "profiles/source/uploads/\u00e9", data: "file" }, { name: "profiles/source/uploads/e\u0301", data: "alias" }]), 400, "conflicting paths");
});

const malformedManifests: [string, (value: ProfileArchiveManifest) => void][] = [
  ["unknown root field", value => { Object.assign(value, { token: "do-not-echo-this-secret" }); }],
  ["unsupported version", value => { Object.assign(value, { version: 2 }); }],
  ["unknown format", value => { Object.assign(value, { format: "other" }); }],
  ["invalid time", value => { value.createdAt = "2026-02-31T08:00:00.000Z"; }],
  ["unknown source field", value => { Object.assign(value.source, { secret: "do-not-echo-this-secret" }); }],
  ["missing source field", value => { delete (value.source as Partial<typeof value.source>).arch; }],
  ["invalid engine hash", value => { value.source.engineSha256 = "not-a-hash"; }],
  ["uppercase profile ID", value => { value.profiles[0]!.id = "Source"; }],
  ["reserved profile ID", value => { value.profiles[0]!.id = "all"; }],
  ["duplicate profile IDs", value => { value.profiles.push({ ...value.profiles[0]! }); }],
  ["orphan profile metadata", value => { value.profiles.push({ id: "orphan", storage: "checkpoint" }); }],
  ["missing profiles", value => { value.profiles = []; }],
  ["unknown storage mode", value => { Object.assign(value.profiles[0]!, { storage: "unknown" }); }],
  ["native storage checkpoint", value => { value.profiles[0]!.storage = "native"; }],
  ["unknown profile field", value => { Object.assign(value.profiles[0]!, { accessKey: "do-not-echo-this-secret" }); }],
  ["invalid typing mode", value => { Object.assign(value.profiles[0]!, { typingMode: "paced" }); }],
  ["invalid expected IP", value => { value.profiles[0]!.expectedIp = "proxy.example"; }],
  ["invalid display name", value => { value.profiles[0]!.name = "untrimmed "; }],
  ["unknown proxy field", value => { Object.assign(value.profiles[0]!, { proxy: { token: "do-not-echo-this-secret" } }); }],
  ["invalid proxy URL", value => { value.profiles[0]!.proxy = { url: "https://user:do-not-echo-this-secret@proxy.example/path" }; }],
  ["duplicate files", value => { value.files.push({ ...value.files[0]! }); }],
  ["duplicate directories", value => { value.directories.push(value.directories[0]!); }],
  ["file and directory collision", value => { value.directories.push(statePath); }],
  ["trailing directory slash", value => { value.directories[0] += "/"; }],
  ["invalid file hash", value => { value.files[0]!.sha256 = "A".repeat(64); }],
  ["fractional file size", value => { value.files[0]!.size = 0.5; }],
  ["negative file size", value => { value.files[0]!.size = -1; }],
  ["unknown file field", value => { Object.assign(value.files[0]!, { mode: "symlink" }); }],
];
for (const [name, mutate] of malformedManifests) test(`reader rejects manifest ${name}`, async () => {
  const value = manifest(); mutate(value);
  const error = await rejectArchive(rawZip(entries(value)), 400);
  expect(error.message).not.toContain("do-not-echo-this-secret");
  expect(error.message).not.toContain("private-cookie");
});

test("reader checks full correspondence for extra ZIP files", async () => {
  await rejectArchive(rawZip([...entries(), { name: "profiles/source/uploads/unlisted", data: "private" }]), 400, "match");
});
test("reader checks full correspondence for missing ZIP files", async () => {
  await rejectArchive(rawZip(entries().slice(0, -1)), 400, "match");
});
test("reader checks full correspondence for missing directory entries", async () => {
  await rejectArchive(rawZip(entries().filter(entry => entry.name !== "profiles/source/")), 400, "match");
});
test("reader checks full correspondence for extra ZIP directories", async () => {
  await rejectArchive(rawZip([...entries(), { name: "profiles/source/uploads/" }]), 400, "match");
});
test("reader rejects a missing manifest", async () => {
  await rejectArchive(rawZip(entries().slice(1)), 400, "no manifest");
});
test("reader rejects non-JSON and invalid UTF-8 manifests without exposing the input", async () => {
  for (const data of [Buffer.from("do-not-echo-this-secret"), Buffer.from([0xff, 0xfe])]) {
    const value = entries(); value[0]!.data = data;
    const error = await rejectArchive(rawZip(value), 400, "UTF-8 JSON");
    expect(error.message).not.toContain("do-not-echo-this-secret");
  }
});
test("reader verifies SHA-256 even when ZIP checksums and sizes are valid", async () => {
  const value = manifest(); value.files[0]!.sha256 = "0".repeat(64);
  await rejectArchive(rawZip(entries(value)), 400, "SHA-256");
});
test("reader verifies ZIP CRC even when the manifest hash is valid", async () => {
  const value = entries(); value.at(-1)!.crc = 0;
  await rejectArchive(rawZip(value), 400, "checksum");
});

for (const [name, mutate] of [
  ["local file name", (entry: RawEntry) => { entry.localName = "profiles/source/other.json"; }],
  ["local expanded size", (entry: RawEntry) => { entry.localSize = Buffer.byteLength(checkpoint) + 1; }],
  ["local compressed size", (entry: RawEntry) => { entry.localCompressedSize = 1; }],
  ["local encryption flag", (entry: RawEntry) => { entry.localFlags = 0x801; }],
  ["actual expanded size too small", (entry: RawEntry) => { entry.size = Buffer.byteLength(checkpoint) + 1; }],
  ["actual expanded size too large", (entry: RawEntry) => { entry.size = Buffer.byteLength(checkpoint) - 1; }],
  ["compressed trailing bytes", (entry: RawEntry) => { entry.compressedSize = deflateRawSync(Buffer.from(checkpoint)).length + 1; }],
  ["invalid data descriptor", (entry: RawEntry) => { entry.flags = 0x808; entry.descriptor = Buffer.alloc(16); }],
] as const) test(`reader rejects inconsistent ZIP ${name}`, async () => {
  const value = entries(); mutate(value.at(-1)!); await rejectArchive(rawZip(value), 400);
});
test("reader rejects unsupported ZIP compression", async () => {
  const value = entries(); value.at(-1)!.method = 99; await rejectArchive(rawZip(value), 400, "compression");
});
test("reader rejects directory payloads", async () => {
  const value = entries(); value[1]!.data = "hidden"; await rejectArchive(rawZip(value), 400, "directory");
});
test("reader rejects truncated ZIPs and safe errors do not contain archive data", async () => {
  const data = rawZip(entries());
  for (const buffer of [Buffer.from("private-cookie"), data.subarray(0, data.length - 10)]) {
    const error = await rejectArchive(buffer, 400); expect(error.message).not.toContain("private-cookie");
  }
});

test("reader enforces declared expanded bytes before decompression", async () => {
  const value = entries(); value.at(-1)!.size = 1024 ** 3;
  await limits({ STELZ_TRANSFER_EXPANDED_BYTES: "2048" }, async () => { await rejectArchive(rawZip(value), 413, "declared expanded"); });
});
test("reader stops a decompression bomb that lies about its expanded size", async () => {
  const data = Buffer.alloc(2 * 1024 ** 2, 65), value = manifest(data);
  value.files[0]!.size = 8;
  const archive = entries(value, data); archive.at(-1)!.size = 8;
  await limits({ STELZ_TRANSFER_EXPANDED_BYTES: "2048" }, async () => { await rejectArchive(rawZip(archive), 413, "actual expanded"); });
});
for (const key of ["STELZ_TRANSFER_ARCHIVE_BYTES", "STELZ_TRANSFER_ENTRIES", "STELZ_TRANSFER_MANIFEST_BYTES"])
  test(`reader enforces ${key}`, async () => {
    await limits({ [key]: key === "STELZ_TRANSFER_ENTRIES" ? "2" : "32" }, async () => { await rejectArchive(rawZip(entries()), 413); });
  });

for (const key of environment) test(`writer enforces ${key} and removes its partial output`, async () => {
  const fixture = multiSnapshot();
  await limits({ [key]: key === "STELZ_TRANSFER_ENTRIES" ? "2" : "32" }, async () => {
    await expect(writeProfileArchive(fixture)).rejects.toBeInstanceOf(ProfileTransferError);
    expect(existsSync(fixture.outputFile)).toBe(false);
  });
});

test("writer abort during streaming removes only its partial output", async () => {
  const fixture = multiSnapshot(), controller = new AbortController();
  let observed = false;
  await expect(writeProfileArchive({ ...fixture, signal: controller.signal, onProgress(progress) {
    if (progress.bytes > 0) { observed = true; controller.abort("do-not-echo-this-secret"); }
  } })).rejects.toThrow("cancelled");
  expect(observed).toBe(true); expect(existsSync(fixture.outputFile)).toBe(false);
  expect(readFileSync(join(fixture.snapshotDirectory, statePath), "utf8")).toBe(checkpoint);
});
test("reader abort during streaming empties an existing staging root", async () => {
  const fixture = multiSnapshot(); await writeProfileArchive(fixture);
  const stagingDirectory = join(fixture.root, "staging"), controller = new AbortController(); mkdirSync(stagingDirectory, { mode: 0o700 });
  await expect(readProfileArchive({ archiveFile: fixture.outputFile, stagingDirectory, signal: controller.signal, onProgress(progress) {
    if (progress.bytes > 0) controller.abort("do-not-echo-this-secret");
  } })).rejects.toThrow("cancelled");
  expect(existsSync(stagingDirectory)).toBe(true); expect(readdirSync(stagingDirectory)).toEqual([]);
  expect(existsSync(fixture.outputFile)).toBe(true);
});
test("reader abort removes a staging root it created", async () => {
  const fixture = multiSnapshot(); await writeProfileArchive(fixture);
  const stagingDirectory = join(fixture.root, "new-staging"), controller = new AbortController();
  await expect(readProfileArchive({ archiveFile: fixture.outputFile, stagingDirectory, signal: controller.signal, onProgress(progress) {
    if (progress.bytes > 0) controller.abort();
  } })).rejects.toThrow("cancelled");
  expect(existsSync(stagingDirectory)).toBe(false);
});
test("pre-aborted operations create no output or staging paths", async () => {
  const fixture = multiSnapshot(), controller = new AbortController(); controller.abort("private reason");
  await expect(writeProfileArchive({ ...fixture, signal: controller.signal })).rejects.toThrow("cancelled");
  const stagingDirectory = join(fixture.root, "staging");
  await expect(readProfileArchive({ archiveFile: fixture.outputFile, stagingDirectory, signal: controller.signal })).rejects.toThrow("cancelled");
  expect(existsSync(fixture.outputFile)).toBe(false); expect(existsSync(stagingDirectory)).toBe(false);
});

test("writer refuses existing output files and symbolic links without deleting them", async () => {
  for (const symlink of [false, true]) {
    const fixture = multiSnapshot(), existing = join(fixture.root, "existing"); writeFileSync(existing, "keep-existing");
    if (symlink) symlinkSync(existing, fixture.outputFile); else writeFileSync(fixture.outputFile, "keep-existing");
    await expect(writeProfileArchive(fixture)).rejects.toThrow("already exists");
    expect(readFileSync(fixture.outputFile, "utf8")).toBe("keep-existing");
    expect(lstatSync(fixture.outputFile).isSymbolicLink()).toBe(symlink);
  }
});
test("reader refuses nonempty staging without deleting caller files", async () => {
  const fixture = multiSnapshot(); await writeProfileArchive(fixture);
  const stagingDirectory = join(fixture.root, "staging"); put(stagingDirectory, "keep", "caller-data");
  await expect(readProfileArchive({ archiveFile: fixture.outputFile, stagingDirectory })).rejects.toThrow("must be empty");
  expect(readFileSync(join(stagingDirectory, "keep"), "utf8")).toBe("caller-data");
});
test("reader refuses staging symbolic links without changing their targets", async () => {
  const fixture = multiSnapshot(); await writeProfileArchive(fixture);
  const target = join(fixture.root, "target"), stagingDirectory = join(fixture.root, "staging");
  mkdirSync(target, { mode: 0o700 }); symlinkSync(target, stagingDirectory);
  await expect(readProfileArchive({ archiveFile: fixture.outputFile, stagingDirectory })).rejects.toBeInstanceOf(ProfileTransferError);
  expect(lstatSync(stagingDirectory).isSymbolicLink()).toBe(true); expect(readdirSync(target)).toEqual([]);
});
for (const kind of ["symlink-file", "symlink-directory", "hardlink"] as const)
  test(`writer rejects snapshot ${kind} without modifying the source`, async () => {
    const fixture = multiSnapshot(), target = join(fixture.root, "outside");
    if (kind === "symlink-directory") mkdirSync(target); else writeFileSync(target, "outside-data");
    const path = join(fixture.snapshotDirectory, "profiles/native-one/browser-data/unsafe");
    if (kind === "hardlink") linkSync(target, path); else symlinkSync(target, path);
    await expect(writeProfileArchive(fixture)).rejects.toBeInstanceOf(ProfileTransferError);
    expect(existsSync(fixture.outputFile)).toBe(false); expect(existsSync(target)).toBe(true);
  });
test("writer rejects nondurable state instead of exporting service credentials", async () => {
  const fixture = multiSnapshot(); put(fixture.snapshotDirectory, "profiles/source/access-key", "do-not-echo-this-secret");
  const error = await writeProfileArchive(fixture).then(() => undefined, error => error);
  expect(error).toBeInstanceOf(ProfileTransferError); expect(error.message).not.toContain("do-not-echo-this-secret");
  expect(existsSync(fixture.outputFile)).toBe(false);
});
test("writer detects snapshot changes between inventory and streaming", async () => {
  const fixture = multiSnapshot(); let changed = false;
  await expect(writeProfileArchive({ ...fixture, onProgress(progress) {
    if (!changed && progress.bytes === 0) { changed = true; put(fixture.snapshotDirectory, statePath, "replacement-state"); }
  } })).rejects.toThrow("changed");
  expect(changed).toBe(true); expect(existsSync(fixture.outputFile)).toBe(false);
});
test("progress callback failures cancel streaming and do not expose callback secrets", async () => {
  const fixture = multiSnapshot();
  const error = await writeProfileArchive({ ...fixture, onProgress(progress) {
    if (progress.bytes > 0) throw Error("do-not-echo-this-secret");
  } }).then(() => undefined, error => error);
  expect(error).toBeInstanceOf(ProfileTransferError); expect(error.message).not.toContain("do-not-echo-this-secret");
  expect(existsSync(fixture.outputFile)).toBe(false);
});
