import { useCallback, useState } from "react";
import type { KeyboardEvent } from "react";
import type { UiAction, UiProfile, UiProfileDetail, UiNetworkUpdate, UiSnapshot } from "../../../packages/stelz/src/api/contracts.ts";
import { profilePath } from "./api.ts";
import { ActionButton, CopyCommand, Icon, KeyValues, Notice, Phase } from "./components";
import { NetworkForm } from "./NetworkForm";
import { actionReason, boundedLog, dateTime, deleteReason, profileAttention, profileCommand, mcpCommand, proxyDisplay, redact } from "./model.ts";
import type { ActionContext } from "./model.ts";
import { useResource } from "./use-service.ts";
import { ProfileWindows, type ShowWindow } from "./ProfileWindows";

const tabs = ["Overview", "Network", "Device", "Logs"] as const;
type Tab = typeof tabs[number];

export function ProfileDetail({ profile, snapshot, context, mutationVersion, onAction, onSave, onBack, onDirtyChange, onDelete, onShow }: {
  profile: UiProfile; snapshot: UiSnapshot; context: ActionContext; mutationVersion: number;
  onAction: (profile: UiProfile, action: UiAction) => void;
  onSave: (id: string, update: UiNetworkUpdate) => Promise<UiProfile>;
  onDelete: (profile: UiProfile) => void;
  onBack: () => void; onDirtyChange: (dirty: boolean) => void;
  onShow: ShowWindow;
}) {
  const [tab, setTab] = useState<Tab>("Overview");
  const [networkDirty, setNetworkDirty] = useState(false);
  const handleDirtyChange = useCallback((dirty: boolean) => {
    setNetworkDirty(dirty);
    onDirtyChange(dirty);
  }, [onDirtyChange]);
  const [logsVisit, setLogsVisit] = useState(0);
  const detail = useResource<UiProfileDetail>(profilePath(profile.id), `${profile.phase}:${profile.network.revision}:${mutationVersion}:${logsVisit}`);
  const selectTab = (next: Tab) => { if (next === "Logs" && tab !== next) setLogsVisit((value) => value + 1); setTab(next); };
  const keyTab = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    selectTab(tabs[next]!);
    document.getElementById(`profile-tab-${tabs[next]}`)?.focus();
  };
  const attention = profileAttention(profile);
  const needsDoctor = ["orphaned", "ownership_unknown", "unclean", "blocked"].includes(profile.phase);
  const profileHome = detail.data?.directory ?? null;
  const actions = (["start", "pause", "resume", "recheck", "release", "stop"] as const).filter(action => action === "start" && ["stopped", "unclean"].includes(profile.phase) || !actionReason(profile, action, context));
  const canDelete = !deleteReason(profile, context) && !networkDirty;

  return <div className="detail-view">
    <div className="detail-context"><button type="button" className="text-button" onClick={onBack}><Icon name="back" />All profiles</button><span className="detail-context-right"><Phase phase={profile.phase} />{canDelete && <button type="button" className="text-button delete-profile" onClick={() => onDelete(profile)}>Delete profile</button>}</span></div>
    <div className="tabs" role="tablist" aria-label={`Details for ${profile.id}`}>{tabs.map((name, index) => <button key={name} type="button" role="tab" id={`profile-tab-${name}`} aria-controls={`profile-panel-${name}`} aria-selected={tab === name} tabIndex={tab === name ? 0 : -1} onClick={() => selectTab(name)} onKeyDown={(event) => keyTab(event, index)}>{name}{name === "Network" && networkDirty && <span className="dirty-dot" aria-label="Unsaved network changes" />}</button>)}</div>
    {detail.error && <Notice kind="error"><span>{detail.error} {detail.data ? "Previously loaded details remain visible." : "Profile state remains available."}</span><button type="button" className="text-button" onClick={detail.reload} disabled={detail.loading}>Retry details</button></Notice>}
    <section className="tab-panel" id="profile-panel-Overview" role="tabpanel" aria-labelledby="profile-tab-Overview" hidden={tab !== "Overview"} tabIndex={0}>
      {attention && <Notice kind="warning">{attention}</Notice>}
      {needsDoctor && <div className="recovery-commands"><p className="field-help">Inspect configuration and process ownership in a terminal.</p><CopyCommand command={profileCommand("doctor", profile.id, snapshot.home)} />{profile.phase === "unclean" && <><p className="field-help">Inspect any remaining browser processes. After the recorded processes exit, archive this lifetime.</p><CopyCommand command={profileCommand("recover", profile.id, snapshot.home)} /></>}</div>}
      {actions.length > 0 ? <div className="lifecycle-toolbar" role="group" aria-label="Browser lifecycle actions">{actions.map(action => <ActionButton key={action} profile={profile} action={action} context={context} onAction={onAction} primary={action === "start" || action === "resume"} />)}</div> : profile.phase === "stopped" && <p className="unavailable-actions field-help">{actionReason(profile, "start", context)}</p>}
      <KeyValues rows={[
        { label: "Controller", value: profile.controller ? redact(profile.controller.label) : profile.phase === "ready" ? "Available" : "None" },
        { label: "Connection", value: profile.mode === "proxy" ? proxyDisplay(profile.network.proxyDisplay) : "Direct" },
        ...(profile.exitIp ? [{ label: "Exit IP", value: profile.exitIp, mono: true }] : []),
      ]} />
      {tab === "Overview" && ["ready", "paused", "verification_failed"].includes(profile.phase) && <ProfileWindows profile={profile} context={context} mutationVersion={mutationVersion} onShow={onShow} />}
      <details className="disclosure"><summary>Connect via MCP</summary><CopyCommand command={redact(detail.data?.mcpCommand ?? mcpCommand(profile.id, snapshot.home))} label={`Copy MCP command for ${profile.id}`} /></details>
      <details className="disclosure"><summary>Technical details</summary><KeyValues rows={[
        { label: "Endpoint", value: `127.0.0.1:${profile.port}`, mono: true },
        ...(profile.controller ? [
          { label: "Controller PID", value: profile.controller.pid, mono: true },
          { label: "Active actions", value: profile.controller.activeActions },
          { label: "Handoff", value: profile.controller.releasing ? "Releasing after current actions finish" : "Explicit release required" },
        ] : []),
        { label: "Expected exit IP", value: profile.network.expectedIp, mono: true },
        { label: "IP verification", value: !profile.network.expectedIp ? "No fixed IP required" : profile.checkedAt && profile.exitIp === profile.network.expectedIp && profile.phase !== "verification_failed" ? "Matched at last check" : "Not verified" },
        { label: "Last IP check", value: dateTime(profile.checkedAt) },
        { label: "Storage", value: profile.storage === "native" ? "Native browser profile" : "Legacy checkpoints" },
      ]} /></details>
    </section>
    <section className="tab-panel" id="profile-panel-Network" role="tabpanel" aria-labelledby="profile-tab-Network" hidden={tab !== "Network"} tabIndex={0}>
      <NetworkForm profile={profile} connected={context.connected} busy={context.pending} onSave={onSave} onDirtyChange={handleDirtyChange} />
    </section>
    <section className="tab-panel" id="profile-panel-Device" role="tabpanel" aria-labelledby="profile-tab-Device" hidden={tab !== "Device"} tabIndex={0}>
      <KeyValues rows={[
        { label: "Storage mode", value: profile.storage === "native" ? "Native" : "Checkpoint" },
        { label: "Profile directory", value: profileHome, mono: true },
        { label: "Browser data", value: profileHome ? `${profileHome}/${profile.storage === "native" ? "browser-data" : "storage"}/` : null, mono: true },
        { label: "Fingerprint SHA-256", value: profile.fingerprintSha256, mono: true },
        { label: "Engine SHA-256", value: profile.engineSha256, mono: true },
        { label: "Device schema", value: detail.data?.device.version, mono: true },
      ]} />
      <section className="detail-section"><h2>Saved device properties</h2>{detail.loading && !detail.data ? <p className="loading-text" role="status">Loading device properties…</p> : detail.data?.device.properties.length ? <KeyValues rows={detail.data.device.properties.map(({ name, value }) => ({ label: name, value: redact(value), mono: true }))} /> : <p className="empty-inline">No saved device properties. Start the profile after setup to create its device data.</p>}</section>
    </section>
    <section className="tab-panel" id="profile-panel-Logs" role="tabpanel" aria-labelledby="profile-tab-Logs" hidden={tab !== "Logs"} tabIndex={0}>
      <div className="log-tools"><button type="button" className="button" onClick={detail.reload} disabled={detail.loading} title="Last 300 lines per stream"><Icon name="refresh" />{detail.loading ? "Loading…" : "Refresh logs"}</button></div>
      {(["server", "supervisor"] as const).map((stream) => <section className="log-section" key={stream}><h3>{stream === "server" ? "Browser server" : "Supervisor"}</h3><pre className="log-output" tabIndex={0} aria-label={`${stream} log`} aria-busy={detail.loading}>{detail.data ? boundedLog(detail.data.logs[stream]) || `No ${stream} log entries.` : detail.error ? "Logs are unavailable." : "Loading log entries…"}</pre></section>)}
    </section>
  </div>;
}
