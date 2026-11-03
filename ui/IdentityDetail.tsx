import { useCallback, useState } from "react";
import type { KeyboardEvent } from "react";
import type { UiAction, UiIdentity, UiIdentityDetail, UiNetworkUpdate, UiSnapshot } from "../src/ui-types";
import { identityPath } from "./api";
import { ActionButton, CopyCommand, Icon, KeyValues, Notice, Phase } from "./components";
import { NetworkForm } from "./NetworkForm";
import { boundedLog, dateTime, deleteReason, identityAttention, identityCommand, mcpCommand, phaseExplanation, proxyDisplay, redact } from "./model";
import type { ActionContext } from "./model";
import { useResource } from "./use-service";

const tabs = ["Overview", "Network", "Device", "Logs"] as const;
type Tab = typeof tabs[number];

export function IdentityDetail({ identity, snapshot, context, mutationVersion, onAction, onSave, onBack, onDirtyChange, onDelete }: {
  identity: UiIdentity; snapshot: UiSnapshot; context: ActionContext; mutationVersion: number;
  onAction: (identity: UiIdentity, action: UiAction) => void;
  onSave: (id: string, update: UiNetworkUpdate) => Promise<UiIdentity>;
  onDelete: (identity: UiIdentity) => void;
  onBack: () => void; onDirtyChange: (dirty: boolean) => void;
}) {
  const [tab, setTab] = useState<Tab>("Overview");
  const [networkDirty, setNetworkDirty] = useState(false);
  const handleDirtyChange = useCallback((dirty: boolean) => {
    setNetworkDirty(dirty);
    onDirtyChange(dirty);
  }, [onDirtyChange]);
  const [logsVisit, setLogsVisit] = useState(0);
  const detail = useResource<UiIdentityDetail>(identityPath(identity.id), `${identity.phase}:${identity.network.revision}:${mutationVersion}:${logsVisit}`);
  const selectTab = (next: Tab) => { if (next === "Logs" && tab !== next) setLogsVisit((value) => value + 1); setTab(next); };
  const keyTab = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    selectTab(tabs[next]!);
    document.getElementById(`identity-tab-${tabs[next]}`)?.focus();
  };
  const attention = identityAttention(identity);
  const needsDoctor = ["orphaned", "ownership_unknown", "unclean", "blocked"].includes(identity.phase);
  const identityHome = `${snapshot.home.replace(/\/$/, "")}/identities/${identity.id}`;

  return <div className="detail-view">
    <div className="detail-context"><button type="button" className="text-button" onClick={onBack}><Icon name="back" />All identities</button><span className="detail-context-right"><Phase phase={identity.phase} /><span className="mono muted">127.0.0.1:{identity.port}</span><button type="button" className="button" disabled={!!deleteReason(identity, context) || networkDirty} title={networkDirty ? "Save or discard network edits before deleting." : deleteReason(identity, context) ?? undefined} onClick={() => onDelete(identity)}>Delete identity</button></span></div>
    <div className="tabs" role="tablist" aria-label={`Details for ${identity.id}`}>{tabs.map((name, index) => <button key={name} type="button" role="tab" id={`identity-tab-${name}`} aria-controls={`identity-panel-${name}`} aria-selected={tab === name} tabIndex={tab === name ? 0 : -1} onClick={() => selectTab(name)} onKeyDown={(event) => keyTab(event, index)}>{name}{name === "Network" && networkDirty && <span className="dirty-dot" aria-label="Unsaved network changes" />}</button>)}</div>
    {detail.error && <Notice kind="error"><span>{detail.error} {detail.data ? "Previously loaded details remain visible." : "Identity state remains available."}</span><button type="button" className="text-button" onClick={detail.reload} disabled={detail.loading}>Retry details</button></Notice>}
    <section className="tab-panel" id="identity-panel-Overview" role="tabpanel" aria-labelledby="identity-tab-Overview" hidden={tab !== "Overview"} tabIndex={0}>
      <div className="section-heading"><h2>Browser lifetime</h2>{identity.pendingAction && <span className="muted" role="status">Service action in progress</span>}</div>
      <p className="section-description">{phaseExplanation(identity)}</p>
      {attention && <Notice kind="warning">{attention}</Notice>}
      {needsDoctor && <div className="recovery-commands"><p className="field-help">Inspect configuration and process ownership in a terminal.</p><CopyCommand command={identityCommand("doctor", identity.id, snapshot.home)} />{identity.phase === "unclean" && <><p className="field-help">Inspect any remaining browser processes. After the recorded processes exit, archive this lifetime.</p><CopyCommand command={identityCommand("recover", identity.id, snapshot.home)} /></>}</div>}
      <div className="action-grid" aria-label="Browser lifecycle actions">{(["start", "pause", "resume", "recheck", "release", "stop"] as const).map((action) => <ActionButton key={action} identity={identity} action={action} context={context} onAction={onAction} showReason />)}</div>
      <div className="detail-columns">
        <section className="detail-section"><div className="section-heading"><h2>Controller</h2></div><KeyValues rows={[
          { label: "Access", value: identity.controller ? "Held by one controller" : identity.phase === "ready" ? "Available to acquire" : "No controller" },
          { label: "Controller", value: identity.controller ? redact(identity.controller.label) : "None" },
          { label: "Client PID", value: identity.controller?.pid ?? null, mono: true },
          { label: "Active actions", value: identity.controller?.activeActions ?? 0, mono: true },
          { label: "Handoff", value: identity.controller?.releasing ? "Releasing after current actions finish" : "Explicit release required" },
        ]} /><p className="field-help">Release and client disconnect keep this browser and its open pages. Stop or close its window to stop the identity.</p></section>
        <section className="detail-section"><div className="section-heading"><h2>Network and storage</h2></div><KeyValues rows={[
          { label: "Connection", value: identity.mode === "proxy" ? "Proxy" : "Direct" },
          { label: "Proxy", value: identity.mode === "proxy" ? proxyDisplay(identity.network.proxyDisplay) : "Not in use", mono: true },
          { label: "Exit IP", value: identity.exitIp, mono: true },
          { label: "Expected IP match", value: !identity.network.expectedIp ? "Not required" : identity.checkedAt && identity.exitIp === identity.network.expectedIp && identity.phase !== "verification_failed" ? "Matched at last check" : "Not verified" },
          { label: "Last IP check", value: dateTime(identity.checkedAt) },
          { label: "Storage", value: identity.storage === "native" ? "Native browser profile" : "Legacy checkpoints" },
        ]} /></section>
      </div>
      <section className="detail-section auth-section"><h2>Human authentication</h2><ol className="auth-steps"><li><strong>Pause</strong><span>Block new browser actions. Keep the controller.</span></li><li><strong>Use the same browser</strong><span>Complete sign-in in the existing visible window.</span></li><li><strong>Resume</strong><span>Continue only after authentication is complete.</span></li></ol><p className="field-help">Resume is always explicit. Rechecking the IP does not automatically resume a paused browser.</p></section>
      <section className="detail-section"><div className="section-heading"><h2>Connect through MCP</h2></div><p className="section-description">Start this identity first. The MCP client must acquire it before browser actions.</p><CopyCommand command={redact(detail.data?.mcpCommand ?? mcpCommand(identity.id, snapshot.home))} label={`Copy MCP command for ${identity.id}`} /></section>
    </section>
    <section className="tab-panel" id="identity-panel-Network" role="tabpanel" aria-labelledby="identity-tab-Network" hidden={tab !== "Network"} tabIndex={0}>
      <NetworkForm identity={identity} connected={context.connected} busy={context.pending} onSave={onSave} onDirtyChange={handleDirtyChange} />
    </section>
    <section className="tab-panel" id="identity-panel-Device" role="tabpanel" aria-labelledby="identity-tab-Device" hidden={tab !== "Device"} tabIndex={0}>
      <div className="section-heading"><h2>Device and persistent storage</h2><span className="muted">Read only</span></div><p className="section-description">Device data belongs to this identity. A new controller uses the same saved profile.</p>
      <KeyValues rows={[
        { label: "Storage mode", value: identity.storage === "native" ? "Native" : "Checkpoint" },
        { label: "Identity directory", value: identityHome, mono: true },
        { label: "Browser data", value: `${identityHome}/${identity.storage === "native" ? "browser-data" : "storage"}/`, mono: true },
        { label: "Fingerprint SHA-256", value: identity.fingerprintSha256, mono: true },
        { label: "Engine SHA-256", value: identity.engineSha256, mono: true },
        { label: "Device schema", value: detail.data?.device.version, mono: true },
      ]} />
      <section className="detail-section"><h2>Saved device properties</h2>{detail.loading && !detail.data ? <p className="loading-text" role="status">Loading device properties…</p> : detail.data?.device.properties.length ? <KeyValues rows={detail.data.device.properties.map(({ name, value }) => ({ label: name, value: redact(value), mono: true }))} /> : <p className="empty-inline">No saved device properties. Start the identity after setup to create its device data.</p>}</section>
      <p className="field-help">Storage and device properties cannot be edited here. No profile conversion or fingerprint reset occurs in this console.</p>
    </section>
    <section className="tab-panel" id="identity-panel-Logs" role="tabpanel" aria-labelledby="identity-tab-Logs" hidden={tab !== "Logs"} tabIndex={0}>
      <div className="section-heading"><h2>Service logs</h2><button type="button" className="button" onClick={detail.reload} disabled={detail.loading}><Icon name="refresh" />{detail.loading ? "Loading…" : "Refresh logs"}</button></div><p className="section-description">The last 300 lines per stream, limited to 48 KB. Credentials are redacted. Logs refresh when opened or requested.</p>
      {(["server", "supervisor"] as const).map((stream) => <section className="log-section" key={stream}><h3>{stream === "server" ? "Browser server" : "Supervisor"}</h3><pre className="log-output" tabIndex={0} aria-label={`${stream} log`} aria-busy={detail.loading}>{detail.data ? boundedLog(detail.data.logs[stream]) || `No ${stream} log entries.` : detail.error ? "Logs are unavailable." : "Loading log entries…"}</pre></section>)}
    </section>
  </div>;
}
