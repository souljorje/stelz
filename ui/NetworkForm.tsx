import { useEffect, useId, useState } from "react";
import type { FormEvent } from "react";
import type { UiIdentity, UiNetworkUpdate } from "../src/ui-types";
import { ApiError, errorMessage } from "./api";
import { networkDirty, networkDraft, networkUpdate, proxyDisplay } from "./model";
import { Notice } from "./components";

export function NetworkForm({ identity, connected, busy, onSave, onDirtyChange }: {
  identity: UiIdentity; connected: boolean; busy: boolean;
  onSave: (id: string, update: UiNetworkUpdate) => Promise<UiIdentity>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const network = identity.network;
  const prefix = useId();
  const [baseline, setBaseline] = useState(() => networkDraft(network));
  const [draft, setDraft] = useState(baseline);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [rejectedConflict, setRejectedConflict] = useState(false);
  const dirty = networkDirty(draft, baseline);
  const conflict = rejectedConflict || (!saving && dirty && baseline.revision !== network.revision);
  const stopped = identity.phase === "stopped";
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
      const result = await onSave(identity.id, networkUpdate(draft, baseline, network));
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
    : !stopped ? "Stop this identity before editing its network."
    : !connected ? "Refresh the connection before making changes."
    : busy || saving ? "Wait for the current service action to finish."
    : !dirty ? "No unsaved changes." : null;
  const patch = (value: Partial<typeof draft>) => { setDraft((current) => ({ ...current, ...value })); setSaved(false); };

  return <form className="network-form" onSubmit={(event) => void save(event)} aria-label={`Network settings for ${identity.id}`}>
    <div className="section-heading"><h2>Network configuration</h2><span className="muted">{dirty ? "Unsaved changes" : "Saved configuration"}</span></div>
    <p className="section-description">A proxy is optional. Network changes apply to the next browser start.</p>
    {!stopped && <Notice kind="warning">Stop <span className="mono">{identity.id}</span> before editing. The current configuration remains visible.</Notice>}
    {conflict && <Notice kind="warning"><span>Network settings changed or the service rejected this revision. Your edits remain here.</span><button type="button" className="text-button" onClick={reset} disabled={busy || saving}>Discard edits and load latest</button></Notice>}
    <div className="form-field"><label htmlFor={`${prefix}-mode`}>Connection mode</label><select id={`${prefix}-mode`} value={draft.mode} disabled={!editable} onChange={(event) => patch({ mode: event.target.value as "direct" | "proxy" })} aria-describedby={`${prefix}-mode-help`}><option value="direct">Direct (no proxy)</option><option value="proxy">Proxy</option></select><p className="field-help" id={`${prefix}-mode-help`}>{draft.mode === "direct" ? "Use this computer’s connection. No proxy or IP lookup is required unless you set an expected exit IP." : "Use the configured proxy. If its check fails, browser actions stay blocked until you correct it and recheck."}</p></div>
    <div className="form-field"><label htmlFor={`${prefix}-proxy`}>Proxy URL <span className="label-note">{draft.mode === "direct" ? "Not used" : network.proxyReadOnly ? "Managed outside UI" : network.proxyConfigured ? "Optional replacement" : "Required for proxy mode"}</span></label><input id={`${prefix}-proxy`} type="password" autoComplete="new-password" spellCheck={false} value={draft.proxyUrl} disabled={!editable || network.proxyReadOnly || draft.mode === "direct"} onChange={(event) => patch({ proxyUrl: event.target.value })} placeholder={network.proxyConfigured ? "Leave blank to keep the saved proxy" : "scheme://host:port"} aria-describedby={`${prefix}-proxy-help`} /><p className="field-help" id={`${prefix}-proxy-help`}>{draft.mode === "direct" ? "Direct mode ignores saved proxy credentials." : network.proxyReadOnly ? <>Managed by an environment override or shared secret reference{network.proxyEnv ? <>: <code>{network.proxyEnv}</code></> : null}. Change its source outside this console.</> : network.proxyConfigured ? "A blank field preserves the saved proxy, including its credentials." : "Enter a proxy URL, or select Direct to connect without a proxy."}</p><div className="saved-network"><span>Saved proxy</span><code>{proxyDisplay(network.proxyDisplay)}</code></div></div>
    <div className="form-field"><label htmlFor={`${prefix}-ip`}>Expected exit IP <span className="label-note">{network.expectedIpReadOnly ? "Managed outside UI" : "Optional"}</span></label><input id={`${prefix}-ip`} type="text" autoComplete="off" spellCheck={false} value={draft.expectedIp} disabled={!editable || network.expectedIpReadOnly} onChange={(event) => patch({ expectedIp: event.target.value })} placeholder="No fixed IP required" aria-describedby={`${prefix}-ip-help`} /><p className="field-help" id={`${prefix}-ip-help`}>{network.expectedIpReadOnly ? <>Managed by an environment override or shared reference{network.expectedIPEnv ? <>: <code>{network.expectedIPEnv}</code></> : null}. Change its source outside this console.</> : "Clear this field to remove the fixed IP requirement. The next start uses the saved value."}</p></div>
    {error && <Notice kind="error" alert>{error}</Notice>}
    <div className="form-actions"><span className="field-help" id={`${prefix}-save-reason`} role="status">{saved ? "Network settings saved." : reason ?? "Changes are checked against the configuration you loaded."}</span><div className="button-row">{dirty && <button type="button" className="button" disabled={saving || busy} onClick={reset}>Discard edits</button>}<button type="submit" className="button button-primary" disabled={!!reason} aria-describedby={`${prefix}-save-reason`}>{saving ? "Saving…" : "Save network"}</button></div></div>
  </form>;
}
