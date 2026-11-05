import { useId, useState } from "react";
import type { FormEvent } from "react";
import type { UiProfile, UiProfileCreate, UiSnapshot } from "../../../packages/stelz/src/api/contracts.ts";
import { errorMessage } from "./api.ts";
import { Modal, Notice } from "./components";
import { deleteReason, type ActionContext } from "./model.ts";

export function CreateProfile({ snapshot, connected, busy, onClose, onCreate }: {
  snapshot: UiSnapshot; connected: boolean; busy: boolean; onClose: () => void;
  onCreate: (input: UiProfileCreate) => Promise<void>;
}) {
  const prefix = useId();
  const [id, setId] = useState("");
  const [proxy, setProxy] = useState("");
  const [expectedIp, setExpectedIp] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const duplicate = snapshot.profiles.some(row => row.id === id.trim());
  const reserved = id.trim() === "all";
  const disabled = !connected || busy || saving;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (disabled || duplicate || reserved) return;
    setSaving(true); setError("");
    try {
      await onCreate({ id: id.trim(), revision: snapshot.catalogRevision,
        ...(proxy.trim() ? { proxyUrl: proxy.trim() } : {}), ...(expectedIp.trim() ? { expectedIp: expectedIp.trim() } : {}) });
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setSaving(false); }
  };
  return <Modal title="Create profile" onClose={onClose} busy={busy || saving}>
    <form onSubmit={event => void submit(event)} aria-label="Create profile">
      <div className="modal-body profile-create-fields">
        <div className="form-field"><label htmlFor={`${prefix}-id`}>Profile name</label><input id={`${prefix}-id`} autoFocus required pattern="[a-z][a-z0-9\-]{0,63}" maxLength={64} autoComplete="off" spellCheck={false} value={id} disabled={disabled} onChange={event => setId(event.target.value)} placeholder="work-browser" aria-describedby={`${prefix}-id-help`} /><p id={`${prefix}-id-help`} className="field-help">{reserved ? "The name all is reserved for lifecycle commands." : duplicate ? "This profile name already exists." : "Use lowercase letters, digits, and hyphens. Start with a letter."}</p></div>
        <div className="form-field"><label htmlFor={`${prefix}-proxy`}>Proxy URL <span className="label-note">Optional</span></label><input id={`${prefix}-proxy`} type="password" autoComplete="new-password" maxLength={8192} spellCheck={false} value={proxy} disabled={disabled} onChange={event => setProxy(event.target.value)} placeholder="scheme://host:port" aria-describedby={`${prefix}-proxy-help`} /><p id={`${prefix}-proxy-help`} className="field-help">Leave blank for a direct connection.</p></div>
        <details className="create-options"><summary>IP verification</summary><div className="form-field"><label htmlFor={`${prefix}-ip`}>Expected exit IP <span className="label-note">Optional</span></label><input id={`${prefix}-ip`} autoComplete="off" spellCheck={false} value={expectedIp} disabled={disabled} onChange={event => setExpectedIp(event.target.value)} placeholder="No fixed IP required" /><p className="field-help">Direct connections skip IP checks unless you require an expected IP. Proxy connections verify their exit IP.</p></div></details>
        {error && <Notice kind="error" alert>{error}</Notice>}
        {!connected && <p className="field-help" role="status">Refresh the connection before creating a profile.</p>}
      </div>
      <div className="modal-actions"><button type="button" className="button" disabled={busy || saving} onClick={onClose}>Cancel</button><button type="submit" className="button button-primary" disabled={disabled || duplicate || reserved || !id.trim()}>{saving ? "Creating…" : "Create profile"}</button></div>
    </form>
  </Modal>;
}

export function DeleteProfile({ original, profile, context, busy, onClose, onDelete }: {
  original: UiProfile; profile: UiProfile | undefined; context: ActionContext; busy: boolean;
  onClose: () => void; onDelete: (id: string, revision: string) => Promise<void>;
}) {
  const prefix = useId();
  const [typed, setTyped] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const reason = profile ? deleteReason(profile, context) : "This profile is no longer configured.";
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (reason || busy || saving || typed !== original.id) return;
    setSaving(true); setError("");
    try { await onDelete(original.id, context.snapshot.catalogRevision); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setSaving(false); }
  };
  return <Modal title={`Delete ${original.id}?`} onClose={onClose} busy={busy || saving}>
    <form onSubmit={event => void submit(event)} aria-label={`Delete ${original.id}`}>
      <div className="modal-body"><p>Remove this profile from the list. Its saved browser profile will be archived in <code>{context.snapshot.home}/trash/</code>.</p><div className="form-field"><label htmlFor={`${prefix}-confirm`}>Type <span className="mono">{original.id}</span> to confirm</label><input id={`${prefix}-confirm`} autoFocus autoComplete="off" spellCheck={false} value={typed} disabled={busy || saving} onChange={event => setTyped(event.target.value)} /></div>{reason && <Notice kind="warning">{reason}</Notice>}{error && <Notice kind="error" alert>{error}</Notice>}</div>
      <div className="modal-actions"><button type="button" className="button" disabled={busy || saving} onClick={onClose}>Cancel</button><button type="submit" className="button button-danger" disabled={!!reason || busy || saving || typed !== original.id}>{saving ? "Deleting…" : "Delete profile"}</button></div>
    </form>
  </Modal>;
}
