import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { UiAction, UiIdentity, UiPhase } from "../src/ui-types";
import type { ActionContext } from "./model";
import { actionLabels, actionReason, phaseLabels, redact } from "./model";

type IconName = "identities" | "diagnostics" | "settings" | "refresh" | "play" | "stop" | "chevron" | "back" | "copy" | "close" | "menu" | "terminal" | "pause" | "power";
const paths: Record<IconName, ReactNode> = {
  identities: <><rect x="3" y="3" width="12" height="10" rx="2" /><path d="M6 17h12a2 2 0 0 0 2-2V7M7 7h4" /></>,
  diagnostics: <><path d="M3 12h4l3-8 4 16 3-8h4" /></>,
  settings: <><path d="m9.5 3-.7 2.2-2 .9-2.2-.5-2 3.4 1.5 1.7v2.5L2.6 15l2 3.4 2.2-.5 2 .9.7 2.2h4l.7-2.2 2-.9 2.2.5 2-3.4-1.5-1.8v-2.5L20.4 9l-2-3.4-2.2.5-2-.9L13.5 3z" /><circle cx="11.5" cy="12" r="3" /></>,
  refresh: <><path d="M19 8a8 8 0 1 0 1 7M19 3v5h-5" /></>,
  play: <path d="m8 5 11 7-11 7z" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="1" />,
  pause: <><path d="M8 5v14M16 5v14" /></>,
  power: <><path d="M12 2v10M5.6 5.6a9 9 0 1 0 12.8 0" /></>,
  chevron: <path d="m9 5 7 7-7 7" />,
  back: <path d="m10 5-7 7 7 7M3 12h18" />,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M15 4H5a1 1 0 0 0-1 1v10" /></>,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  terminal: <><path d="m4 6 6 6-6 6M12 18h8" /></>,
};

export function Icon({ name, className = "" }: { name: IconName; className?: string }) {
  return <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`icon ${className}`}>{paths[name]}</svg>;
}

export function Mark() {
  return <svg className="brand-mark" viewBox="0 0 20 24" width="20" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M3 6h14M3 11h10M3 16h6" /></svg>;
}

export function Phase({ phase }: { phase: UiPhase }) {
  const warning = ["paused", "verification_failed", "blocked", "orphaned", "ownership_unknown", "unclean"].includes(phase);
  return <span className={`phase${warning ? " phase-attention" : ""}${phase === "ready" ? " phase-ready" : ""}`}><span className="status-dot" />{phaseLabels[phase]}</span>;
}

export function Notice({ children, kind = "neutral", alert = false }: { children: ReactNode; kind?: "neutral" | "warning" | "error"; alert?: boolean }) {
  return <div className={`notice notice-${kind}`} role={alert ? "alert" : "status"}>{children}</div>;
}

export function CopyCommand({ command, label = "Copy command" }: { command: string; label?: string }) {
  const [message, setMessage] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const code = useRef<HTMLElement>(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(command);
      setMessage("Copied");
    } catch {
      setMessage("Select the command to copy it.");
      const selection = window.getSelection();
      if (code.current && selection) {
        const range = document.createRange();
        range.selectNodeContents(code.current);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
    timer.current = setTimeout(() => setMessage(""), 3_000);
  };
  return <div className="command-wrap"><div className="command"><code ref={code} tabIndex={0} aria-label="Command">{command}</code><button type="button" className="icon-button" onClick={() => void copy()} aria-label={label} title={label}><Icon name="copy" /></button></div><span className="copy-status" role="status">{message}</span></div>;
}

export function KeyValues({ rows }: { rows: { label: string; value: ReactNode; mono?: boolean }[] }) {
  return <dl className="key-values">{rows.map(({ label, value, mono }) => <div className="key-value" key={label}><dt>{label}</dt><dd className={mono ? "mono" : undefined}>{value ?? <span className="muted">—</span>}</dd></div>)}</dl>;
}

export function ActionButton({ identity, action, context, onAction, showReason = false, compact = false }: {
  identity: UiIdentity; action: UiAction; context: ActionContext;
  onAction: (identity: UiIdentity, action: UiAction) => void; showReason?: boolean; compact?: boolean;
}) {
  const reasonId = useId();
  const reason = actionReason(identity, action, context);
  const icon = action === "start" || action === "resume" ? "play" : action === "stop" ? "stop" : action === "pause" ? "pause" : null;
  return <span className={`action-with-reason${compact ? " compact" : ""}`}>
    <button type="button" className={`button${action === "stop" ? " button-stop" : ""}`} disabled={!!reason} aria-label={`${actionLabels[action]} ${identity.id}`} aria-describedby={reason ? reasonId : undefined} title={reason ?? `${actionLabels[action]} ${identity.id}`} onClick={() => onAction(identity, action)}>
      {icon && <Icon name={icon} />}{actionLabels[action]}
    </button>
    {reason && <span id={reasonId} className={showReason ? "disabled-reason" : "sr-only"}>{reason}</span>}
  </span>;
}

export function Modal({ children, title, onClose, busy = false, className = "" }: { children: ReactNode; title: string; onClose: () => void; busy?: boolean; className?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previousFocus = document.activeElement;
    const node = dialog.current!;
    node.showModal();
    return () => {
      node.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);
  return <dialog ref={dialog} className={`modal ${className}`} aria-labelledby={titleId} aria-busy={busy} onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="modal-heading"><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" aria-label="Close dialog" onClick={onClose} disabled={busy}><Icon name="close" /></button></div>
    {children}
  </dialog>;
}

export function ConfirmAction({ original, identity, action, context, busy, error, onClose, onConfirm }: {
  original: UiIdentity; identity: UiIdentity | undefined; action: "stop" | "release"; context: ActionContext;
  busy: boolean; error: string; onClose: () => void; onConfirm: () => void;
}) {
  const changed = !identity || identity.instanceId !== original.instanceId || (action === "release" && (identity.controller?.pid !== original.controller?.pid || identity.controller?.label !== original.controller?.label));
  const reason = changed ? "The browser or controller changed. Cancel and review the latest identity state." : identity ? actionReason(identity, action, { ...context, pending: false }) : "The identity is no longer configured.";
  return <Modal title={`${action === "stop" ? "Stop" : "Release controller from"} ${original.id}?`} onClose={onClose} busy={busy}>
    <div className="modal-body">{action === "stop"
      ? <p>This closes the browser and its open pages for <strong className="mono">{original.id}</strong>. Saved identity data remains.</p>
      : <p>Release <strong>{redact(original.controller?.label ?? "the controller")}</strong> from <strong className="mono">{original.id}</strong> after current actions finish. The browser and its pages stay open.</p>}
      {reason && !busy && <Notice kind="warning">{reason}</Notice>}
      {error && <Notice kind="error" alert>{error}</Notice>}
      {busy && <p className="muted" role="status">Waiting for the service. Start and stop can take up to 90 seconds.</p>}
    </div>
    <div className="modal-actions"><button type="button" className="button" autoFocus onClick={onClose} disabled={busy}>Cancel</button><button type="button" className={`button ${action === "stop" ? "button-danger" : "button-primary"}`} onClick={onConfirm} disabled={busy || !!reason}>{busy ? "Waiting…" : action === "stop" ? "Stop identity" : "Release controller"}</button></div>
  </Modal>;
}
