import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, stat } from "node:fs/promises";
import {
  normalizeFingerprintDiagnostics,
  validateSavedFingerprint,
  type FingerprintDiagnostic,
  type FingerprintValidationOptions,
  type FingerprintValidationResult,
} from "../browser/fingerprint-validation.ts";

const MAX_PIN_BYTES = 16 * 1024 ** 2;

export type SavedFingerprintRead =
  | { readonly status: "present"; readonly pin: unknown; readonly sha256: string }
  | { readonly status: "missing" }
  | { readonly status: "unsafe"; readonly message: string }
  | { readonly status: "unreadable"; readonly message: string }
  | { readonly status: "invalid_json"; readonly message: string };
export type ExistingFingerprintRead = Exclude<SavedFingerprintRead, { readonly status: "missing" }>;

/** Hash the configured executable without changing it. */
export async function engineFileSha256(path: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw Error("The executable is not a regular file.");
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false, emitClose: false, signal })) hash.update(chunk);
    signal?.throwIfAborted();
    const after = await handle.stat(), current = await stat(path);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
        current.dev !== before.dev || current.ino !== before.ino || current.size !== after.size ||
        current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs)
      throw Error("The executable changed while it was read.");
    return hash.digest("hex");
  } finally { await handle.close(); }
}

/** Read a saved pin without following links or accepting an unstable file. */
export async function readSavedFingerprint(path: string): Promise<SavedFingerprintRead> {
  let initial;
  try { initial = await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    return { status: "unreadable", message: "The fingerprint pin cannot be read." };
  }
  if (initial.isSymbolicLink() || !initial.isFile() || initial.nlink !== 1 || initial.size > MAX_PIN_BYTES ||
      process.getuid && initial.uid !== process.getuid())
    return { status: "unsafe", message: "The fingerprint pin is unsafe or exceeds 16 MiB." };

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > MAX_PIN_BYTES ||
        opened.dev !== initial.dev || opened.ino !== initial.ino ||
        process.getuid && opened.uid !== process.getuid())
      return { status: "unsafe", message: "The fingerprint pin changed before it could be read." };
    const buffer = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const bytes = buffer.subarray(0, length);
    const after = await handle.stat();
    const current = await lstat(path);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || bytes.length !== opened.size ||
        current.dev !== opened.dev || current.ino !== opened.ino || current.nlink !== 1 ||
        current.size !== after.size || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs)
      return { status: "unsafe", message: "The fingerprint pin changed while it was read." };
    const text = bytes.toString("utf8");
    if (!Buffer.from(text).equals(bytes)) return { status: "invalid_json", message: "The fingerprint pin is not valid UTF-8 JSON." };
    try { return { status: "present", pin: JSON.parse(text) as unknown, sha256: createHash("sha256").update(bytes).digest("hex") }; }
    catch { return { status: "invalid_json", message: "The fingerprint pin is not valid JSON." }; }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "unsafe", message: "The fingerprint pin changed while it was read." };
    return { status: "unreadable", message: "The fingerprint pin cannot be read." };
  } finally { await handle?.close(); }
}

export function fingerprintReadDiagnostic(read: SavedFingerprintRead): FingerprintDiagnostic | undefined {
  if (read.status === "present" || read.status === "missing") return undefined;
  const code = read.status === "invalid_json" ? "pin.json.parse" : read.status === "unsafe" ? "pin.file.unsafe" : "pin.file.unreadable";
  return { code, path: "pin", severity: "error", message: read.message };
}

/** Use the shared validator and retain one file-boundary diagnostic when reading failed. */
export function checkSavedFingerprint(
  read: ExistingFingerprintRead,
  options: FingerprintValidationOptions = {},
): FingerprintValidationResult {
  const result = validateSavedFingerprint(read.status === "present" ? read.pin : undefined, options);
  const diagnostic = fingerprintReadDiagnostic(read);
  if (!diagnostic) return result;
  const diagnostics = normalizeFingerprintDiagnostics([...result.diagnostics, diagnostic]);
  return Object.freeze({ ...result, diagnostics });
}

export function isEngineHashMismatch(result: FingerprintValidationResult): boolean {
  return result.diagnostics.some(diagnostic => diagnostic.code === "engineSha256.mismatch");
}
