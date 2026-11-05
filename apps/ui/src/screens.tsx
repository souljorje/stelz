import type { UiAction, UiDiagnostics, UiProfile, UiSnapshot } from "../../../packages/stelz/src/api/contracts.ts";
import { ActionButton, CopyCommand, Icon, KeyValues, Notice, Phase, Select } from "./components";
import { actionReason, hasProxy, homeCommand, profileAttention, profileCommand, mcpCommand, proxyDisplay, redact } from "./model.ts";
import type { ActionContext } from "./model.ts";
import { useResource } from "./use-service.ts";
import type { ThemePreference } from "./theme.ts";
import { ProfileMark } from "./ProfileMark";
import { ShowWindowButton, type ShowWindow } from "./ProfileWindows";

export function Profiles({ snapshot, context, onInspect, onAction, onShow }: { snapshot: UiSnapshot; context: ActionContext; onInspect: (id: string) => void; onAction: (profile: UiProfile, action: UiAction) => void; onShow: ShowWindow }) {
  if (!snapshot.profiles.length) return <p className="empty-inline">Create a profile to start a browser.</p>;
  return <div className="profile-table-wrap"><table className="profile-table">
    <caption className="sr-only">Browser profiles</caption>
    <thead><tr><th scope="col">Profile</th><th scope="col">Browser</th><th scope="col">Connection</th><th scope="col" className="actions-heading"><span className="sr-only">Actions</span></th></tr></thead>
    <tbody>{snapshot.profiles.map(profile => {
      const action = profile.phase === "stopped" || profile.phase === "unclean" ? "start" : "stop";
      const reason = actionReason(profile, action, context);
      const issue = profileAttention(profile) ?? (profile.phase === "stopped" && context.connected && !context.pending ? reason : null);
      return <tr key={profile.id} className="profile-row" aria-busy={!!profile.pendingAction} onClick={event => {
        if ((event.target as Element).closest("button, a, input, select, textarea, summary, [data-row-control]") || window.getSelection()?.toString()) return;
        onInspect(profile.id);
      }}>
        <th scope="row"><button type="button" className="profile-name" aria-label={`Inspect ${profile.name}`} onClick={() => onInspect(profile.id)}><ProfileMark id={profile.id} /><span>{profile.name}</span></button></th>
        <td className="browser-phase"><Phase phase={profile.phase} />{profile.controller && <span className="cell-secondary">{profile.controller.releasing ? "Releasing " : ""}{redact(profile.controller.label)}</span>}{issue && <span className="cell-secondary profile-issue inline-attention" title={issue}>{issue}</span>}</td>
        <td className="profile-connection"><span title={hasProxy(profile.network) ? proxyDisplay(profile.network.proxyDisplay) : undefined}>{hasProxy(profile.network) ? profile.network.proxyConfigured ? "Proxy" : "Proxy missing" : "Direct"}</span></td>
        <td className="row-actions"><div className="button-row"><ShowWindowButton profile={profile} context={context} onShow={onShow} compact /><ActionButton profile={profile} action={action} context={context} onAction={onAction} compact /></div></td>
      </tr>;
    })}</tbody>
  </table></div>;
}

export function FirstRun({ snapshot }: { snapshot: UiSnapshot }) {
  return <section className="first-run"><h2>{!snapshot.initialized ? "Initialize the service" : "Install the browser runtime"}</h2>{!snapshot.initialized && <CopyCommand command={homeCommand("init", snapshot.home)} />}<CopyCommand command={homeCommand("setup", snapshot.home)} /></section>;
}

export function Diagnostics({ snapshot, mutationVersion }: { snapshot: UiSnapshot; mutationVersion: number }) {
  const version = `${mutationVersion}:${snapshot.profiles.map(row => `${row.id}:${row.phase}:${row.configurationError}`).join("|")}`;
  const diagnostics = useResource<UiDiagnostics>("/api/diagnostics", version);
  const data = diagnostics.data;
  return <div className="page-content">
    <div className="section-heading"><h2>Installation</h2><button type="button" className="button" onClick={diagnostics.reload} disabled={diagnostics.loading}><Icon name="refresh" />{diagnostics.loading ? "Checking…" : "Check again"}</button></div>
    {diagnostics.error && <Notice kind="error"><span>{diagnostics.error}</span><button type="button" className="text-button" onClick={diagnostics.reload}>Retry</button></Notice>}
    {!data && diagnostics.loading && <div className="loading-block" role="status">Checking the local service…</div>}
    {data && <><KeyValues rows={[
      { label: "Service home", value: data.home, mono: true },
      { label: "Configuration", value: <Check ok={data.initialized} yes="Initialized" no="Run stelz init" /> },
      { label: "Runtime", value: <Check ok={data.setup} yes="Installed" no="Run stelz setup" /> },
      { label: "Node.js", value: <Check ok={data.node} yes="Available" no="Not available" /> },
      { label: "Browser", value: <Check ok={data.browserExecutable} yes="Available" no="Not available" /> },
    ]} /><section className="detail-section"><h2>Profiles</h2><div className="diagnostic-profiles">{data.profiles.map(profile => <section className="diagnostic-profile" key={profile.id}><div className="section-heading"><h3>{profile.id}</h3><Phase phase={profile.phase} /></div><KeyValues rows={[
      { label: "Configuration", value: redact(profile.configuration) },
      { label: "Access key", value: <Check ok={profile.accessKeyPresent} yes="Present" no="Not present" /> },
      { label: "Supervisor PID", value: profile.supervisorPid, mono: true },
      { label: "Server PID", value: profile.serverPid, mono: true },
      { label: "Supervisor ownership", value: profile.ownership?.supervisor },
      { label: "Server ownership", value: profile.ownership?.server },
    ]} /><CopyCommand command={profileCommand("doctor", profile.id, snapshot.home)} /></section>)}</div>{!data.profiles.length && <p className="empty-inline">No profiles.</p>}</section></>}
    <details className="disclosure"><summary>Terminal diagnostics</summary><CopyCommand command={homeCommand("doctor", snapshot.home)} /></details>
  </div>;
}

function Check({ ok, yes, no }: { ok: boolean; yes: string; no: string }) { return <span className={ok ? undefined : "inline-attention"}>{ok ? yes : no}</span>; }

export function Settings({ snapshot, theme, onThemeChange }: { snapshot: UiSnapshot; theme: ThemePreference; onThemeChange: (theme: ThemePreference) => void }) {
  return <div className="page-content settings-view">
    <section className="settings-section"><h2 id="theme-label">Theme</h2><Select className="theme-select" aria-labelledby="theme-label" value={theme} onChange={event => onThemeChange(event.target.value as ThemePreference)}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></Select></section>
    <section className="settings-section"><h2>Service</h2><KeyValues rows={[
      { label: "Home", value: snapshot.home, mono: true },
      { label: "stelz", value: snapshot.version, mono: true },
      { label: "Camofox", value: snapshot.upstreamVersion, mono: true },
      { label: "Browsers per profile", value: 1 },
    ]} /></section>
    <section className="settings-section"><h2>MCP connections</h2><div className="mcp-list">{snapshot.profiles.map(profile => <div key={profile.id}><h3>{profile.name}</h3><CopyCommand command={mcpCommand(profile.id, snapshot.home)} label={`Copy MCP command for ${profile.name}`} /></div>)}{!snapshot.profiles.length && <p className="empty-inline">Create a profile to connect an MCP client.</p>}</div></section>
  </div>;
}
