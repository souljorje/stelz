import type { UiAction, UiDiagnostics, UiIdentity, UiSnapshot } from "../src/ui-types";
import { ActionButton, CopyCommand, Icon, KeyValues, Notice, Phase } from "./components";
import { capacityUsed, dateTime, homeCommand, identityAttention, identityCommand, mcpCommand, proxyDisplay, redact } from "./model";
import type { ActionContext } from "./model";
import { useResource } from "./use-service";

export function Identities({ snapshot, context, onInspect, onAction, onCreate }: { snapshot: UiSnapshot; context: ActionContext; onInspect: (id: string) => void; onAction: (identity: UiIdentity, action: UiAction) => void; onCreate: () => void }) {
  const available = snapshot.identities.filter((row) => row.phase === "ready" && !row.controller && !row.pendingAction && !row.controlError && !row.configurationError);
  const attention = snapshot.identities.filter((row) => identityAttention(row));
  const used = capacityUsed(snapshot.identities);
  return <div className="identities-view">
    <div className="list-heading"><div><h2>Browser identities</h2><p className="list-finding">{available.length ? `${available.map((row) => row.id).join(", ")} ${available.length === 1 ? "is" : "are"} ready for a controller.` : used ? "No identity is currently free and ready for a controller." : snapshot.identities.length ? "No browsers are running. Start an identity when you need it." : "Create your first identity to get started."}</p></div><div className="list-tools"><span className="capacity" title="Calculated from identity phases. Unknown ownership reserves a slot until inspected."><span className="capacity-number">{used}<span className="muted"> / {snapshot.maxActive}</span></span> browser slots occupied</span><button type="button" className="button button-primary" disabled={!context.connected || context.pending} onClick={onCreate}>New identity</button></div></div>
    <div className="identity-table-wrap"><table className="identity-table"><caption className="sr-only">Configured browser identities with independent browser phase and controller ownership</caption><thead><tr><th scope="col">Identity</th><th scope="col">Browser phase</th><th scope="col">Controller</th><th scope="col">Network / exit IP</th><th scope="col">Storage</th><th scope="col" className="actions-heading">Actions</th></tr></thead><tbody>{snapshot.identities.map((identity) => {
      const rowAction = identity.phase === "stopped" ? "start" : "stop";
      const issue = identityAttention(identity);
      return <tr key={identity.id} aria-busy={!!identity.pendingAction}>
        <th scope="row" data-label="Identity"><button type="button" className="identity-name" onClick={() => onInspect(identity.id)}>{identity.id}</button><span className="cell-secondary mono">127.0.0.1:{identity.port}</span><span className="cell-secondary storage-inline">{identity.storage === "native" ? "Native profile" : "Checkpoint storage"}</span></th>
        <td data-label="Browser phase"><Phase phase={identity.phase} /><span className="cell-secondary">{identity.pendingAction ? "Service action pending" : identity.configurationError ? "Configuration needs attention" : identity.phase === "ready" ? "Browser running" : identity.phase === "stopped" ? "Browser closed" : "Inspect identity"}</span></td>
        <td data-label="Controller"><span className="cell-primary">{identity.controller ? redact(identity.controller.label) : "None"}</span><span className="cell-secondary">{identity.controller ? identity.controller.releasing ? "Releasing" : `${identity.controller.activeActions} active ${identity.controller.activeActions === 1 ? "action" : "actions"} · PID ${identity.controller.pid}` : "Not acquired"}</span></td>
        <td data-label="Network / exit IP"><span className="cell-primary">{identity.mode === "proxy" ? "Proxy" : "Direct"}{identity.mode === "proxy" && !identity.network.proxyConfigured ? <span className="inline-attention"> · Missing proxy</span> : null}</span><span className="cell-secondary mono" title={identity.mode === "proxy" ? proxyDisplay(identity.network.proxyDisplay) : undefined}>{identity.exitIp ?? "IP not checked"}</span></td>
        <td data-label="Storage"><span className="cell-primary">{identity.storage === "native" ? "Native" : "Checkpoint"}</span><span className="cell-secondary">{identity.storage === "native" ? "Persistent profile" : "Legacy storage"}</span></td>
        <td className="row-actions" data-label="Actions"><div className="button-row"><ActionButton identity={identity} action={rowAction} context={context} onAction={onAction} compact /><button type="button" className="button button-inspect" onClick={() => onInspect(identity.id)} aria-label={`Inspect ${identity.id}`}>Inspect<Icon name="chevron" /></button></div>{issue && <span className="cell-secondary row-attention">Needs attention</span>}</td>
      </tr>;
    })}</tbody></table>{snapshot.identities.length === 0 && <div className="empty-inline">No identities yet. Create an identity with an optional proxy.</div>}</div>
    <div className="table-note"><span>{snapshot.identities.length} configured {snapshot.identities.length === 1 ? "identity" : "identities"}</span><span>Ready describes the browser. Controller describes exclusive access.</span></div>
    {attention.length > 0 && <section className="attention-section"><div className="section-heading"><h2>Needs attention</h2><span className="muted">{attention.length} {attention.length === 1 ? "identity" : "identities"}</span></div><div className="attention-list">{attention.map((identity) => <div className="attention-row" key={identity.id}><span className="attention-marker" aria-hidden="true" /><div><strong className="mono">{identity.id}</strong><p>{identityAttention(identity)}</p></div><button type="button" className="text-button" onClick={() => onInspect(identity.id)}>Inspect<Icon name="chevron" /></button></div>)}</div></section>}
    <section className="console-procedure"><div><h2>One browser, one controller</h2><p>Release hands control to another client. The browser and its open pages stay available.</p></div><div><h2>Human authentication</h2><p>Pause → complete sign-in in the same browser → Resume. Browser actions stay blocked until you resume.</p></div></section>
    <p className="footer-note">Closing this console keeps the browsers running. Stop an identity or close its browser window to stop it.</p>
  </div>;
}

export function FirstRun({ snapshot }: { snapshot: UiSnapshot }) {
  return <section className="first-run"><Icon name="terminal" /><h2>{!snapshot.initialized ? "Initialize the local service" : "Install the browser runtime"}</h2><p>{!snapshot.initialized ? "No service configuration exists yet. Initialize it in a terminal, then install the runtime." : "The service is configured. Run setup before starting an identity."}</p>{!snapshot.initialized && <CopyCommand command={homeCommand("init", snapshot.home)} />}<CopyCommand command={homeCommand("setup", snapshot.home)} /><p className="field-help">This console does not initialize or install the service automatically. State refreshes after you finish.</p></section>;
}

export function Diagnostics({ snapshot, mutationVersion }: { snapshot: UiSnapshot; mutationVersion: number }) {
  const version = `${mutationVersion}:${snapshot.identities.map((row) => `${row.id}:${row.phase}:${row.configurationError}`).join("|")}`;
  const diagnostics = useResource<UiDiagnostics>("/api/diagnostics", version);
  const data = diagnostics.data;
  return <div className="page-content"><div className="page-intro"><div><h2>Service diagnostics</h2><p>Inspect installation, configuration, and process ownership.</p></div><button type="button" className="button" onClick={diagnostics.reload} disabled={diagnostics.loading}><Icon name="refresh" />{diagnostics.loading ? "Checking…" : "Check again"}</button></div>
    {diagnostics.error && <Notice kind="error"><span>{diagnostics.error} {data ? "The previous diagnostic result remains visible." : "Diagnostics could not load."}</span><button type="button" className="text-button" onClick={diagnostics.reload}>Retry</button></Notice>}
    {!data && diagnostics.loading && <div className="loading-block" role="status">Checking the local service…</div>}
    {data && <><section className="detail-section"><h2>Installation</h2><KeyValues rows={[
      { label: "Service home", value: data.home, mono: true },
      { label: "Configuration", value: <Check ok={data.initialized} yes="Initialized" no="Run stelz init" /> },
      { label: "Upstream runtime", value: <Check ok={data.setup} yes="Installed" no="Run stelz setup" /> },
      { label: "Node.js", value: <Check ok={data.node} yes="Available" no="Not available" /> },
      { label: "Browser executable", value: <Check ok={data.browserExecutable} yes="Available" no="Not available" /> },
    ]} /></section><section className="detail-section"><h2>Identity checks</h2><div className="diagnostic-identities">{data.identities.map((identity) => <section className="diagnostic-identity" key={identity.id}><div className="section-heading"><h3 className="mono">{identity.id}</h3><Phase phase={identity.phase} /></div><KeyValues rows={[
      { label: "Configuration", value: redact(identity.configuration) },
      { label: "Access key", value: <Check ok={identity.accessKeyPresent} yes="Present · value hidden" no="Not present" /> },
      { label: "Supervisor PID", value: identity.supervisorPid, mono: true },
      { label: "Server PID", value: identity.serverPid, mono: true },
      { label: "Supervisor ownership", value: identity.ownership?.supervisor },
      { label: "Server ownership", value: identity.ownership?.server },
    ]} /><CopyCommand command={identityCommand("doctor", identity.id, snapshot.home)} /></section>)}</div>{data.identities.length === 0 && <p className="empty-inline">No configured identities to inspect.</p>}</section></>}
    <section className="detail-section"><h2>Inspect from a terminal</h2><p className="section-description">Doctor reads state without starting or stopping browsers. Recovery requires deliberate process inspection.</p><CopyCommand command={homeCommand("doctor", snapshot.home)} /></section>
  </div>;
}

function Check({ ok, yes, no }: { ok: boolean; yes: string; no: string }) { return <span className={ok ? undefined : "inline-attention"}>{ok ? yes : no}</span>; }

export function Settings({ snapshot }: { snapshot: UiSnapshot }) {
  return <div className="page-content settings-view"><div className="page-intro"><div><h2>Local service settings</h2><p>Installation details and commands for your MCP clients.</p></div><span className="muted">Read only</span></div>
    <section className="settings-section"><div><h3>Installation</h3><p>The service stores identity state under this home. Use the same home for every client.</p></div><KeyValues rows={[
      { label: "Service home", value: snapshot.home, mono: true },
      { label: "stelz version", value: snapshot.version, mono: true },
      { label: "Camofox version", value: snapshot.upstreamVersion, mono: true },
      { label: "Configuration", value: snapshot.initialized ? "Initialized" : "Not initialized" },
      { label: "Runtime setup", value: snapshot.setup ? "Complete" : "Required" },
      { label: "Browser limit", value: snapshot.maxActive, mono: true },
      { label: "State updated", value: dateTime(snapshot.updatedAt) },
    ]} /></section>
    <section className="settings-section"><div><h3>MCP connections</h3><p>Each client selects one identity. Start the browser explicitly, then let the client acquire control.</p><p>These commands do not change any client configuration.</p></div><div className="mcp-list">{snapshot.identities.map((identity) => <div key={identity.id}><h4 className="mono">{identity.id}</h4><CopyCommand command={mcpCommand(identity.id, snapshot.home)} label={`Copy MCP command for ${identity.id}`} /></div>)}{snapshot.identities.length === 0 && <p className="empty-inline">Initialize the service to configure identity connections.</p>}</div></section>
    <section className="settings-section"><div><h3>Session and browser lifetime</h3><p>This browser connects through an HttpOnly session cookie.</p></div><div className="settings-copy"><p>Open a local URL from <code>stelz ui</code> when you need a new session. The launch token is removed from the address bar immediately.</p><p>Closing this console or disconnecting a controller preserves browser windows. Use Stop to close a browser.</p><p>Configuration, storage, and device migrations require explicit service commands.</p></div></section>
  </div>;
}
