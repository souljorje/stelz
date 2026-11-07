import type { ImportSelection, ProfileImportPreview, ProfileImportResult, TransferFingerprintDiagnostic, TransferProgress } from "../profiles/profile-transfer-types.ts";
export type { ImportSelection, ProfileImportPreview, ProfileImportResult };
export type UiTransfer = {
  id: string;
  kind: "import" | "export";
  phase: "awaiting_upload" | "uploading" | "validating" | "snapshotting" | "packing" | "ready" | "importing" | "complete" | "failed" | "cancelled";
  progress: TransferProgress;
  profileIds: string[];
  fingerprintDiagnostics?: TransferFingerprintDiagnostic[];
  preview?: ProfileImportPreview;
  result?: ProfileImportResult;
  error?: string;
  downloadUrl?: string;
};
export type UiTransferCreate = { kind: "import" } | { kind: "export"; profileIds: string[] };
export type UiTransferImport = { revision: string; profiles: ImportSelection[] };
