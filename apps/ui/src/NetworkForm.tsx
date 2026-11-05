import { useEffect, useId, useState } from "react";
import type { FormEvent } from "react";
import type { UiProfile, UiNetworkUpdate } from "../../../packages/stelz/src/api/contracts.ts";
import { ApiError, errorMessage } from "./api.ts";
import { hasProxy, networkDirty, networkDraft, networkUpdate } from "./model.ts";
import { KeyValues, Notice } from "./components";

export function NetworkForm({ profile, connected, busy, onSave, onDirtyChange }: {
  profile: UiProfile; connected: boolean; busy: boolean;
  onSave: (id: string, update: UiNetworkUpdate) => Promise<UiProfile>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const network = profile.network;
  const prefix = useId();
  const [baseline, setBaseline] = useState(() => networkDraft(network));
  const [draft, setDraft] = useState(baseline);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [rejectedConflict, setRejectedConflict] = useState(false);
  const dirty = networkDirty(draft, baseline);
  const conflict = rejectedConflict || (!saving && dirty && baseline.revision !== network.revision);
  const stopped = profile.phase === "stopped";
  const editable = stopped && connected && !busy && !saving;
  useEffect(() => {
    // A fresh poll never replaces edits or advances the revision of a dirty form.
    if (!dirty && !saving && network.revision !== baseline.revision) {
      const next = networkDraft(network);
      setBaseline(next);
      setDraft(next);
    }
  }, [network, baseline.revision, dirty, saving]);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const reset = () => {
    const next = networkDraft(network);
    setBaseline(next);
    setDraft(next);
    setRejectedConflict(false);
    setError("");
    setSaved(false);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!editable || !dirty || conflict || saving) return;
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const result = await onSave(profile.id, networkUpdate(draft, baseline, network));
      const next = networkDraft(result.network);
      setBaseline(next);
      setDraft(next);
      setRejectedConflict(false);
      setSaved(true);
    } catch (cause) {
      setError(errorMessage(cause));
      if (cause instanceof ApiError && cause.status === 409) setRejectedConflict(true);
    } finally {
      setSaving(false);
    }
  };
  const reason = conflict ? "Resolve the configuration conflict before saving."
    : !stopped ? "Stop this profile before editing its network."
    : !connected ? "Refresh the connection before making changes."
    : busy || saving ? "Wait for the current service action to finish."
    : !dirty ? "No unsaved changes." : null;
  const patch = (value: Partial<typeof draft>) => { setDraft((current) => ({ ...current, ...value })); setSaved(false); };

  if (!stopped && !dirty) return <div className="network-summary"><KeyValues rows={[
    { label: "Proxy", value: hasProxy(network) ? network.proxyDisplay ?? "Proxy unavailable" : "None" },
    ...(profile.exitIp ? [{ label: "Exit IP", value: profile.exitIp, mono: true }] : []),
    ...(network.expectedIp ? [{ label: "Expected exit IP", value: network.expectedIp, mono: true }] : []),
  ]} /><p className="field-help">Stop the profile to edit its connection.</p></div>;

  return <form className="network-form" onSubmit={event => void save(event)} aria-label={`Network settings for ${profile.name}`}>
    {!stopped && <p className="field-help">Stop the profile to edit its connection.</p>}
    {conflict && <Notice kind="warning"><span>Network settings changed. Your edits remain here.</span><button type="button" className="text-button" onClick={reset} disabled={busy || saving}>Discard edits and load latest</button></Notice>}
    <div className="network-fields"><div className="form-field">
      <label htmlFor={`${prefix}-proxy`}>Proxy URL <span className="label-note">{network.proxyReadOnly ? "Managed externally" : "Optional"}</span></label>
      <input id={`${prefix}-proxy`} type={draft.proxyUrl === baseline.proxyUrl ? "text" : "password"} autoComplete="off" maxLength={8192} spellCheck={false} value={draft.proxyUrl} disabled={!editable} readOnly={network.proxyReadOnly} onChange={event => patch({ proxyUrl: event.target.value })} placeholder="No proxy (direct connection)" aria-describedby={network.proxyReadOnly ? `${prefix}-proxy-help` : undefined} />
      {network.proxyReadOnly && <p className="field-help" id={`${prefix}-proxy-help`}>Change {network.proxyEnv ? <code>{network.proxyEnv}</code> : "the shared secret"} outside the UI.{draft.proxyUrl && <> <button type="button" className="text-button" disabled={!editable} onClick={() => patch({ proxyUrl: "" })}>Remove proxy</button></>}</p>}
    </div>
    <div className="form-field"><label htmlFor={`${prefix}-ip`}>Expected exit IP <span className="label-note">{network.expectedIpReadOnly ? "Managed externally" : "Optional"}</span></label><input id={`${prefix}-ip`} type="text" autoComplete="off" spellCheck={false} value={draft.expectedIp} disabled={!editable || network.expectedIpReadOnly} onChange={event => patch({ expectedIp: event.target.value })} placeholder="No fixed IP required" aria-describedby={network.expectedIpReadOnly ? `${prefix}-ip-help` : undefined} />{network.expectedIpReadOnly && <p className="field-help" id={`${prefix}-ip-help`}>Change {network.expectedIPEnv ? <code>{network.expectedIPEnv}</code> : "the shared reference"} outside the UI.</p>}</div>
    </div>
    {error && <Notice kind="error" alert>{error}</Notice>}
    {(dirty || saved) && <div className="form-actions"><span className="field-help" id={`${prefix}-save-reason`} role="status">{saved ? "Network settings saved." : reason ?? "Applies on the next start."}</span>{dirty && <div className="button-row"><button type="button" className="button" disabled={saving || busy} onClick={reset}>Discard edits</button><button type="submit" className="button button-primary" disabled={!!reason} aria-describedby={`${prefix}-save-reason`}>{saving ? "Saving…" : "Save network"}</button></div>}</div>}
  </form>;
}
