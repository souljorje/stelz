import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { CONFIG_FILE, HOME_DIR, STATE } from "../profiles/config.ts";
import { exportProfileArchive } from "../profiles/profile-export.ts";
import { readProfileArchive } from "../profiles/profile-archive.ts";
import { commitProfileImport, inspectProfileImport } from "../profiles/profile-import.ts";
import { ProfileTransferError, type TransferFingerprintDiagnostic } from "../profiles/profile-transfer-types.ts";
import { ProfileCatalogError, ProfileConfigurationError } from "../profiles/profile-configuration.ts";
import { checkCatalogDirectory } from "../profiles/profile-catalog.ts";
import { processStart } from "../runtime/profile-process.ts";
import { ProfileImportTransactionError } from "../profiles/profile-import-transaction.ts";

export const transferUsage = [
  "stelz profile export ID... --output FILE [--json]",
  "stelz profile export --all --output FILE [--json]",
  "stelz profile import FILE [--profile SOURCE_ID]... [--rename SOURCE_ID=NEW_ID]... [--json]",
].join("\n");
const validId = (id: string) => /^[a-z][a-z\d-]{0,63}$/.test(id) && id !== "all";
function invalid(): never { throw new ProfileTransferError(400, `Use:\n${transferUsage}`); }
function parseExport(args: string[]) {
  let all = false, output: string | undefined, json = false;
  const ids: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--all" && !all) all = true;
    else if (arg === "--json" && !json) json = true;
    else if (arg === "--output" && output === undefined && args[index + 1] && !args[index + 1]!.startsWith("--")) output = args[++index];
    else if (!arg.startsWith("-") && validId(arg)) ids.push(arg);
    else invalid();
  }
  if (!output || all === !!ids.length || new Set(ids).size !== ids.length) invalid();
  return { all, ids, output: resolve(output) };
}
function parseImport(args: string[]) {
  const file = args[0];
  if (!file || file.startsWith("-")) invalid();
  const ids: string[] = [], renames = new Map<string, string>();
  let json = false;
  for (let index = 1; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--json" && !json) { json = true; continue; }
    const value = args[++index];
    if (!value || value.startsWith("--")) invalid();
    if (arg === "--profile" && validId(value) && !ids.includes(value)) ids.push(value);
    else if (arg === "--rename") {
      const parts = value.split("=");
      if (parts.length !== 2 || !parts.every(validId) || renames.has(parts[0]!)) invalid();
      renames.set(parts[0]!, parts[1]!);
    } else invalid();
  }
  return { file: resolve(file), ids, renames };
}

function fingerprintNotice(diagnostics?: readonly TransferFingerprintDiagnostic[]) {
  if (!diagnostics?.length) return;
  const invalid: string[] = [], uninitialized: string[] = [], notVerified: string[] = [], runtimeFailed: string[] = [];
  for (const { sourceId, fingerprint } of diagnostics) {
    if (fingerprint.status === "uninitialized") { uninitialized.push(sourceId); continue; }
    if (!fingerprint.validation.staticValid) invalid.push(sourceId);
    if (fingerprint.validation.runtime === "NOT_RUN") notVerified.push(sourceId);
    if (fingerprint.validation.runtime === "FAIL") runtimeFailed.push(sourceId);
  }
  const describe = (ids: string[]) => ids.length <= 5 ? ids.join(", ") : `${ids.slice(0, 5).join(", ")} (+${ids.length - 5} more)`;
  const parts = [
    ...(invalid.length ? [`invalid: ${describe(invalid)}`] : []),
    ...(uninitialized.length ? [`uninitialized: ${describe(uninitialized)}`] : []),
    ...(notVerified.length ? [`runtime not verified: ${describe(notVerified)}`] : []),
    ...(runtimeFailed.length ? [`runtime failed: ${describe(runtimeFailed)}`] : []),
  ];
  if (parts.length) console.error(`Fingerprint diagnostics (source IDs): ${parts.join("; ")}.`);
}

export async function runProfileTransfer(args: string[]) {
  const json = args.includes("--json");
  let work: string | undefined;
  let rejectedDiagnostics: TransferFingerprintDiagnostic[] | undefined;
  const abort = new AbortController();
  const cancel = () => { abort.abort(); };
  try {
    if (args.length === 2 && args[1] === "--help") { console.log(transferUsage); return; }
    const input = args[0] === "export" ? { kind: "export" as const, ...parseExport(args.slice(1)) }
      : args[0] === "import" ? { kind: "import" as const, ...parseImport(args.slice(1)) } : invalid();
    if (!existsSync(CONFIG_FILE) || !existsSync(STATE)) throw new ProfileTransferError(409, "Run stelz setup first, using the same STELZ_HOME.");
    checkCatalogDirectory(HOME_DIR); checkCatalogDirectory(STATE);
    const stagingRoot = join(HOME_DIR, ".profile-transfers");
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    const info = await lstat(stagingRoot);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) || process.getuid && info.uid !== process.getuid())
      throw new ProfileTransferError(409, "The private transfer directory is unsafe. Inspect it before continuing.");
    const transferId = randomUUID();
    work = join(stagingRoot, transferId);
    await mkdir(work, { mode: 0o700 });
    await writeFile(join(work, ".transfer.json"), JSON.stringify({ kind: "stelz-transfer", version: 1, id: transferId, pid: process.pid, start: processStart(process.pid) }), { mode: 0o600, flag: "wx" });
    process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
    if (input.kind === "export") {
      try { await lstat(input.output); throw new ProfileTransferError(409, "The output file already exists. Choose a new archive filename."); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const manifest = await exportProfileArchive({ profileIds: input.all ? undefined : input.ids, all: input.all,
        outputFile: input.output, workDirectory: work, signal: abort.signal });
      console.log(json ? JSON.stringify({ ok: true, archive: input.output, profiles: manifest.profiles.map(p => ({ id: p.id, name: p.name ?? p.id })),
        fingerprintDiagnostics: manifest.fingerprintDiagnostics ?? [] })
        : `Exported ${manifest.profiles.length} profile${manifest.profiles.length === 1 ? "" : "s"} to ${input.output}.`);
      if (!json) {
        console.error("The archive includes saved logins and available proxy credentials. Keep it private.");
        fingerprintNotice(manifest.fingerprintDiagnostics);
      }
    } else {
      const stagingDirectory = join(work, "extracted");
      const manifest = await readProfileArchive({ archiveFile: input.file, stagingDirectory, signal: abort.signal });
      const preview = await inspectProfileImport(manifest, stagingDirectory);
      const selected = input.ids.length ? input.ids : preview.profiles.map(p => p.sourceId);
      const selectedIds = new Set(selected);
      const previewDiagnostics = preview.profiles.flatMap(p => selectedIds.has(p.sourceId) && p.fingerprint
        ? [{ sourceId: p.sourceId, fingerprint: p.fingerprint }] : []);
      if (!preview.compatible) {
        rejectedDiagnostics = previewDiagnostics;
        throw new ProfileTransferError(409, preview.issues.join(" ") || "The archive requires the same operating system, architecture, and Camoufox executable.");
      }
      if (selected.some(id => !preview.profiles.some(p => p.sourceId === id)) || [...input.renames.keys()].some(id => !selected.includes(id)))
        throw new ProfileTransferError(400, "Select and rename only profiles present in this archive.");
      const profiles = selected.map(sourceId => {
        const p = preview.profiles.find(p => p.sourceId === sourceId)!;
        if (p.issues.length) {
          rejectedDiagnostics = previewDiagnostics;
          throw new ProfileTransferError(409, p.issues.join(" "));
        }
        return { sourceId, id: input.renames.get(sourceId) ?? p.id, name: p.name };
      });
      const result = await commitProfileImport({ manifest, stagingDirectory, profiles, revision: preview.revision, signal: abort.signal });
      console.log(json ? JSON.stringify({ ok: true, ...result, fingerprintDiagnostics: result.fingerprintDiagnostics ?? [] })
        : result.profiles.map(p => `Imported ${p.sourceId} as ${p.id}.`).join("\n"));
      if (!json) {
        if (preview.profiles.some(p => selectedIds.has(p.sourceId) && p.proxyUnavailable))
          console.error("Some imported profiles need proxy credentials before they can start.");
        fingerprintNotice(result.fingerprintDiagnostics);
      }
    }
  } catch (cause) {
    const known = cause instanceof ProfileTransferError || cause instanceof ProfileCatalogError || cause instanceof ProfileConfigurationError || cause instanceof ProfileImportTransactionError;
    const status = known ? cause.status : 500;
    const message = abort.signal.aborted ? "The profile transfer was cancelled."
      : known ? cause.message : (cause as NodeJS.ErrnoException).code === "ENOSPC" ? "Not enough free disk space. Free space and try again."
        : "The profile transfer failed. Run stelz doctor and inspect the service files.";
    console.error(json ? JSON.stringify({ ok: false, error: { code: abort.signal.aborted ? "cancelled" : status === 400 ? "invalid_input" : status === 409 ? "conflict" : status === 413 ? "too_large" : "transfer_failed", message },
      ...(rejectedDiagnostics?.length ? { fingerprintDiagnostics: rejectedDiagnostics } : {}) }) : message);
    if (!json) fingerprintNotice(rejectedDiagnostics);
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", cancel); process.off("SIGTERM", cancel);
    if (work) await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
