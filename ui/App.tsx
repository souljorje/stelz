import { useCallback, useEffect, useRef, useState } from "react";
import type { UiAction, UiIdentity, UiNetworkUpdate } from "../src/ui-types";
import { errorMessage } from "./api";
import { ConfirmAction, CopyCommand, Icon, Mark, Modal, Notice } from "./components";
import { IdentityDetail } from "./IdentityDetail";
import { CreateIdentity, DeleteIdentity } from "./IdentityDialogs";
import { actionLabels, actionReason, dateTime, homeCommand } from "./model";
import type { ActionContext } from "./model";
import { Diagnostics, FirstRun, Identities, Settings } from "./screens";
import { FRESH_FOR, useNow, useService } from "./use-service";

type Page = "identities" | "diagnostics" | "settings";
type Route = { page: Page; identityId?: string };
const destinations = [{ page: "identities", label: "Identities", icon: "identities" }, { page: "diagnostics", label: "Diagnostics", icon: "diagnostics" }, { page: "settings", label: "Settings", icon: "settings" }] as const;

export function App({ session }: { session: Promise<void> }) {
  const service = useService(session);
  const now = useNow();
  const [route, setRoute] = useState<Route>({ page: "identities" });
  const [menuOpen, setMenuOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [nextRoute, setNextRoute] = useState<Route | null>(null);
  const [confirmation, setConfirmation] = useState<{ identity: UiIdentity; action: "stop" | "release" } | null>(null);
  const [confirmationError, setConfirmationError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [deletion, setDeletion] = useState<UiIdentity | null>(null);
  const [confirmShutdown, setConfirmShutdown] = useState(false);
  const [restartCommand, setRestartCommand] = useState("stelz ui");
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const snapshot = service.snapshot;
  const stale = service.lastGood > 0 && now - service.lastGood >= FRESH_FOR;
  const connected = service.connection === "connected" && !stale && !document.hidden;
  const selected = snapshot?.identities.find((row) => row.id === route.identityId);
  const title = route.identityId ?? destinations.find((item) => item.page === route.page)!.label;
  const context: ActionContext | null = snapshot ? { snapshot, connected, pending: !!service.pending } : null;

  useEffect(() => { document.title = `${service.connection === "ended" ? "UI turned off" : title} · stelz`; }, [title, service.connection]);
  const go = (next: Route) => {
    setRoute(next); setDirty(false); setNextRoute(null); setMenuOpen(false); setFeedback(null);
    requestAnimationFrame(() => heading.current?.focus());
  };
  const navigate = (next: Route) => {
    if (next.page === route.page && next.identityId === route.identityId) { setMenuOpen(false); return; }
    if (dirty) setNextRoute(next); else go(next);
  };
  const requestAction = (identity: UiIdentity, action: UiAction) => {
    if (!context) return;
    const reason = actionReason(identity, action, context);
    if (reason) { setFeedback({ text: reason, error: true }); return; }
    setFeedback(null);
    if (action === "stop" || action === "release") {
      setConfirmationError(""); setConfirmation({ identity, action });
    } else void perform(identity, action);
  };
  const perform = async (identity: UiIdentity, action: UiAction) => {
    try {
      await service.mutate(identity.id, action);
      setFeedback({ text: `${identity.id}: ${actionLabels[action]} completed.`, error: false });
      setConfirmation(null);
    } catch (cause) {
      if (action === "stop" || action === "release") setConfirmationError(errorMessage(cause));
      else setFeedback({ text: errorMessage(cause), error: true });
    }
  };
  const saveNetwork = useCallback((id: string, update: UiNetworkUpdate) => service.mutate(id, "save", update), [service.mutate]);
  const turnOff = async () => {
    setRestartCommand(snapshot ? homeCommand("ui", snapshot.home) : "stelz ui");
    try { await service.endSession(); setConfirmShutdown(false); }
    catch (cause) { setConfirmShutdown(false); setFeedback({ text: errorMessage(cause), error: true }); }
  };
  const nav = (mobile = false) => <nav aria-label={mobile ? "Main navigation menu" : "Main navigation"}>{destinations.map((item) => <button type="button" key={item.page} className={`nav-item${route.page === item.page ? " is-active" : ""}`} aria-current={route.page === item.page ? "page" : undefined} onClick={() => navigate({ page: item.page })}><Icon name={item.icon} />{item.label}</button>)}</nav>;
  const connectionLabel = service.connection === "ending" ? "Turning off" : service.connection === "unauthorized" ? "Session required" : service.connection === "connecting" ? "Connecting" : service.connection === "offline" ? "Disconnected" : stale ? "State is stale" : "Connected";
  const ending = service.connection === "ending";

  if (service.connection === "ended") return <main className="ui-ended"><div className="ui-ended-content"><Mark /><h1>UI turned off</h1><p>Running browsers stay open.</p><p>Run this command to start a new UI session.</p><CopyCommand command={restartCommand} /><p className="field-help">Open the new session URL printed in the terminal.</p></div></main>;

  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <aside className="sidebar" aria-label="stelz navigation"><div className="brand"><Mark /><span>stelz</span><span className="brand-scope">local</span></div>{nav()}<div className="sidebar-footer"><span className="mono">{window.location.host}</span><span>Browsers persist after UI close</span></div></aside>
    <div className="workspace"><header className="topbar"><div className="topbar-title"><button type="button" className="icon-button menu-toggle" aria-label="Open navigation" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}><Icon name="menu" /></button><span className="mobile-brand">stelz</span><h1 ref={heading} tabIndex={-1}>{title}</h1>{route.page === "identities" && !route.identityId && snapshot && <span className="header-count">{snapshot.identities.length}</span>}</div><div className="topbar-status"><span className={`connection${connected ? "" : " connection-warning"}`} title={service.lastGood ? `Last received ${dateTime(new Date(service.lastGood).toISOString())}` : "No state received yet"}><span className="status-dot" />{connectionLabel}</span><span className="freshness">{snapshot ? `Updated ${dateTime(snapshot.updatedAt)}` : "Waiting for state"}</span><button type="button" className="icon-button" onClick={() => void service.refresh()} aria-label="Refresh service state" title="Refresh service state" disabled={service.refreshing || !!service.pending || service.connection === "connecting" || service.connection === "unauthorized" || ending}><Icon name="refresh" /></button><button type="button" className="button ui-power-button" aria-label="Turn off UI" title={service.pending ? "Wait for the current UI operation." : "Turn off UI"} disabled={!!service.pending || ending || service.connection === "connecting" || service.connection === "unauthorized"} onClick={() => { if (dirty) setConfirmShutdown(true); else void turnOff(); }}><Icon name="power" /><span>Turn off UI</span></button></div></header>
      <main id="main-content" className="main-content" tabIndex={-1}>
        {service.connection === "unauthorized" && <Notice kind="warning"><span>Open a fresh local URL from <code>stelz ui</code> to connect. An existing valid session works across tabs.</span><CopyCommand command="stelz ui" /></Notice>}
        {(service.connection === "offline" || stale) && <Notice kind="warning"><span>{service.connection === "offline" ? service.error || "The local service is disconnected." : "The state is stale."} {snapshot ? `Last service update: ${dateTime(snapshot.updatedAt)}. Existing values remain visible. Changes are disabled until state refreshes.` : "Start the local UI with stelz ui."}</span><button type="button" className="text-button" onClick={() => void service.refresh()} disabled={service.refreshing}>{service.refreshing ? "Connecting…" : "Retry connection"}</button></Notice>}
        {feedback && <Notice kind={feedback.error ? "error" : "neutral"} alert={feedback.error}><span>{feedback.text}</span><button type="button" className="icon-button" aria-label="Dismiss message" onClick={() => setFeedback(null)}><Icon name="close" /></button></Notice>}
        {service.pending && <Notice><span>Waiting for {service.pending.id}: {service.pending.action === "save" ? "save network" : service.pending.action === "create" || service.pending.action === "delete" ? service.pending.action : actionLabels[service.pending.action].toLowerCase()}. Start and stop can take up to 90 seconds.</span></Notice>}
        {!snapshot && service.connection === "connecting" && <div className="loading-console" role="status"><div className="loading-labels"><span>Identity</span><span>Browser phase</span><span>Controller</span></div><div className="loading-row" /><div className="loading-row" /><p>Connecting to the local service…</p></div>}
        {snapshot && context && <>
          {route.page === "identities" && (!snapshot.initialized ? <FirstRun snapshot={snapshot} /> : route.identityId ? selected ? <IdentityDetail key={selected.id} identity={selected} snapshot={snapshot} context={context} mutationVersion={service.mutationVersion} onAction={requestAction} onSave={saveNetwork} onBack={() => navigate({ page: "identities" })} onDirtyChange={setDirty} onDelete={setDeletion} /> : <div className="empty-inline"><p>This identity is no longer configured.</p><button type="button" className="button" onClick={() => navigate({ page: "identities" })}>All identities</button></div> : <>{!snapshot.setup && <FirstRun snapshot={snapshot} />}<Identities snapshot={snapshot} context={context} onInspect={(id) => navigate({ page: "identities", identityId: id })} onAction={requestAction} onCreate={() => setCreateOpen(true)} /></>)}
          {route.page === "diagnostics" && <Diagnostics snapshot={snapshot} mutationVersion={service.mutationVersion} />}
          {route.page === "settings" && <Settings snapshot={snapshot} />}
        </>}
      </main>
    </div>
    {menuOpen && <Modal title="stelz · Local service" className="navigation-modal" onClose={() => setMenuOpen(false)}>{nav(true)}<p className="field-help">{window.location.host}</p></Modal>}
    {confirmation && context && <ConfirmAction original={confirmation.identity} identity={snapshot?.identities.find((row) => row.id === confirmation.identity.id)} action={confirmation.action} context={context} busy={!!service.pending} error={confirmationError} onClose={() => { if (!service.pending) setConfirmation(null); }} onConfirm={() => void perform(confirmation.identity, confirmation.action)} />}
    {createOpen && snapshot && <CreateIdentity snapshot={snapshot} connected={connected} busy={!!service.pending} onClose={() => setCreateOpen(false)} onCreate={async input => {
      await service.changeCatalog("create", input);
      setCreateOpen(false); go({ page: "identities", identityId: input.id });
      setFeedback({ text: `${input.id} created. Start it when you need it.`, error: false });
    }} />}
    {deletion && context && <DeleteIdentity original={deletion} identity={snapshot?.identities.find(row => row.id === deletion.id)} context={context} busy={!!service.pending} onClose={() => setDeletion(null)} onDelete={async (id, revision) => {
      await service.changeCatalog("delete", { id, revision });
      setDeletion(null); go({ page: "identities" });
      setFeedback({ text: `${id} deleted. Its saved profile was archived in ${snapshot!.home}/trash/.`, error: false });
    }} />}
    {nextRoute && <Modal title="Discard unsaved network edits?" onClose={() => setNextRoute(null)}><div className="modal-body"><p>Your unsaved network edits for <strong className="mono">{route.identityId}</strong> will be discarded.</p></div><div className="modal-actions"><button type="button" className="button" autoFocus onClick={() => setNextRoute(null)}>Keep editing</button><button type="button" className="button button-primary" onClick={() => go(nextRoute)}>Discard edits and leave</button></div></Modal>}
    {confirmShutdown && <Modal title="Discard edits and turn off UI?" busy={ending} onClose={() => setConfirmShutdown(false)}><div className="modal-body"><p>Your unsaved network edits will be discarded. Browser identities stay open.</p></div><div className="modal-actions"><button type="button" className="button" autoFocus disabled={ending} onClick={() => setConfirmShutdown(false)}>Keep editing</button><button type="button" className="button button-primary" disabled={ending || !!service.pending} onClick={() => void turnOff()}>{ending ? "Turning off…" : "Discard edits and turn off UI"}</button></div></Modal>}
  </div>;
}
