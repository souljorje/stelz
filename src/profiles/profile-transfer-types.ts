import type { TypingMode } from "../browser/typing.ts";

// This data is private. Only sanitized previews may cross the UI API.
export type PortableProfile = {
  id: string;
  name?: string;
  storage: "native" | "checkpoint";
  typingMode?: TypingMode;
  proxy?: { url?: string };
  expectedIp?: string;
};
export type ArchiveFile = { path: string; size: number; sha256: string };
export type ProfileArchiveManifest = {
  format: "stelz-profiles";
  version: 1;
  createdAt: string;
  source: { stelzVersion: string; platform: string; arch: string; engineSha256: string };
  profiles: PortableProfile[];
  directories: string[];
  files: ArchiveFile[];
};
export type ArchiveMetadata = Omit<ProfileArchiveManifest, "files" | "directories">;
export type TransferProgress = { bytes: number; files: number; totalBytes?: number };
export type TransferOptions = { signal?: AbortSignal; onProgress?: (progress: TransferProgress) => void };
export type TransferLimits = { archiveBytes: number; expandedBytes: number; entries: number; manifestBytes: number };
export function transferLimits(): TransferLimits {
  const limit = (name: string, fallback: number) => {
    const value = process.env[name];
    if (value === undefined) return fallback;
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
      throw new ProfileTransferError(400, `${name} must be a positive safe integer.`);
    return Number(value);
  };
  return {
    archiveBytes: limit("STELZ_TRANSFER_ARCHIVE_BYTES", 10 * 1024 ** 3),
    expandedBytes: limit("STELZ_TRANSFER_EXPANDED_BYTES", 10 * 1024 ** 3),
    entries: limit("STELZ_TRANSFER_ENTRIES", 100_000),
    manifestBytes: limit("STELZ_TRANSFER_MANIFEST_BYTES", 64 * 1024 ** 2),
  };
}
export class ProfileTransferError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 413 | 415 | 500, message: string) {
    super(message); this.name = "ProfileTransferError";
  }
}
export type ImportSelection = { sourceId: string; id: string; name?: string };
export type ProfileImportPreview = {
  revision: string;
  source: ProfileArchiveManifest["source"];
  compatible: boolean;
  issues: string[];
  profiles: {
    sourceId: string; id: string; name: string; storage: "native" | "checkpoint";
    proxyDisplay: string | null; proxyUnavailable: boolean; issues: string[];
  }[];
};
export type ProfileImportResult = { profiles: { sourceId: string; id: string; name: string }[] };
