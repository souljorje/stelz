import { useCallback, useState } from "react";
import type { KeyboardEvent } from "react";
import type { UiAction, UiProfile, UiProfileDetail, UiNetworkUpdate, UiTypingUpdate, UiSnapshot } from "../../src/api/contracts.ts";
import { profilePath } from "./api.ts";
import { ActionButton, CopyCommand, Icon, KeyValues, Notice, Phase } from "./components";
import { NetworkForm } from "./NetworkForm";
import { TypingForm } from "./TypingForm";
import { actionReason, locationLabel, homeCommand, boundedLog, dateTime, deleteReason, profileAttention, profileCommand, mcpCommand, redact } from "./model.ts";
import type { ActionContext } from "./model.ts";
import { useResource } from "./use-service.ts";
import { ProfileWindows, type ShowWindow } from "./ProfileWindows";
import { exportUnavailable } from "./use-transfer.ts";

const tabs = ["Overview", "Device", "Logs"] as const;
type Tab = typeof tabs[number];

export function ProfileDetail({ profile, snapshot, context, mutationVersion, onAction, onSave, onTypingSave, onBack, onDirtyChange, onDelete, onShow, onExport, exportDisabled = false }: {
  profile: UiProfile; snapshot: UiSnapshot; context: ActionContext; mutationVersion: number;
  onAction: (profile: UiProfile, action: UiAction) => void;
  onSave: (id: string, update: UiNetworkUpdate) => Promise<UiProfile>;
  onTypingSave: (id: string, update: UiTypingUpdate) => Promise<UiProfile>;
  onDelete: (profile: UiProfile) => void;
  onBack: () => void; onDirtyChange: (dirty: boolean) => void;
  onShow: ShowWindow;
  onExport: (profile: UiProfile) => void; exportDisabled?: boolean;
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
  const actions = (["start", "pause", "resume", "recheck", "release", "stop"] as const).filter(action => !(action === "recheck" && profile.phase === "stopped")).filter(action => action === "start" && ["stopped", "unclean"].includes(profile.phase) || !actionReason(profile, action, context));
  const canDelete = !deleteReason(profile, context) && !networkDirty;
  const exportReason = exportDisabled || networkDirty ? "Save or discard your edits before exporting." : !context.connected ? "Refresh the connection before exporting." : context.pending ? "Wait for the current UI operation." : exportUnavailable(profile);

  return <div className="detail-view">
    <div className="detail-context"><button type="button" className="text-button" onClick={onBack}><Icon name="back" />All profiles</button><span className="detail-context-right"><Phase phase={profile.phase} />{profile.phase === "stopped" && <button type="button" className="text-button profile-export-shortcut" title={exportReason ?? undefined} disabled={!!exportReason} onClick={() => onExport(profile)}>Export ZIP</button>}{canDelete && <button type="button" className="text-button delete-profile" onClick={() => onDelete(profile)}>Delete profile</button>}</span></div>
    <div className="tabs" role="tablist" aria-label={`Details for ${profile.name}`}>{tabs.map((name, index) => <button key={name} type="button" role="tab" id={`profile-tab-${name}`} aria-controls={`profile-panel-${name}`} aria-selected={tab === name} tabIndex={tab === name ? 0 : -1} onClick={() => selectTab(name)} onKeyDown={(event) => keyTab(event, index)}>{name}{name === "Overview" && networkDirty && <span className="dirty-dot" aria-label="Unsaved network changes" />}</button>)}</div>
    {detail.error && <Notice kind="error"><span>{detail.error} {detail.data ? "Previously loaded details remain visible." : "Profile state remains available."}</span><button type="button" className="text-button" onClick={detail.reload} disabled={detail.loading}>Retry details</button></Notice>}
    <section className="tab-panel" id="profile-panel-Overview" role="tabpanel" aria-labelledby="profile-tab-Overview" hidden={tab !== "Overview"} tabIndex={0}>
      {attention && <Notice kind="warning">{attention}</Notice>}
      {needsDoctor && <div className="recovery-commands"><p className="field-help">Inspect configuration and process ownership in a terminal.</p><CopyCommand command={profileCommand("doctor", profile.id, snapshot.home)} />{profile.phase === "unclean" && <><p className="field-help">Inspect any remaining browser processes. After the recorded processes exit, archive this lifetime.</p><CopyCommand command={profileCommand("recover", profile.id, snapshot.home)} /></>}</div>}
      {actions.length > 0 ? <div className="lifecycle-toolbar" role="group" aria-label="Browser lifecycle actions">{actions.map(action => <ActionButton key={action} profile={profile} action={action} context={context} onAction={onAction} primary={action === "start" || action === "resume"} disabledReason={action === "start" && networkDirty ? "Save or discard network changes before starting." : undefined} />)}</div> : profile.phase === "stopped" && <p className="unavailable-actions field-help">{actionReason(profile, "start", context)}</p>}
      <section className="detail-section" aria-label="Location alignment">
        <h2>Location alignment</h2>
        <p role="status"><strong>{locationLabel(profile)}</strong></p>
        <p className="field-help">{profile.location?.message ?? "Start checks this profile before launching its browser."}</p>
        {profile.location?.checkedAt && <p className="field-help">Checked {dateTime(profile.location.checkedAt)}. {profile.location.valid ? "Applies to the current configuration." : "Check again for the current configuration."}</p>}
        {profile.location?.timezone && <KeyValues rows={[{ label: "Timezone", value: profile.location.timezone }, { label: "Language policy", value: profile.location.language }]} />}
        {profile.phase === "stopped" && profile.network.proxyEnv && <button type="button" className="button" disabled={networkDirty || !!actionReason(profile, "recheck", context)} onClick={() => onAction(profile, "recheck")}>{profile.location?.status === "checking" ? "Checking…" : profile.location?.status === "blocked" ? "Check again" : "Check connection"}</button>}
        {profile.location?.nextAction?.kind === "run_setup" && <CopyCommand command={homeCommand("setup", snapshot.home)} />}
        {profile.location?.nextAction?.kind === "edit_proxy" && <button type="button" className="text-button" onClick={() => document.getElementById("profile-network-heading")?.scrollIntoView({ block: "center" })}>Edit proxy below</button>}
        {profile.location?.code && <details className="disclosure"><summary>Technical details</summary><p>{profile.location.code} · {profile.location.phase}</p>
          {profile.location.observed && <KeyValues rows={[{ label: "Browser timezone", value: profile.location.observed.timezone }, { label: "Browser locale", value: profile.location.observed.locale }, { label: "Browser languages", value: profile.location.observed.languages.join(", ") }]} />}
        </details>}
      </section>
      {profile.controller && <KeyValues rows={[{ label: "Controller", value: redact(profile.controller.label) }]} />}
      <section className="detail-section network-section" aria-labelledby="profile-network-heading"><h2 id="profile-network-heading" className={profile.phase === "stopped" ? "sr-only" : undefined}>Connection</h2><NetworkForm profile={profile} connected={context.connected} busy={context.pending} onSave={onSave} onDirtyChange={handleDirtyChange} /></section>
      <TypingForm profile={profile} connected={context.connected} busy={context.pending} onSave={onTypingSave} />
      {tab === "Overview" && ["ready", "paused", "verification_failed"].includes(profile.phase) && <ProfileWindows profile={profile} context={context} mutationVersion={mutationVersion} onShow={onShow} />}
      <section className="detail-section">
        <h2>Connect via MCP</h2>
        <p className="field-help">Register this command once for all profiles. Pass the profile ID in tool arguments.</p>
        <CopyCommand command={redact(detail.data?.mcpCommand ?? mcpCommand(profile.id, snapshot.home))} label="Copy shared MCP command" />
        <KeyValues rows={[{ label: "Profile ID for tools", value: profile.id, mono: true }]} />
        <p className="field-help">Call profile_acquire with this profile ID. Use its controlHandle with this ID for browser actions.</p>
      </section>
    </section>
    <section className="tab-panel" id="profile-panel-Device" role="tabpanel" aria-labelledby="profile-tab-Device" hidden={tab !== "Device"} tabIndex={0}>
      <KeyValues rows={[
        { label: "Profile ID", value: profile.id, mono: true },
        { label: "Endpoint", value: `127.0.0.1:${profile.port}`, mono: true },
        { label: "Storage", value: "Native" },
        { label: "Profile directory", value: profileHome, mono: true },
        { label: "Browser data", value: profileHome ? `${profileHome}/${profile.storage === "native" ? "browser-data" : "storage"}/` : null, mono: true },
        { label: "Fingerprint SHA-256", value: profile.fingerprintSha256, mono: true },
        { label: "Engine SHA-256", value: profile.engineSha256, mono: true },
        { label: "Device schema", value: detail.data?.device.version, mono: true },
        { label: "Last IP check", value: dateTime(profile.checkedAt) },
        ...(profile.controller ? [{ label: "Controller PID", value: profile.controller.pid, mono: true }, { label: "Active actions", value: profile.controller.activeActions }] : []),
      ]} />
      <section className="detail-section"><h2>Saved device properties</h2>{detail.loading && !detail.data ? <p className="loading-text" role="status">Loading device properties…</p> : detail.data?.device.properties.length ? <KeyValues rows={detail.data.device.properties.map(({ name, value }) => ({ label: name, value: redact(value), mono: true }))} /> : <p className="empty-inline">No saved device properties. Start the profile after setup to create its device data.</p>}</section>
    </section>
    <section className="tab-panel" id="profile-panel-Logs" role="tabpanel" aria-labelledby="profile-tab-Logs" hidden={tab !== "Logs"} tabIndex={0}>
      <div className="log-tools"><button type="button" className="button" onClick={detail.reload} disabled={detail.loading} title="Last 300 lines per stream"><Icon name="refresh" />{detail.loading ? "Loading…" : "Refresh logs"}</button></div>
      {(["server", "supervisor"] as const).map((stream) => <section className="log-section" key={stream}><h3>{stream === "server" ? "Browser server" : "Supervisor"}</h3><pre className="log-output" tabIndex={0} aria-label={`${stream} log`} aria-busy={detail.loading}>{detail.data ? boundedLog(detail.data.logs[stream]) || `No ${stream} log entries.` : detail.error ? "Logs are unavailable." : "Loading log entries…"}</pre></section>)}
    </section>
  </div>;
}
