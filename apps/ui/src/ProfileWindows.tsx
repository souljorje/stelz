import type { UiProfile } from "../../../packages/stelz/src/api/contracts.ts";
import type { ProfileWindows as Windows, ShowProfileWindow } from "../../../packages/stelz/src/api/contracts.ts";
import type { ActionContext } from "./model.ts";
import { profilePath } from "./api.ts";
import { Icon, Notice } from "./components";
import { useNow, useResource } from "./use-service.ts";

export type ShowWindow = (id: string, selection?: ShowProfileWindow) => void;

export function ShowWindowButton({ profile, context, onShow, compact = false }: { profile: UiProfile; context: ActionContext; onShow: ShowWindow; compact?: boolean }) {
  if (!["ready", "paused", "verification_failed"].includes(profile.phase)) return null;
  const label = "Show window for " + profile.name;
  const reason = !context.connected ? "Reconnect before showing a window."
    : context.pending || profile.pendingAction ? "Wait for the current operation."
    : !profile.windowControls.available ? profile.windowControls.reason || "Window controls are unavailable."
    : null;
  return <span data-row-control title={reason || label}><button type="button" className={compact ? "icon-button show-window-button" : "button"} aria-label={label} disabled={!!reason} onClick={() => onShow(profile.id)}><Icon name="window" />{!compact && "Show window"}</button></span>;
}

export function ProfileWindows({ profile, context, mutationVersion, onShow }: {
  profile: UiProfile; context: ActionContext; mutationVersion: number; onShow: ShowWindow;
}) {
  const now = useNow();
  const running = ["ready", "paused", "verification_failed"].includes(profile.phase);
  const enabled = running && context.connected;
  const result = useResource<Windows>(profilePath(profile.id) + "/windows",
    profile.instanceId + ":" + profile.phase + ":" + mutationVersion + ":" + Math.floor(now / 5_000), enabled);
  const data = result.data?.instanceId === profile.instanceId ? result.data : null;
  const canShow = enabled && profile.windowControls.available && !context.pending && !profile.pendingAction && !result.error && data?.available;
  return <section className="detail-section profile-windows" aria-label="Browser windows">
    <div className="section-heading"><h2>Browser windows{data?.available && <span className="window-count">{data.windows.length}</span>}</h2>
      {running && <button type="button" className="icon-button" aria-label="Refresh browser windows" disabled={!context.connected || result.loading || context.pending} onClick={result.reload}><Icon name="refresh" /></button>}
    </div>
    {!running ? <p className="field-help">Start this profile to see its windows. Each window will use the same profile label and color.</p>
      : result.error ? <Notice kind="warning"><span>{result.error}</span></Notice>
      : !data ? <p className="loading-text" role="status">{context.connected ? "Loading browser windows…" : "Reconnect to see this profile’s browser windows."}</p>
      : !data.available ? <p className="field-help">{data.reason}</p>
      : <>
        {data.reason && <Notice kind="warning">{data.reason}</Notice>}
        {!data.windows.length && <p className="field-help">This profile has no browser windows.</p>}
        {data.windows.map((window, index) => <section className="browser-window" key={window.id} aria-label={"Window " + (index + 1)}>
          <div className="browser-window-heading"><span>Window {index + 1}<span className="window-state">{window.state === "minimized" ? "Minimized" : window.focused ? "Focused" : window.tabs.length + (window.tabs.length === 1 ? " page" : " pages")}</span></span>
            <button type="button" className="text-button" disabled={!canShow} onClick={() => onShow(profile.id, { instanceId: data.instanceId!, windowId: window.id })}>Show window</button></div>
          <ul className="window-pages">{window.tabs.map(tab => <li key={tab.id}><button type="button" className="window-page" disabled={!canShow} title={tab.title || tab.url || "Blank page"}
            aria-label={"Show " + (tab.title || tab.url || "blank page") + " in " + profile.name}
            onClick={() => onShow(profile.id, { instanceId: data.instanceId!, windowId: window.id, tabId: tab.id })}>
            <Icon name="window" /><span className="window-page-copy"><span>{tab.title || "Untitled page"}</span><small>{tab.url.replace(/^https?:\/\//, "") || "Address unavailable"}</small></span>
            {tab.active && <span className="window-page-active">Active</span>}
          </button></li>)}</ul>
        </section>)}
        {profile.controller && <p className="field-help window-control-note">Showing a window keeps the current controller. Pause the profile before manual work.</p>}
      </>}
  </section>;
}
