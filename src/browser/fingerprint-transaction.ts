import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateSavedFingerprint } from "./fingerprint-validation.ts";

export type FingerprintOwner = { profileId: string; attemptId: string; browserInstanceId: string; configurationHash: string; serverPid: number };
export type FingerprintJournal = { version: 1; id: string; owner: FingerprintOwner; before: string | null; candidate: string; sha256: string;
  publication?: { name: string; dev: number; ino: number } };

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const journalPath = (directory: string) => join(directory, "fingerprint-transaction.json");
const pinPath = (directory: string) => join(directory, "fingerprint.json");

function inspectFile(path: string, links = 1, requirePrivate = false): { text: string; dev: number; ino: number; nlink: number } | null {
  let fd: number | undefined;
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) throw Error("Unsafe fingerprint transaction file.");
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink > links || opened.nlink < 1 || info.dev !== opened.dev || info.ino !== opened.ino ||
        process.getuid && opened.uid !== process.getuid() || requirePrivate && (opened.mode & 0o7777) !== 0o600)
      throw Error("Unsafe fingerprint transaction file.");
    const bytes = readFileSync(fd), text = bytes.toString("utf8");
    if (!Buffer.from(text).equals(bytes)) throw Error("Invalid fingerprint transaction encoding.");
    return { text, dev: opened.dev, ino: opened.ino, nlink: opened.nlink };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}
function readPrivate(path: string, requirePrivate = false): string | null { return inspectFile(path, 1, requirePrivate)?.text ?? null; }
function syncDirectory(directory: string) {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    try { fsyncSync(fd); }
    catch (error) { if (!["EINVAL", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code || "")) throw error; }
  } finally { closeSync(fd); }
}
function temporary(directory: string, value: string): string {
  const file = join(directory, `.fingerprint-${randomUUID()}.tmp`);
  const fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
  return file;
}
function removeTemporary(file: string) {
  try { unlinkSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
function sameOwner(left: FingerprintOwner, right: FingerprintOwner) {
  return left.profileId === right.profileId && left.attemptId === right.attemptId &&
    left.browserInstanceId === right.browserInstanceId && left.configurationHash === right.configurationHash && left.serverPid === right.serverPid;
}
function assertReservation(directory: string, owner: FingerprintOwner) {
  const text = readPrivate(join(directory, "running.json"));
  let running: Record<string, unknown> | null = null;
  try { running = text === null ? null : JSON.parse(text) as Record<string, unknown>; } catch {}
  if (!running || running.instanceId !== owner.attemptId || running.serverPid !== owner.serverPid ||
      running.configurationHash !== owner.configurationHash) throw Error("The fingerprint startup reservation changed.");
}
export function readFingerprintJournal(directory: string): FingerprintJournal | undefined {
  const text = readPrivate(journalPath(directory), true);
  if (text === null) return;
  const value = JSON.parse(text) as FingerprintJournal;
  if (value?.version !== 1 || typeof value.id !== "string" || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(value.id) || !value.owner ||
      typeof value.owner.profileId !== "string" || typeof value.owner.attemptId !== "string" ||
      typeof value.owner.browserInstanceId !== "string" || typeof value.owner.configurationHash !== "string" ||
      !Number.isSafeInteger(value.owner.serverPid) || value.owner.serverPid <= 0 ||
      value.before !== null && typeof value.before !== "string" || typeof value.candidate !== "string" ||
      value.sha256 !== digest(value.candidate) || value.publication !== undefined &&
      (value.publication.name !== `.fingerprint-${value.id}.candidate` || !Number.isSafeInteger(value.publication.dev) ||
       !Number.isSafeInteger(value.publication.ino))) throw Error("Fingerprint transaction requires inspection.");
  return value;
}

function reconcilePublication(directory: string, journal: FingerprintJournal) {
  const pin = inspectFile(pinPath(directory), 2);
  if (!pin || pin.nlink === 1) return;
  const owned = journal.publication;
  if (!owned) throw Error("Fingerprint publication has an unknown hard link.");
  const file = join(directory, owned.name), staged = inspectFile(file, 2, true);
  if (!staged || pin.nlink !== 2 || staged.nlink !== 2 || pin.dev !== owned.dev || pin.ino !== owned.ino ||
      staged.dev !== owned.dev || staged.ino !== owned.ino || pin.text !== journal.candidate || staged.text !== journal.candidate)
    throw Error("Fingerprint publication ownership cannot be verified.");
  unlinkSync(file);
  syncDirectory(directory);
}

// The current service reservation grants ownership. An earlier journal is
// adopted only after the lifecycle has made a new explicit reservation.
export function stageFingerprint(directory: string, owner: FingerprintOwner, proposed: unknown, engineSha256: string): FingerprintJournal {
  assertReservation(directory, owner);
  const previous = readFingerprintJournal(directory);
  const existing = inspectFile(pinPath(directory), previous ? 2 : 1);
  if (existing) {
    let saved: unknown;
    try { saved = JSON.parse(existing.text); } catch { throw Error("Fingerprint pin is corrupt; inspection is required."); }
    const validation = validateSavedFingerprint(saved, { expectedEngineSha256: engineSha256 });
    if (!validation.staticValid) throw Error(`Fingerprint pin is invalid: ${validation.diagnostics.filter(d => d.severity === "error").map(d => d.code).join(", ")}`);
  }
  if (previous) reconcilePublication(directory, previous);
  const current = readPrivate(pinPath(directory));
  if (previous && current !== previous.before && current !== previous.candidate)
    throw Error("Fingerprint changed during an unfinished transaction; inspection is required.");
  const candidate = previous?.candidate ?? current ?? JSON.stringify(typeof proposed === "function" ? proposed() : proposed, null, 2);
  let parsed: unknown;
  try { parsed = JSON.parse(candidate); } catch { throw Error("Fingerprint pin is corrupt; inspection is required."); }
  const validation = validateSavedFingerprint(parsed, { expectedEngineSha256: engineSha256 });
  if (!validation.staticValid) throw Error(`Fingerprint pin is invalid: ${validation.diagnostics.filter(d => d.severity === "error").map(d => d.code).join(", ")}`);
  const id = previous?.id ?? randomUUID();
  let publication = previous?.publication;
  if (!previous && current === null) {
    const name = `.fingerprint-${id}.candidate`, file = join(directory, name);
    const fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      writeFileSync(fd, candidate); fsyncSync(fd);
      const info = fstatSync(fd);
      publication = { name, dev: info.dev, ino: info.ino };
    } finally { closeSync(fd); }
    syncDirectory(directory);
  }
  const journal: FingerprintJournal = { version: 1, id, owner,
    before: previous ? previous.before : current, candidate, sha256: digest(candidate), ...(publication ? { publication } : {}) };
  const oldJournal = previous ? JSON.stringify(previous) : null;
  const temp = temporary(directory, JSON.stringify(journal));
  try {
    assertReservation(directory, owner);
    if (readPrivate(pinPath(directory)) !== current || readPrivate(journalPath(directory), true) !== oldJournal)
      throw Error("Fingerprint transaction changed while staging.");
    // Durable journal publication selects the identity; pre-journal scratch never launches.
    renameSync(temp, journalPath(directory));
    syncDirectory(directory);
  } finally { removeTemporary(temp); }
  return journal;
}

// The caller holds admission.lock and has rechecked the reservation and owner.
export function commitFingerprint(directory: string, owner: FingerprintOwner, expectedSha256: string): FingerprintJournal {
  assertReservation(directory, owner);
  const journal = readFingerprintJournal(directory);
  if (!journal || !sameOwner(journal.owner, owner) || journal.sha256 !== expectedSha256)
    throw Error("Fingerprint transaction owner changed before commit.");
  reconcilePublication(directory, journal);
  const current = readPrivate(pinPath(directory));
  if (current !== journal.before && current !== journal.candidate) throw Error("Fingerprint changed before commit.");
  if (current === null) {
    const publication = journal.publication;
    if (!publication) throw Error("The staged fingerprint publication is missing.");
    const file = join(directory, publication.name), staged = inspectFile(file, 1, true);
    if (!staged || staged.dev !== publication.dev || staged.ino !== publication.ino || staged.text !== journal.candidate)
      throw Error("The staged fingerprint publication changed.");
    assertReservation(directory, owner);
    // link is an atomic, exclusive publication; the journal identifies both links.
    linkSync(file, pinPath(directory));
    syncDirectory(directory);
    reconcilePublication(directory, journal);
  } else {
    const fd = openSync(pinPath(directory), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
    syncDirectory(directory);
  }
  if (readPrivate(pinPath(directory)) !== journal.candidate) throw Error("Fingerprint commit could not be verified.");
  return journal;
}

export function writeInitialized(directory: string, value: { instanceId: string; browserInstanceId: string; configurationHash: string; fingerprintSha256: string }) {
  const temp = temporary(directory, JSON.stringify(value));
  try { renameSync(temp, join(directory, "initialized.json")); syncDirectory(directory); }
  finally { removeTemporary(temp); }
}

export function initializedFingerprint(directory: string, owner: FingerprintOwner, sha256: string): boolean {
  try {
    const value = JSON.parse(readPrivate(join(directory, "initialized.json")) || "null") as Record<string, unknown> | null;
    const running = JSON.parse(readPrivate(join(directory, "running.json")) || "null") as Record<string, unknown> | null;
    const journal = readFingerprintJournal(directory);
    return !!value && value.instanceId === owner.attemptId && value.browserInstanceId === owner.browserInstanceId &&
      value.configurationHash === owner.configurationHash && value.fingerprintSha256 === sha256 &&
      !!running && running.instanceId === owner.attemptId && running.serverPid === owner.serverPid && running.configurationHash === owner.configurationHash &&
      !!journal && sameOwner(journal.owner, owner) && journal.sha256 === sha256 && readPrivate(pinPath(directory)) === journal.candidate;
  } catch { return false; }
}
