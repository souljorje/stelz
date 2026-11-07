import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { HOME_DIR } from "../profiles/config.ts";
import { exportProfileArchive } from "../profiles/profile-export.ts";
import { readProfileArchive } from "../profiles/profile-archive.ts";
import { commitProfileImport, inspectProfileImport } from "../profiles/profile-import.ts";
import { ProfileTransferError, transferLimits, type ProfileArchiveManifest, type TransferProgress } from "../profiles/profile-transfer-types.ts";
import type { UiTransfer, UiTransferCreate, UiTransferImport } from "./transfer-contracts.ts";
import { processStart } from "../runtime/profile-process.ts";
import { alive } from "../profiles/config.ts";
import { ProfileImportTransactionError } from "../profiles/profile-import-transaction.ts";

type Operations = {
  export: typeof exportProfileArchive;
  read: typeof readProfileArchive;
  inspect: typeof inspectProfileImport;
  import: typeof commitProfileImport;
};
type Job = {
  view: UiTransfer; directory: string; archive: string; staging: string;
  abort: AbortController; running?: Promise<void>; uploading?: Promise<void>; manifest?: ProfileArchiveManifest;
  touched: number; busy: boolean; reserved: boolean; downloads: number;
};
const idleMs = 30 * 60 * 1000;
const terminal = (phase: UiTransfer["phase"]) => ["complete", "failed", "cancelled"].includes(phase);
const validIds = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 &&
  value.every(id => typeof id === "string" && /^[a-z][a-z\d-]{0,63}$/.test(id) && id !== "all") && new Set(value).size === value.length;
function message(error: unknown): string {
  if (error instanceof ProfileTransferError || error instanceof ProfileImportTransactionError) return error.message;
  if ((error as NodeJS.ErrnoException)?.code === "ENOSPC") return "Not enough free disk space. Free space and try again.";
  return "The profile transfer failed. Inspect the service files and try again.";
}

export type ProfileTransferManager = ReturnType<typeof createProfileTransferManager>;
export function createProfileTransferManager(options: {
  directory?: string; operations?: Operations;
  busy?: (delta: number) => void;
  reserve?: (ids: string[]) => void;
  release?: (ids: string[]) => void;
  redact?: (text: string) => string;
} = {}) {
  const root = options.directory ?? join(HOME_DIR, ".profile-transfers");
  const operations: Operations = options.operations ?? { export: exportProfileArchive, read: readProfileArchive, inspect: inspectProfileImport, import: commitProfileImport };
  const jobs = new Map<string, Job>();
  let prepared: Promise<void> | undefined, cleanupTimer: ReturnType<typeof setInterval> | undefined, creating = false;
  const touch = (job: Job) => { job.touched = Date.now(); return structuredClone(job.view); };
  const progress = (job: Job) => (value: TransferProgress) => { job.view.progress = value; job.touched = Date.now(); };
  const release = (job: Job) => { if (job.reserved) { job.reserved = false; options.release?.(job.view.profileIds); } };
  function finishBusy(job: Job) {
    if (job.busy && terminal(job.view.phase) && !job.downloads) { job.busy = false; options.busy?.(-1); }
  }
  function run(job: Job, action: () => Promise<void>) {
    job.running = (async () => {
      try { await action(); }
      catch (error) {
        job.view.phase = job.abort.signal.aborted ? "cancelled" : "failed";
        if (!job.abort.signal.aborted) job.view.error = (options.redact ?? (text => text))(message(error));
      } finally {
        release(job); job.touched = Date.now();
        if (["failed", "cancelled"].includes(job.view.phase)) await rm(job.directory, { recursive: true, force: true }).catch(() => {});
        finishBusy(job);
      }
    })();
  }
  async function safeDirectory(path: string) {
    await mkdir(path, { mode: 0o700, recursive: true });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || process.getuid && info.uid !== process.getuid() || (info.mode & 0o077) !== 0)
      throw new ProfileTransferError(409, "The private transfer directory is unsafe. Inspect it before continuing.");
  }
  async function removeOld() {
    for (const job of jobs.values()) {
      if (Date.now() - job.touched < idleMs || job.downloads) continue;
      if (job.view.phase === "importing") continue;
      job.abort.abort();
      await job.uploading;
      await job.running;
      job.view.phase = "cancelled"; finishBusy(job); release(job);
      await rm(job.directory, { recursive: true, force: true }); jobs.delete(job.view.id);
    }
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f\d-]{36}$/.test(entry.name) || jobs.has(entry.name)) continue;
      const directory = join(root, entry.name), marker = join(directory, ".transfer.json");
      try {
        const info = await lstat(marker), folder = await lstat(directory);
        if (!info.isFile() || info.nlink !== 1 || info.size > 1024 || info.isSymbolicLink() ||
            process.getuid && folder.uid !== process.getuid() || Date.now() - info.mtimeMs < idleMs) continue;
        const value = JSON.parse(await readFile(marker, "utf8"));
        // Batch import copies data to a separate journal-owned stage before publication.
        const actualStart = Number.isSafeInteger(value.pid) && value.pid > 1 ? processStart(value.pid) : undefined;
        const owner = Number.isSafeInteger(value.pid) && value.pid > 1 &&
          (actualStart && typeof value.start === "string" ? actualStart === value.start : alive(value.pid));
        if (!owner && value.version === 1 && value.kind === "stelz-transfer" && value.id === entry.name)
          await rm(directory, { recursive: true, force: true });
      } catch { /* Leave files that cannot be identified as expired transfer staging. */ }
    }
  }
  function prepare() {
    return prepared ??= (async () => {
      if (!options.directory) await safeDirectory(HOME_DIR);
      await safeDirectory(root); await removeOld();
      cleanupTimer = setInterval(() => { void removeOld().catch(() => {}); }, 60_000);
      cleanupTimer.unref();
    })().catch(error => { prepared = undefined; throw error; });
  }
  function get(id: string) {
    const job = jobs.get(id);
    if (!job) throw new ProfileTransferError(404, "This transfer is no longer available. Start a new transfer.");
    return job;
  }
  return {
    list() { return [...jobs.values()].filter(job => job.busy).map(job => structuredClone(job.view)); },
    async create(input: UiTransferCreate) {
      if (!input || typeof input !== "object" || Array.isArray(input) ||
          input.kind === "import" && Object.keys(input).length !== 1 ||
          input.kind === "export" && (Object.keys(input).some(key => !["kind", "profileIds"].includes(key)) || !validIds(input.profileIds)) ||
          !["import", "export"].includes(input.kind)) throw new ProfileTransferError(400, "Select an import or a set of profiles to export.");
      if (creating || [...jobs.values()].some(job => job.busy)) throw new ProfileTransferError(409, "Finish or cancel the current profile transfer first.");
      creating = true;
      try {
        await prepare();
        const id = randomUUID(), directory = join(root, id), profileIds = input.kind === "export" ? input.profileIds : [];
        if (input.kind === "export") options.reserve?.(profileIds);
        const job: Job = { directory, archive: join(directory, "profiles.zip"), staging: join(directory, "extracted"), abort: new AbortController(),
          touched: Date.now(), busy: true, reserved: input.kind === "export", downloads: 0,
          view: { id, kind: input.kind, phase: input.kind === "import" ? "awaiting_upload" : "snapshotting", progress: { bytes: 0, files: 0 }, profileIds } };
        try {
          await mkdir(directory, { mode: 0o700 });
          await writeFile(join(directory, ".transfer.json"), JSON.stringify({ kind: "stelz-transfer", version: 1, id, pid: process.pid, start: processStart(process.pid) }), { mode: 0o600, flag: "wx" });
        } catch (error) { release(job); await rm(directory, { recursive: true, force: true }); throw error; }
        jobs.set(id, job); options.busy?.(1);
        if (input.kind === "export") run(job, async () => {
          const { fingerprintDiagnostics } = await operations.export({ profileIds, outputFile: job.archive, workDirectory: directory, signal: job.abort.signal,
            onProgress: progress(job), onPhase: phase => { job.view.phase = phase; if (phase === "packing") release(job); } });
          job.abort.signal.throwIfAborted();
          if (fingerprintDiagnostics) job.view.fingerprintDiagnostics = fingerprintDiagnostics;
          job.view.phase = "ready"; job.view.downloadUrl = `/api/profile-transfers/${id}/download`;
        });
        return touch(job);
      } finally { creating = false; }
    },
    status(id: string) { return touch(get(id)); },
    async upload(id: string, request: Request) {
      const job = get(id);
      if (job.view.kind !== "import" || job.view.phase !== "awaiting_upload") throw new ProfileTransferError(409, "This transfer is not waiting for an archive.");
      if (!["application/zip", "application/octet-stream", "application/x-zip-compressed"].includes(request.headers.get("content-type")?.split(";")[0]?.trim() || ""))
        throw new ProfileTransferError(415, "Choose a ZIP profile archive.");
      const limit = transferLimits().archiveBytes, declared = Number(request.headers.get("content-length"));
      if (declared > limit) throw new ProfileTransferError(413, "The archive exceeds the transfer size limit.");
      if (!request.body) throw new ProfileTransferError(400, "Choose a ZIP profile archive.");
      job.view.phase = "uploading";
      let handle: Awaited<ReturnType<typeof open>> | undefined, uploaded!: () => void;
      job.uploading = new Promise<void>(resolve => { uploaded = resolve; });
      const reader = request.body.getReader();
      const cancelRead = () => { void reader.cancel().catch(() => {}); };
      job.abort.signal.addEventListener("abort", cancelRead, { once: true });
      try {
        handle = await open(job.archive, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        for (;;) {
          job.abort.signal.throwIfAborted();
          const { done, value } = await reader.read();
          if (done) break;
          job.view.progress.bytes += value.byteLength;
          if (job.view.progress.bytes > limit) throw new ProfileTransferError(413, "The archive exceeds the transfer size limit.");
          await handle.writeFile(value);
          job.touched = Date.now();
        }
        job.abort.signal.throwIfAborted();
        if (!job.view.progress.bytes) throw new ProfileTransferError(400, "The archive is empty.");
        await handle.sync();
      } catch (error) {
        await reader.cancel().catch(() => {});
        job.view.phase = job.abort.signal.aborted ? "cancelled" : "failed";
        job.view.error = message(error);
        throw error;
      } finally {
        job.abort.signal.removeEventListener("abort", cancelRead);
        reader.releaseLock(); await handle?.close(); uploaded();
        if (terminal(job.view.phase)) { await rm(job.directory, { recursive: true, force: true }); finishBusy(job); }
      }
      job.view.phase = "validating"; job.view.progress = { bytes: 0, files: 0 };
      run(job, async () => {
        job.manifest = await operations.read({ archiveFile: job.archive, stagingDirectory: job.staging, signal: job.abort.signal, onProgress: progress(job) });
        job.view.preview = await operations.inspect(job.manifest, job.staging);
        job.abort.signal.throwIfAborted(); job.view.phase = "ready";
      });
      return touch(job);
    },
    async commit(id: string, input: UiTransferImport) {
      const job = get(id);
      if (job.view.kind !== "import" || job.view.phase !== "ready" || !job.manifest) throw new ProfileTransferError(409, "Wait for the archive preview before importing.");
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["revision", "profiles"].includes(key)) ||
          typeof input.revision !== "string" || !/^[a-f\d]{64}$/.test(input.revision) || !Array.isArray(input.profiles) || !input.profiles.length ||
          input.profiles.some(p => !p || typeof p !== "object" || Array.isArray(p) || Object.keys(p).some(key => !["sourceId", "id", "name"].includes(key)) ||
            !validIds([p.sourceId]) || !validIds([p.id]) || p.name !== undefined && (typeof p.name !== "string" || p.name.length > 80)))
        throw new ProfileTransferError(400, "Select profiles from the current archive preview.");
      job.view.phase = "importing"; job.view.profileIds = input.profiles.map(p => p.id); job.view.progress = { bytes: 0, files: 0 };
      run(job, async () => {
        job.view.result = await operations.import({ manifest: job.manifest!, stagingDirectory: job.staging, revision: input.revision, profiles: input.profiles,
          signal: job.abort.signal, onProgress: progress(job) });
        await rm(job.directory, { recursive: true, force: true }).catch(() => {});
        job.view.phase = "complete";
      });
      return touch(job);
    },
    async cancel(id: string) {
      const job = get(id);
      if (job.view.phase === "importing") throw new ProfileTransferError(409, "The import is being committed. Wait for its result.");
      job.abort.abort();
      await job.uploading;
      await job.running;
      job.view.phase = "cancelled"; delete job.view.downloadUrl; release(job); finishBusy(job);
      await rm(job.directory, { recursive: true, force: true });
      return touch(job);
    },
    async download(id: string): Promise<Response> {
      const job = get(id);
      if (job.view.kind !== "export" || !["ready", "complete"].includes(job.view.phase) || job.abort.signal.aborted)
        throw new ProfileTransferError(409, "The archive is not ready for download.");
      const handle = await open(job.archive, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1) { await handle.close(); throw new ProfileTransferError(409, "The archive is unavailable."); }
      job.downloads++;
      if (!job.busy) { job.busy = true; options.busy?.(1); }
      const stream = handle.createReadStream();
      stream.once("close", () => { job.downloads--; job.view.phase = "complete"; finishBusy(job); job.touched = Date.now(); });
      return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array<ArrayBuffer>>, { headers: {
        "Content-Type": "application/zip", "Content-Length": String(info.size),
        "Content-Disposition": `attachment; filename="profiles-${new Date().toISOString().slice(0, 10)}.stelz-profiles.zip"`,
      } });
    },
    async dispose() {
      if (cleanupTimer) clearInterval(cleanupTimer);
      for (const job of jobs.values()) {
        if (job.view.phase === "importing") { await job.running; continue; }
        job.abort.abort(); await job.uploading; await job.running; release(job);
        job.view.phase = "cancelled"; finishBusy(job);
        await rm(job.directory, { recursive: true, force: true });
      }
      jobs.clear();
    },
  };
}
