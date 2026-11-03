import { useEffect, useId, useState } from "react";
import type { FormEvent } from "react";
import type { UiProfile, UiNetworkUpdate } from "../src/ui-types";
import { ApiError, errorMessage } from "./api";
import { networkDirty, networkDraft, networkUpdate, proxyDisplay } from "./model";
import { Notice } from "./components";

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
  const [advanced, setAdvanced] = useState(!!network.expectedIp || network.expectedIpReadOnly);
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

  return <form className="network-form" onSubmit={event => void save(event)} aria-label={`Network settings for ${profile.id}`}>
    {!stopped && <Notice kind="warning">Stop this profile before editing its network.</Notice>}
    {conflict && <Notice kind="warning"><span>Network settings changed. Your edits remain here.</span><button type="button" className="text-button" onClick={reset} disabled={busy || saving}>Discard edits and load latest</button></Notice>}
    <div className="form-field"><label htmlFor={`${prefix}-mode`}>Connection mode</label><select id={`${prefix}-mode`} value={draft.mode} disabled={!editable} onChange={event => patch({ mode: event.target.value as "direct" | "proxy" })}><option value="direct">Direct (no proxy)</option><option value="proxy">Proxy</option></select></div>
    {draft.mode === "proxy" && <div className="form-field">
      <label htmlFor={`${prefix}-proxy`}>Proxy URL {network.proxyReadOnly && <span className="label-note">Managed externally</span>}</label>
      <input id={`${prefix}-proxy`} type="password" autoComplete="new-password" spellCheck={false} value={draft.proxyUrl} disabled={!editable || network.proxyReadOnly} onChange={event => patch({ proxyUrl: event.target.value })} placeholder={network.proxyConfigured ? "Leave blank to keep the saved proxy" : "scheme://host:port"} aria-describedby={`${prefix}-proxy-help`} />
      <p className="field-help" id={`${prefix}-proxy-help`}>{network.proxyReadOnly ? <>Change {network.proxyEnv ? <code>{network.proxyEnv}</code> : "the shared secret"} outside the UI.</> : network.proxyConfigured ? <>Current: <code>{proxyDisplay(network.proxyDisplay)}</code>. Leave blank to keep it.</> : "HTTP(S) or unauthenticated SOCKS5."}</p>
    </div>}
    <details className="disclosure" open={advanced} onToggle={event => setAdvanced(event.currentTarget.open)}><summary>IP verification{draft.expectedIp && <span className="label-note">{draft.expectedIp}</span>}</summary>
      <div className="form-field"><label htmlFor={`${prefix}-ip`}>Expected exit IP <span className="label-note">{network.expectedIpReadOnly ? "Managed externally" : "Optional"}</span></label><input id={`${prefix}-ip`} type="text" autoComplete="off" spellCheck={false} value={draft.expectedIp} disabled={!editable || network.expectedIpReadOnly} onChange={event => patch({ expectedIp: event.target.value })} placeholder="No fixed IP required" aria-describedby={`${prefix}-ip-help`} /><p className="field-help" id={`${prefix}-ip-help`}>{network.expectedIpReadOnly ? <>Change {network.expectedIPEnv ? <code>{network.expectedIPEnv}</code> : "the shared reference"} outside the UI.</> : "Leave blank to allow any exit IP. Proxies always verify their connection."}</p></div>
    </details>
    {error && <Notice kind="error" alert>{error}</Notice>}
    <div className="form-actions"><span className={`field-help${!dirty && !saved ? " sr-only" : ""}`} id={`${prefix}-save-reason`} role="status">{saved ? "Network settings saved." : reason ?? "Applies on the next start."}</span><div className="button-row">{dirty && <button type="button" className="button" disabled={saving || busy} onClick={reset}>Discard edits</button>}<button type="submit" className="button button-primary" disabled={!!reason} aria-describedby={`${prefix}-save-reason`}>{saving ? "Saving…" : "Save network"}</button></div></div>
  </form>;
}
