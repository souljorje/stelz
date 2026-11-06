import { useEffect, useId, useRef, useState } from "react";
import type { ComponentProps, ReactNode } from "react";
import type { UiAction, UiProfile, UiPhase } from "../../src/api/contracts.ts";
import type { ActionContext } from "./model.ts";
import { actionLabels, actionReason, phaseLabels, redact } from "./model.ts";

type IconName = "refresh" | "play" | "stop" | "back" | "copy" | "close" | "menu" | "pause" | "power" | "window" | "edit" | "check" | "chevron-down";
const paths: Record<IconName, ReactNode> = {
  "chevron-down": <path d="m6 9 6 6 6-6" />,
  edit: <><path d="m15 4 5 5M4 20l5-1L21 7a2.1 2.1 0 0 0-4-4L5 15z" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  window: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M7 6.5h.01M10 6.5h.01" /></>,
  refresh: <><path d="M19 8a8 8 0 1 0 1 7M19 3v5h-5" /></>,
  play: <path d="m8 5 11 7-11 7z" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="1" />,
  pause: <><path d="M8 5v14M16 5v14" /></>,
  power: <><path d="M12 2v10M5.6 5.6a9 9 0 1 0 12.8 0" /></>,
  back: <path d="m10 5-7 7 7 7M3 12h18" />,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M15 4H5a1 1 0 0 0-1 1v10" /></>,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
};

export function Icon({ name, className = "" }: { name: IconName; className?: string }) {
  return <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`icon ${className}`}>{paths[name]}</svg>;
}

export function Select({ className = "", children, ...props }: ComponentProps<"select">) {
  return <div className={`select-control ${className}`}><select {...props}>{children}</select><Icon name="chevron-down" /></div>;
}

export function Mark({ full = false }: { full?: boolean }) {
  return <span className={`brand-mark${full ? " brand-mark-full" : ""}`} aria-hidden="true" />;
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

export function ActionButton({ profile, action, context, onAction, compact = false, primary = false, disabledReason }: {
  profile: UiProfile; action: UiAction; context: ActionContext;
  onAction: (profile: UiProfile, action: UiAction) => void; compact?: boolean; primary?: boolean; disabledReason?: string;
}) {
  const reasonId = useId();
  const reason = disabledReason ?? actionReason(profile, action, context);
  const icon = action === "start" || action === "resume" ? "play" : action === "stop" ? "stop" : action === "pause" ? "pause" : null;
  return <span className={`action-with-reason${compact ? " compact" : ""}`} data-row-control title={reason ?? undefined}>
    <button type="button" className={`button${action === "stop" ? " button-stop" : ""}${primary ? " button-primary" : ""}`} disabled={!!reason} aria-label={`${actionLabels[action]} ${profile.name}`} aria-describedby={reason ? reasonId : undefined} title={reason ?? `${actionLabels[action]} ${profile.name}`} onClick={() => onAction(profile, action)}>
      {icon && <Icon name={icon} />}{actionLabels[action]}
    </button>
    {reason && <span id={reasonId} className="sr-only">{reason}</span>}
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

export function ConfirmAction({ original, profile, action, context, busy, error, onClose, onConfirm }: {
  original: UiProfile; profile: UiProfile | undefined; action: "stop" | "release"; context: ActionContext;
  busy: boolean; error: string; onClose: () => void; onConfirm: () => void;
}) {
  const changed = !profile || profile.instanceId !== original.instanceId || (action === "release" && (profile.controller?.pid !== original.controller?.pid || profile.controller?.label !== original.controller?.label));
  const reason = changed ? "The browser or controller changed. Cancel and review the latest profile state." : profile ? actionReason(profile, action, { ...context, pending: false }) : "The profile is no longer configured.";
  return <Modal title={`${action === "stop" ? "Stop" : "Release controller from"} ${original.name}?`} onClose={onClose} busy={busy}>
    <div className="modal-body">{action === "stop"
      ? <p>This closes the browser and its open pages for <strong>{original.name}</strong>. Saved profile data remains.</p>
      : <p>Release <strong>{redact(original.controller?.label ?? "the controller")}</strong> from <strong>{original.name}</strong> after current actions finish. The browser and its pages stay open.</p>}
      {reason && !busy && <Notice kind="warning">{reason}</Notice>}
      {error && <Notice kind="error" alert>{error}</Notice>}
      {busy && <p className="muted" role="status">Waiting for the service. Start and stop can take up to 90 seconds.</p>}
    </div>
    <div className="modal-actions"><button type="button" className="button" autoFocus onClick={onClose} disabled={busy}>Cancel</button><button type="button" className={`button ${action === "stop" ? "button-danger" : "button-primary"}`} onClick={onConfirm} disabled={busy || !!reason}>{busy ? "Waiting…" : action === "stop" ? "Stop profile" : "Release controller"}</button></div>
  </Modal>;
}
