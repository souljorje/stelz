import { lstatSync } from "node:fs";
import { join } from "node:path";

// Keep existing browser paths and lock inodes in place during an upgrade.
export function existingProfilePath(home: string, current: string, legacy: string): string {
  const present = (path: string) => {
    try { lstatSync(path); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  };
  const path = join(home, current), previous = join(home, legacy);
  if (present(path) && present(previous))
    throw Error(`Conflicting profile state: both ${current} and ${legacy} exist. Inspect them before continuing.`);
  return present(previous) ? previous : path;
}

// Normalize records from services that were started before the terminology change.
export function normalizeProfileId(value: Record<string, unknown>): Record<string, unknown> {
  const { identityId, ...record } = value;
  if (identityId === undefined) return record;
  if (record.profileId !== undefined && record.profileId !== identityId)
    throw Error("The saved profile identifiers conflict. Inspect the service before continuing.");
  return { ...record, profileId: identityId };
}
