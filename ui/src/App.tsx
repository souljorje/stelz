import { useCallback, useEffect, useRef, useState } from "react";
import type { UiAction, UiProfile, UiProfileRename, UiNetworkUpdate, UiTypingUpdate } from "../../src/api/contracts.ts";
import { errorMessage } from "./api.ts";
import { ConfirmAction, CopyCommand, Icon, Mark, Modal, Notice } from "./components";
import { ProfileDetail } from "./ProfileDetail";
import { ProfileNameEditor } from "./ProfileNameEditor";
import { CreateProfile, DeleteProfile } from "./ProfileDialogs";
import { actionLabels, actionReason, dateTime, homeCommand } from "./model.ts";
import type { ActionContext } from "./model.ts";
import { Diagnostics, FirstRun, Profiles, Settings } from "./screens";
import { FRESH_FOR, useNow, useService } from "./use-service.ts";
import { useTheme } from "./use-theme.ts";
import { ProfileMark } from "./ProfileMark";
import type { ShowProfileWindow } from "../../src/api/contracts.ts";

type Page = "profiles" | "diagnostics" | "settings";
type Route = { page: Page; profileId?: string };
const destinations = [{ page: "profiles", label: "Profiles" }, { page: "diagnostics", label: "Diagnostics" }, { page: "settings", label: "Settings" }] as const;

export function App({ session }: { session: Promise<void> }) {
  const service = useService(session);
  const theme = useTheme();
  const now = useNow();
  const [route, setRoute] = useState<Route>({ page: "profiles" });
  const [menuOpen, setMenuOpen] = useState(false);
  const [networkDirty, setNetworkDirty] = useState(false);
  const [renameDirty, setRenameDirty] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const dirty = networkDirty || renameDirty;
  const [nextRoute, setNextRoute] = useState<Route | null>(null);
  const [confirmation, setConfirmation] = useState<{ profile: UiProfile; action: "stop" | "release" } | null>(null);
  const [confirmationError, setConfirmationError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [deletion, setDeletion] = useState<UiProfile | null>(null);
  const [confirmShutdown, setConfirmShutdown] = useState(false);
  const [restartCommand, setRestartCommand] = useState("stelz ui");
  const [feedback, setFeedback] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const snapshot = service.snapshot;
  const stale = service.lastGood > 0 && now - service.lastGood >= FRESH_FOR;
  const connected = service.connection === "connected" && !stale && !document.hidden;
  const selected = snapshot?.profiles.find((row) => row.id === route.profileId);
  const title = selected?.name ?? route.profileId ?? destinations.find((item) => item.page === route.page)!.label;
  const context: ActionContext | null = snapshot ? { snapshot, connected, pending: !!service.pending } : null;

  useEffect(() => { document.title = `${service.connection === "ended" ? "UI turned off" : title} · stelz`; }, [title, service.connection]);
  const go = (next: Route) => {
    setRoute(next); setNetworkDirty(false); setRenameDirty(false); setRenaming(false); setNextRoute(null); setMenuOpen(false); setFeedback(null);
    requestAnimationFrame(() => heading.current?.focus());
  };
  const navigate = (next: Route) => {
    if (next.page === route.page && next.profileId === route.profileId) { setMenuOpen(false); return; }
    if (dirty) setNextRoute(next); else go(next);
  };
  const requestAction = (profile: UiProfile, action: UiAction) => {
    if (!context) return;
    const reason = actionReason(profile, action, context);
    if (reason) { setFeedback(reason); return; }
    setFeedback(null);
    if (action === "stop" || action === "release") {
      setConfirmationError(""); setConfirmation({ profile, action });
    } else void perform(profile, action);
  };
  const perform = async (profile: UiProfile, action: UiAction) => {
    try {
      await service.mutate(profile.id, action);
      setFeedback(null);
      setConfirmation(null);
    } catch (cause) {
      if (action === "stop" || action === "release") setConfirmationError(errorMessage(cause));
      else setFeedback(errorMessage(cause));
    }
  };
  const showWindow = (id: string, selection?: ShowProfileWindow) => {
    setFeedback(null);
    void service.showWindow(id, selection).catch(cause => setFeedback(errorMessage(cause)));
  };
  const saveNetwork = useCallback((id: string, update: UiNetworkUpdate) => service.mutate(id, "save", update), [service.mutate]);
  const saveTyping = useCallback((id: string, update: UiTypingUpdate) => service.mutate(id, "typing", update), [service.mutate]);
  const saveName = useCallback((id: string, update: UiProfileRename) => service.mutate(id, "rename", update), [service.mutate]);
  const cancelRename = () => { setRenaming(false); setRenameDirty(false); requestAnimationFrame(() => heading.current?.focus()); };
  const turnOff = async () => {
    setRestartCommand(snapshot ? homeCommand("ui", snapshot.home) : "stelz ui");
    try { await service.endSession(); setConfirmShutdown(false); }
    catch (cause) { setConfirmShutdown(false); setFeedback(errorMessage(cause)); }
  };
  const nav = (mobile = false) => <nav aria-label={mobile ? "Main navigation menu" : "Main navigation"}>{destinations.map((item) => <button type="button" key={item.page} className={`nav-item${route.page === item.page ? " is-active" : ""}`} aria-current={route.page === item.page ? "page" : undefined} onClick={() => navigate({ page: item.page })}>{item.label}</button>)}</nav>;
  const ending = service.connection === "ending";

  if (service.connection === "ended") return <main className="ui-ended"><div className="ui-ended-content"><Mark /><h1>UI turned off</h1><p>Running browsers stay open.</p><CopyCommand command={restartCommand} /></div></main>;

  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <header className="topbar">
      <div className="topbar-navigation">
        <div className="brand"><Mark /><span>stelz</span></div>
        <div className="desktop-navigation">{nav()}</div>
        <button type="button" className="icon-button menu-toggle" aria-label="Open navigation" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}><Icon name="menu" /></button>
      </div>
      <button type="button" className="icon-button ui-power-button" aria-label="Turn off UI" title={service.pending ? "Wait for the current UI operation." : "Turn off UI"} disabled={!!service.pending || ending || service.connection === "connecting" || service.connection === "unauthorized"} onClick={() => { if (dirty) setConfirmShutdown(true); else void turnOff(); }}><Icon name="power" /></button>
    </header>
    <div className="workspace">
      <main id="main-content" className="main-content" tabIndex={-1}>
        <div className="page-heading"><div className="page-heading-title"><h1 className={renaming ? "sr-only" : undefined} ref={heading} tabIndex={-1} title={title}>{selected && <ProfileMark id={selected.id} />}<span>{title}</span></h1>{selected && !renaming && <button type="button" className="icon-button rename-profile-button" aria-label="Rename profile" title="Rename profile" disabled={!connected || !!service.pending || ending} onClick={() => setRenaming(true)}><Icon name="edit" /></button>}{selected && snapshot && renaming && <ProfileNameEditor profile={selected} revision={snapshot.catalogRevision} connected={connected} busy={!!service.pending} onDirtyChange={setRenameDirty} onCancel={cancelRename} onSave={async update => { await saveName(selected.id, update); cancelRename(); }} />}</div><div className="page-heading-actions">{route.page === "profiles" && <button type="button" className="icon-button" onClick={() => void service.refresh()} aria-label="Refresh service state" title={snapshot ? `Updated ${dateTime(snapshot.updatedAt)}` : "Refresh service state"} disabled={service.refreshing || !!service.pending || service.connection === "connecting" || service.connection === "unauthorized" || ending}><Icon name="refresh" /></button>}{route.page === "profiles" && !route.profileId && snapshot?.initialized && <button type="button" className="button button-primary" disabled={!connected || !!service.pending} onClick={() => setCreateOpen(true)}>New profile</button>}</div></div>
        {service.connection === "unauthorized" && <Notice kind="warning"><span>Open a fresh local URL from <code>stelz ui</code> to connect. An existing valid session works across tabs.</span><CopyCommand command="stelz ui" /></Notice>}
        {(service.connection === "offline" || stale) && <Notice kind="warning"><span>{service.connection === "offline" ? service.error || "The local service is disconnected." : "The state is stale."} {snapshot ? `Last service update: ${dateTime(snapshot.updatedAt)}. Existing values remain visible. Changes are disabled until state refreshes.` : "Start the local UI with stelz ui."}</span><button type="button" className="text-button" onClick={() => void service.refresh()} disabled={service.refreshing}>{service.refreshing ? "Connecting…" : "Retry connection"}</button></Notice>}
        {feedback && <Notice kind="error" alert><span>{feedback}</span><button type="button" className="icon-button" aria-label="Dismiss message" onClick={() => setFeedback(null)}><Icon name="close" /></button></Notice>}
        {service.pending && <Notice><span>Waiting for {service.pending.id}: {service.pending.action === "rename" ? "save name" : service.pending.action === "typing" ? "save typing mode" : service.pending.action === "show" ? "show window" : service.pending.action === "save" ? "save network" : service.pending.action === "create" || service.pending.action === "delete" ? service.pending.action : actionLabels[service.pending.action].toLowerCase()}.{(service.pending.action === "start" || service.pending.action === "stop") && " Start and stop can take up to 90 seconds."}</span></Notice>}
        {!snapshot && service.connection === "connecting" && <div className="loading-console" role="status"><div className="loading-labels"><span>Profile</span><span>Browser phase</span><span>Controller</span></div><div className="loading-row" /><div className="loading-row" /><p>Connecting to the local service…</p></div>}
        {snapshot && context && <>
          {route.page === "profiles" && (!snapshot.initialized ? <FirstRun snapshot={snapshot} /> : route.profileId ? selected ? <ProfileDetail key={selected.id} profile={selected} snapshot={snapshot} context={context} mutationVersion={service.mutationVersion} onAction={requestAction} onShow={showWindow} onSave={saveNetwork} onTypingSave={saveTyping} onBack={() => navigate({ page: "profiles" })} onDirtyChange={setNetworkDirty} onDelete={setDeletion} /> : <div className="empty-inline"><p>This profile is no longer configured.</p><button type="button" className="button" onClick={() => navigate({ page: "profiles" })}>All profiles</button></div> : <>{!snapshot.setup && <FirstRun snapshot={snapshot} />}<Profiles snapshot={snapshot} context={context} onInspect={(id) => navigate({ page: "profiles", profileId: id })} onAction={requestAction} onShow={showWindow} /></>)}
          {route.page === "diagnostics" && <Diagnostics snapshot={snapshot} mutationVersion={service.mutationVersion} />}
          {route.page === "settings" && <Settings snapshot={snapshot} theme={theme.preference} onThemeChange={theme.change} />}
        </>}
      </main>
    </div>
    {menuOpen && <Modal title="stelz · Local service" className="navigation-modal" onClose={() => setMenuOpen(false)}>{nav(true)}<p className="field-help">{window.location.host}</p></Modal>}
    {confirmation && context && <ConfirmAction original={confirmation.profile} profile={snapshot?.profiles.find((row) => row.id === confirmation.profile.id)} action={confirmation.action} context={context} busy={!!service.pending} error={confirmationError} onClose={() => { if (!service.pending) setConfirmation(null); }} onConfirm={() => void perform(confirmation.profile, confirmation.action)} />}
    {createOpen && snapshot && <CreateProfile snapshot={snapshot} connected={connected} busy={!!service.pending} onClose={() => setCreateOpen(false)} onCreate={async input => {
      await service.changeCatalog("create", input);
      setCreateOpen(false); go({ page: "profiles", profileId: input.id });
    }} />}
    {deletion && context && <DeleteProfile original={deletion} profile={snapshot?.profiles.find(row => row.id === deletion.id)} context={context} busy={!!service.pending} onClose={() => setDeletion(null)} onDelete={async (id, revision) => {
      await service.changeCatalog("delete", { id, revision });
      setDeletion(null); go({ page: "profiles" });
    }} />}
    {nextRoute && <Modal title="Discard unsaved changes?" onClose={() => setNextRoute(null)}><div className="modal-body"><p>Your unsaved changes for <strong>{selected?.name ?? route.profileId}</strong> will be discarded.</p></div><div className="modal-actions"><button type="button" className="button" autoFocus onClick={() => setNextRoute(null)}>Keep editing</button><button type="button" className="button button-primary" onClick={() => go(nextRoute)}>Discard edits and leave</button></div></Modal>}
    {confirmShutdown && <Modal title="Discard edits and turn off UI?" busy={ending} onClose={() => setConfirmShutdown(false)}><div className="modal-body"><p>Your unsaved changes will be discarded. Browser profiles stay open.</p></div><div className="modal-actions"><button type="button" className="button" autoFocus disabled={ending} onClick={() => setConfirmShutdown(false)}>Keep editing</button><button type="button" className="button button-primary" disabled={ending || !!service.pending} onClick={() => void turnOff()}>{ending ? "Turning off…" : "Discard edits and turn off UI"}</button></div></Modal>}
  </div>;
}
