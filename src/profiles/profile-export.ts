import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { link, lstat, mkdir, open, readdir, readFile, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { isIP } from "node:net";
import { parseEnv } from "node:util";
import { dir, executable, typingMode, validateProxy, validateSettings } from "./config.ts";
import { prepareProfileConfiguration } from "./profile-configuration.ts";
import { checkCatalogDirectory, readCatalogFiles } from "./profile-catalog.ts";
import { assertStoppedProfile, lock } from "../runtime/profile-process.ts";
import { hasProxy } from "./network-compat.ts";
import { writeProfileArchive } from "./profile-archive.ts";
import { validCheckpointFile } from "./profile-import.ts";
import { STELZ_VERSION } from "../versions.ts";
import { ProfileTransferError, transferLimits, type ArchiveMetadata, type PortableProfile, type TransferOptions } from "./profile-transfer-types.ts";

export async function browserEngineSha256(): Promise<string> {
  try {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(executable())) hash.update(chunk);
    return hash.digest("hex");
  } catch { throw new ProfileTransferError(409, "The Camoufox executable is unavailable. Correct its path before transferring profiles."); }
}

async function optionalInfo(path: string) {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
}

export type ExportProfileOptions = TransferOptions & {
  profileIds?: string[];
  all?: boolean;
  outputFile: string;
  workDirectory: string;
  onPhase?: (phase: "snapshotting" | "packing") => void;
};

/** Keep admission and all selected lifecycle locks until the private snapshot is complete. */
export async function exportProfileArchive(options: ExportProfileOptions) {
  const { signal } = options, limits = transferLimits();
  if (!options.all && (!Array.isArray(options.profileIds) || !options.profileIds.length) ||
      options.all && options.profileIds?.length || options.profileIds?.some(id => !/^[a-z][a-z\d-]{0,63}$/.test(id) || id === "all") ||
      options.profileIds && new Set(options.profileIds).size !== options.profileIds.length)
    throw new ProfileTransferError(400, "Select one or more distinct profiles to export.");
  const snapshot = join(options.workDirectory, "snapshot");
  const temporary = join(dirname(options.outputFile), `.${basename(options.outputFile)}.${randomUUID()}.tmp`);
  await mkdir(snapshot, { mode: 0o700 });
  let bytes = 0, files = 0, entries = 0;
  const count = () => { if (++entries > limits.entries - 1) throw new ProfileTransferError(413, "The profiles contain too many files for one archive."); };
  const progress = () => options.onProgress?.({ bytes, files });
  async function copy(source: string, target: string, nativeRoot = false) {
    signal?.throwIfAborted();
    const info = await lstat(source);
    if (info.isSymbolicLink() || !info.isDirectory() && (!info.isFile() || info.nlink !== 1))
      throw new ProfileTransferError(409, "Saved profile data contains a link or special file. Inspect it before exporting.");
    count();
    if (info.isDirectory()) {
      await mkdir(target, { mode: 0o700 });
      for (const item of await readdir(source, { withFileTypes: true })) {
        if (nativeRoot && [".parentlock", "parent.lock", "lock"].includes(item.name)) continue;
        await copy(join(source, item.name), join(target, item.name));
      }
      const after = await lstat(source);
      if (after.dev !== info.dev || after.ino !== info.ino || after.mtimeMs !== info.mtimeMs)
        throw new ProfileTransferError(409, "Saved profile data changed during export. Keep the profiles stopped and try again.");
      return;
    }
    if (bytes + info.size > limits.expandedBytes) throw new ProfileTransferError(413, "The saved profile data exceeds the transfer size limit.");
    const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== info.dev || opened.ino !== info.ino)
        throw new ProfileTransferError(409, "Saved profile data changed during export. Try again after inspection.");
      const meter = new Transform({ transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > limits.expandedBytes) return callback(new ProfileTransferError(413, "The saved profile data exceeds the transfer size limit."));
        progress(); callback(null, chunk);
      } });
      await pipeline(handle.createReadStream({ autoClose: false, emitClose: false }), meter, createWriteStream(target, { flags: "wx", mode: 0o600 }), { signal });
      const after = await handle.stat(), current = await lstat(source);
      if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || current.dev !== info.dev || current.ino !== info.ino)
        throw new ProfileTransferError(409, "Saved profile data changed during export. Keep the profiles stopped and try again.");
      files++; progress();
    } finally { await handle.close(); }
  }
  try {
    options.onPhase?.("snapshotting");
    const metadata = await prepareProfileConfiguration(async (): Promise<ArchiveMetadata> => {
      signal?.throwIfAborted();
      const before = readCatalogFiles(), config = validateSettings(JSON.parse(before.config));
      const ids = options.all ? config.profiles.map(p => p.id) : options.profileIds!;
      if (!ids.length) throw new ProfileTransferError(400, "There are no profiles to export.");
      const selected = ids.map(id => {
        const profile = config.profiles.find(p => p.id === id);
        if (!profile) throw new ProfileTransferError(404, "An export profile is no longer configured. Refresh the profile list.");
        return profile;
      }).sort((a, b) => a.id.localeCompare(b.id));
      // Validate every directory before taking the first lifecycle lock.
      for (const p of selected) {
        checkCatalogDirectory(dir(p.id), true);
        await mkdir(dir(p.id), { mode: 0o700, recursive: true });
      }
      async function withLocks<T>(index: number, action: () => Promise<T>): Promise<T> {
        if (index === selected.length) return action();
        await Promise.resolve();
        return lock(join(dir(selected[index]!.id), "lifecycle.lock"), () => withLocks(index + 1, action));
      }
      return withLocks(0, async () => {
        for (const p of selected) {
          signal?.throwIfAborted();
          try { assertStoppedProfile(p.id); }
          catch { throw new ProfileTransferError(409, "Stop every selected profile cleanly before exporting. Export does not stop browsers."); }
        }
        const engineSha256 = await browserEngineSha256(), values = parseEnv(before.secrets || "");
        const value = (name?: string) => name ? process.env[name] ?? values[name] : undefined;
        const profiles: PortableProfile[] = [];
        await mkdir(join(snapshot, "profiles"), { mode: 0o700 }); count();
        for (const p of selected) {
          const portable: PortableProfile = { id: p.id, ...(p.name ? { name: p.name } : {}), storage: p.storage ?? "checkpoint", typingMode: typingMode(p) };
          if (hasProxy(p)) {
            const url = value(p.proxyEnv);
            if (url) {
              try { validateProxy(url); }
              catch { throw new ProfileTransferError(409, "A selected profile has an invalid proxy. Correct it before exporting."); }
            }
            portable.proxy = url ? { url } : {};
          }
          if (p.expectedIPEnv) {
            const expected = value(p.expectedIPEnv) || "";
            if (expected && (!isIP(expected) || expected.includes("%"))) throw new ProfileTransferError(409, "A selected profile has an invalid expected IP. Correct it before exporting.");
            portable.expectedIp = expected;
          }
          profiles.push(portable);
          const root = dir(p.id), target = join(snapshot, "profiles", p.id);
          await mkdir(target, { mode: 0o700 }); count();
          const native = await optionalInfo(join(root, "browser-data")), marker = await optionalInfo(join(root, "native-profile.json"));
          if (portable.storage === "checkpoint" && (native || marker) || marker && !native)
            throw new ProfileTransferError(409, "A selected profile has inconsistent saved storage. Inspect it before exporting.");
          if (marker) {
            if (!marker.isFile() || marker.isSymbolicLink() || marker.nlink !== 1 || marker.size > 64 * 1024)
              throw new ProfileTransferError(409, "A selected profile has an unsafe native marker.");
            let valid = false;
            try { valid = JSON.parse(await readFile(join(root, "native-profile.json"), "utf8"))?.version === 1; } catch {}
            if (!valid) throw new ProfileTransferError(409, "A selected profile has an invalid native marker. Inspect it before exporting.");
          }
          async function containsCheckpoint(path: string): Promise<boolean> {
            const info = await optionalInfo(path);
            if (!info) return false;
            if (!info.isDirectory() || info.isSymbolicLink()) throw new ProfileTransferError(409, "The checkpoint directory is unsafe. Inspect it before exporting.");
            for (const item of await readdir(path, { withFileTypes: true })) {
              signal?.throwIfAborted();
              if (["storage-state.json", "storage_state.json"].includes(item.name) || item.isDirectory() && await containsCheckpoint(join(path, item.name))) return true;
            }
            return false;
          }
          if (portable.storage === "native" && !marker && await containsCheckpoint(join(root, "storage")))
            throw new ProfileTransferError(409, "A selected native profile contains unmigrated checkpoints. Keep its original storage configuration before exporting.");
          const fingerprint = await optionalInfo(join(root, "fingerprint.json"));
          if (!fingerprint && (native || marker))
            throw new ProfileTransferError(409, "Saved browser data has no fingerprint pin. Restore the original pin before exporting.");
          if (fingerprint) {
            if (!fingerprint.isFile() || fingerprint.isSymbolicLink() || fingerprint.nlink !== 1 || fingerprint.size > 16 * 1024 ** 2)
              throw new ProfileTransferError(409, "A selected profile has an unsafe fingerprint file.");
            let valid = false;
            try {
              const pin = JSON.parse(await readFile(join(root, "fingerprint.json"), "utf8"));
              valid = [1, 2].includes(pin?.version) && pin.engineSha256 === engineSha256 && typeof pin.config?.["navigator.userAgent"] === "string" && !!pin.config["navigator.userAgent"];
            } catch { /* Report a safe error without saved properties. */ }
            if (!valid) throw new ProfileTransferError(409, "A selected profile has an invalid fingerprint or a different Camoufox executable. Correct it before exporting.");
          }
          for (const name of ["fingerprint.json", "cookies", "uploads"]) {
            if (await optionalInfo(join(root, name))) await copy(join(root, name), join(target, name));
          }
          if (portable.storage === "native") {
            if (marker) await copy(join(root, "native-profile.json"), join(target, "native-profile.json"));
            if (native) await copy(join(root, "browser-data"), join(target, "browser-data"), true);
          } else {
            const hash = createHash("sha256").update(p.id).digest("hex").slice(0, 32);
            const storageRoot = join(root, "storage");
            if (await optionalInfo(storageRoot)) checkCatalogDirectory(storageRoot);
            const stateRoot = join(storageRoot, hash);
            if (await optionalInfo(stateRoot)) checkCatalogDirectory(stateRoot);
            const state = join(stateRoot, "storage-state.json");
            if (await optionalInfo(state)) {
              if (!fingerprint) throw new ProfileTransferError(409, "Saved checkpoints have no fingerprint pin. Restore the original pin before exporting.");
              if (!await validCheckpointFile(state, signal)) throw new ProfileTransferError(409, "A selected profile has an invalid storage checkpoint. Inspect it before exporting.");
              await copy(state, join(target, "storage-state.json"));
            }
          }
        }
        // Verify the catalog did not change outside the service's lock protocol.
        const after = readCatalogFiles();
        if (before.config !== after.config || before.secrets !== after.secrets)
          throw new ProfileTransferError(409, "The configuration changed during export. Refresh and try again.");
        return { format: "stelz-profiles", version: 1, createdAt: new Date().toISOString(),
          source: { stelzVersion: STELZ_VERSION, platform: process.platform, arch: process.arch, engineSha256 }, profiles };
      });
    });
    options.onPhase?.("packing");
    const manifest = await writeProfileArchive({ snapshotDirectory: snapshot, metadata, outputFile: temporary, signal, onProgress: options.onProgress });
    signal?.throwIfAborted();
    // A same-directory hard link publishes the complete archive without replacing an existing file.
    try { await link(temporary, options.outputFile); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ProfileTransferError(409, "The output file already exists. Choose a new archive filename.");
      throw error;
    }
    return manifest;
  } finally { await rm(snapshot, { recursive: true, force: true }); await rm(temporary, { force: true }); }
}
