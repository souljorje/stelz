import { randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

/**
 * Replace a file with a private copy that is on disk before it gets its name.
 * `check` runs after the write and before the move, so a caller can stop a write that is no longer current.
 * `move` gives the temporary file its name. The default replaces an existing file.
 * After an error, the temporary file is removed, and the caller gets the first error.
 */
export function replaceFile(path: string, value: string, check: () => void, move: (temp: string) => void = temp => renameSync(temp, path)) {
  const temp = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, value); fsyncSync(fd); closeSync(fd); fd = undefined;
    check(); move(temp);
  } catch (error) {
    // The cleanup must not hide the cause. A failed cleanup leaves a private temporary file.
    if (fd !== undefined) try { closeSync(fd); } catch { /* The first error is the cause. */ }
    try { unlinkSync(temp); } catch { /* The first error is the cause. */ }
    throw error;
  }
}
