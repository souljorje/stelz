import { useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { UiSnapshot } from "../../src/api/contracts.ts";
import type { ProfileImportPreview, UiTransfer, UiTransferImport } from "../../src/api/transfer-contracts.ts";
import { Modal, Notice } from "./components";
import { proxyDisplay, redact } from "./model.ts";
import { ProfileMark } from "./ProfileMark";
import type { TransferState } from "./use-transfer.ts";

const phaseLabels: Record<UiTransfer["phase"], string> = {
  awaiting_upload: "Preparing upload…", uploading: "Uploading ZIP…", validating: "Checking archive…",
  snapshotting: "Copying profiles…", packing: "Creating ZIP…", ready: "ZIP ready",
  importing: "Importing profiles…", complete: "Complete", failed: "Transfer failed", cancelled: "Transfer cancelled",
};

function bytes(value: number): string {
  if (value < 1024) return `${value.toLocaleString()} B`;
  const unit = Math.min(3, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${["B", "KB", "MB", "GB"][unit]}`;
}

function TransferErrors({ state }: { state: TransferState }) {
  const error = state.error || state.transfer?.error || state.recoveryError;
  return <>
    {error && <Notice kind="error" alert>{redact(error)}</Notice>}
    {state.statusError && <Notice kind="warning"><span>{state.statusError}</span><button type="button" className="text-button" disabled={state.closing} onClick={state.refreshStatus}>Retry status</button></Notice>}
  </>;
}

export function ProfileTransfer({ state, snapshot, connected, onReconnect }: { state: TransferState; snapshot: UiSnapshot; connected: boolean; onReconnect: () => void }) {
  const transfer = state.transfer;
  const archiveInput = useRef<HTMLInputElement>(null);
  const title = state.kind === "import" ? "Import profiles" : "Export profiles";
  const preview = transfer?.kind === "import" && transfer.phase === "ready" ? transfer.preview : undefined;
  const canRetry = !state.operation && !state.atomic && !state.needsFile && (!transfer && !!state.error || transfer?.phase === "failed" || transfer?.phase === "cancelled" || state.kind === "import" && !!state.error && transfer?.phase !== "ready" && transfer?.phase !== "complete");
  const finished = transfer?.phase === "complete";
  const label = state.closing ? "Cleaning up…" : state.atomic ? "Importing profiles…" : state.operation === "creating" ? "Preparing transfer…" : state.operation === "uploading" ? "Uploading ZIP…" : state.needsFile ? "Choose a ZIP archive." : transfer ? phaseLabels[transfer.phase] : "Transfer unavailable";
  const download = transfer?.kind === "export" && ["ready", "complete"].includes(transfer.phase) ? transfer.downloadUrl : undefined;
  const downloadUrl = transfer && download === `/api/profile-transfers/${encodeURIComponent(transfer.id)}/download` ? download : undefined;
  const progress = transfer?.progress;
  const importedCount = transfer?.result?.profiles.length ?? 0;

  return <Modal title={title} className="transfer-modal" busy={state.atomic || state.closing} onClose={() => void state.dismiss()}>
    {state.kind === "import" && <input ref={archiveInput} type="file" accept=".zip,application/zip" hidden aria-label="Import profile ZIP" onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) state.chooseFile(file); }} />}
    <div className="modal-body transfer-intro"><p className="field-help">Includes saved logins and proxy credentials.</p>{state.recovered && <Notice>Resumed unfinished transfer.</Notice>}{!connected && <Notice kind="warning"><span>Reconnect to continue.</span><button type="button" className="text-button" onClick={onReconnect}>Retry connection</button></Notice>}</div>
    {preview ? <ImportPreview key={`${transfer!.id}:${preview.revision}`} preview={preview} snapshot={snapshot} disabled={!connected || !!state.operation || state.closing || state.atomic} state={state} onCommit={state.commit} onReload={() => { if (state.fileName) void state.retry(); else archiveInput.current?.click(); }} /> : <>
      <div className="modal-body transfer-status">
        {state.fileName && <p className="transfer-filename" title={state.fileName}>{redact(state.fileName)}</p>}
        <p className="transfer-phase" role="status">{finished && transfer?.kind === "import" ? `Imported ${importedCount} ${importedCount === 1 ? "profile" : "profiles"}.` : label}</p>
        {!finished && !canRetry && !state.needsFile && !downloadUrl && <progress className="transfer-progress" aria-label={label} max={progress?.totalBytes || 1} value={progress?.totalBytes ? Math.min(progress.bytes, progress.totalBytes) : undefined} />}
        {progress && (progress.files > 0 || progress.bytes > 0) && <p className="field-help transfer-counts">{progress.files.toLocaleString()} {progress.files === 1 ? "file" : "files"} · {bytes(progress.bytes)}{progress.totalBytes ? ` / ${bytes(progress.totalBytes)}` : ""}</p>}
        {downloadUrl && <p className="field-help">{transfer!.profileIds.length} {transfer!.profileIds.length === 1 ? "profile" : "profiles"}{finished ? " · Download started" : " · Download the ZIP to save it"}</p>}
        {finished && transfer?.kind === "import" && <ul className="transfer-results">{transfer.result?.profiles.map(profile => <li key={profile.id}><ProfileMark id={profile.id} /><span>{profile.name}<span className="cell-secondary mono">{profile.sourceId === profile.id ? profile.id : `${profile.sourceId} → ${profile.id}`}</span></span></li>)}</ul>}
        <TransferErrors state={state} />
      </div>
      <div className="modal-actions">
        <button type="button" className="button" autoFocus={finished} disabled={state.atomic || state.closing} onClick={() => void state.dismiss()}>{state.closing ? "Cleaning up…" : finished || canRetry ? "Close" : "Cancel"}</button>
        {canRetry && <button type="button" className="button button-primary" disabled={!connected || state.closing} onClick={() => void state.retry()}>Retry</button>}
        {state.needsFile && <button type="button" className="button button-primary" disabled={!connected || !!state.operation || state.closing} onClick={() => archiveInput.current?.click()}>Choose ZIP</button>}
        {downloadUrl && <a className="button button-primary" href={downloadUrl} download aria-disabled={state.closing || undefined} tabIndex={state.closing ? -1 : undefined} onClick={event => { if (state.closing) event.preventDefault(); }}>Download ZIP</a>}
      </div>
    </>}
  </Modal>;
}

type Draft = { sourceId: string; selected: boolean; id: string; name: string };
type DraftIssue = { field: "id" | "name"; message: string };

function ImportPreview({ preview, snapshot, disabled, state, onCommit, onReload }: {
  preview: ProfileImportPreview; snapshot: UiSnapshot; disabled: boolean; state: TransferState;
  onCommit: (input: UiTransferImport) => Promise<void>; onReload: () => void;
}) {
  const prefix = useId();
  const [drafts, setDrafts] = useState<Draft[]>(() => preview.profiles.map(profile => ({ sourceId: profile.sourceId, id: profile.id, name: profile.name, selected: true })));
  const selected = drafts.filter(draft => draft.selected);
  const existingIds = new Set(snapshot.profiles.map(profile => profile.id));
  const destinationCounts = new Map<string, number>();
  for (const draft of selected) destinationCounts.set(draft.id.trim(), (destinationCounts.get(draft.id.trim()) ?? 0) + 1);
  const profileIssues = new Map(preview.profiles.map(profile => [profile.sourceId, profile.issues]));
  const change = (sourceId: string, update: Partial<Draft>) => setDrafts(rows => rows.map(row => row.sourceId === sourceId ? { ...row, ...update } : row));
  const validation = (draft: Draft): DraftIssue | null => {
    const id = draft.id.trim();
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) return { field: "id", message: "Use 1–64 lowercase letters, digits, or hyphens. Start with a letter." };
    if (id === "all") return { field: "id", message: "The profile ID all is reserved." };
    if (existingIds.has(id)) return { field: "id", message: "This profile ID already exists." };
    if (destinationCounts.get(id)! > 1) return { field: "id", message: "Choose a unique destination ID." };
    if (draft.name.trim().length > 80 || /[\p{Cc}\p{Bidi_Control}\u2028\u2029\u206a-\u206f]/u.test(draft.name)) return { field: "name", message: "Use a display name of up to 80 characters, without control characters." };
    return null;
  };
  const incompatible = !preview.compatible || preview.issues.length > 0;
  const catalogChanged = preview.revision !== snapshot.catalogRevision;
  const invalid = selected.some(draft => validation(draft) || profileIssues.get(draft.sourceId)?.length);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (disabled || incompatible || catalogChanged || invalid || !selected.length) return;
    void onCommit({ revision: preview.revision, profiles: selected.map(draft => ({ sourceId: draft.sourceId, id: draft.id.trim(), name: draft.name.trim() || draft.id.trim() })) });
  };

  return <form className="transfer-preview" aria-label="Import profiles" onSubmit={submit}>
    <div className="modal-body transfer-preview-body">
      {incompatible && <Notice kind="error" alert><ul className="transfer-issues">{(preview.issues.length ? preview.issues : ["This archive is incompatible with this service."]).map((issue, index) => <li key={index}>{redact(issue)}</li>)}</ul></Notice>}
      {catalogChanged && !state.atomic && <Notice kind="warning"><span>Profiles changed. Reload the preview.</span><button type="button" className="text-button" disabled={disabled} onClick={onReload}>Reload preview</button></Notice>}
      <div className="transfer-selection"><label className="check-label"><input type="checkbox" autoFocus checked={selected.length === drafts.length && drafts.length > 0} ref={node => { if (node) node.indeterminate = selected.length > 0 && selected.length < drafts.length; }} disabled={disabled || !drafts.length} onChange={event => { const checked = event.target.checked; setDrafts(rows => rows.map(row => ({ ...row, selected: checked }))); }} />Select all</label><span className="field-help">{selected.length} of {drafts.length} selected</span></div>
      <div className="transfer-profile-list">{preview.profiles.map((profile, index) => {
        const draft = drafts[index]!;
        const issue = draft.selected ? validation(draft) : null;
        const idError = issue?.field === "id";
        const mapping = profile.sourceId !== draft.id.trim();
        return <section className={`transfer-profile${draft.selected ? " is-selected" : ""}`} key={profile.sourceId} aria-label={profile.sourceId}>
          <label className="check-label transfer-profile-title"><input type="checkbox" aria-label={`Import ${profile.sourceId}`} checked={draft.selected} disabled={disabled} onChange={event => change(profile.sourceId, { selected: event.target.checked })} /><ProfileMark id={profile.sourceId} /><span><strong>{profile.name}</strong><span className="cell-secondary mono">{mapping ? `${profile.sourceId} → ${draft.id.trim() || "…"}` : profile.sourceId}</span></span></label>
          <div className="transfer-profile-meta"><span>Native</span><span className={profile.proxyUnavailable ? "inline-attention" : undefined}>{profile.proxyUnavailable ? "Proxy unavailable; configure it before starting." : profile.proxyDisplay ? proxyDisplay(profile.proxyDisplay) : "Direct"}</span></div>
          <fieldset className="transfer-fields" disabled={disabled || !draft.selected}>
            <div className="form-field"><label htmlFor={`${prefix}-${index}-id`}>Profile ID</label><input id={`${prefix}-${index}-id`} className="mono" required maxLength={64} autoComplete="off" autoCapitalize="none" spellCheck={false} value={draft.id} aria-invalid={idError || undefined} aria-describedby={idError ? `${prefix}-${index}-issue` : undefined} onChange={event => change(profile.sourceId, { id: event.target.value })} /></div>
            <div className="form-field"><label htmlFor={`${prefix}-${index}-name`}>Display name</label><input id={`${prefix}-${index}-name`} maxLength={80} autoComplete="off" placeholder={draft.id.trim() || profile.sourceId} value={draft.name} aria-invalid={issue?.field === "name" || undefined} aria-describedby={issue?.field === "name" ? `${prefix}-${index}-issue` : undefined} onChange={event => change(profile.sourceId, { name: event.target.value })} /></div>
          </fieldset>
          {issue && <p id={`${prefix}-${index}-issue`} className="field-help inline-attention">{issue.message}</p>}
          {profile.issues.length > 0 && <ul className="transfer-issues inline-attention">{profile.issues.map((message, issueIndex) => <li key={issueIndex}>{redact(message)}</li>)}</ul>}
        </section>;
      })}</div>
      {!drafts.length && <p className="empty-inline">This ZIP contains no profiles.</p>}
      <TransferErrors state={state} />
    </div>
    <div className="modal-actions transfer-preview-actions"><span className="field-help">{selected.length} selected</span><button type="button" className="button" disabled={state.atomic || state.closing} onClick={() => void state.dismiss()}>{state.closing ? "Cleaning up…" : "Cancel"}</button><button type="submit" className="button button-primary" disabled={disabled || incompatible || catalogChanged || invalid || !selected.length}>{state.atomic ? "Importing…" : `Import ${selected.length}`}</button></div>
  </form>;
}
