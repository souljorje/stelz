import { useEffect, useId, useState } from "react";
import type { FormEvent } from "react";
import type { UiProfile, UiProfileRename } from "../../src/api/contracts.ts";
import { ApiError, errorMessage } from "./api.ts";
import { Icon, Notice } from "./components";

export function ProfileNameEditor({ profile, revision, connected, busy, onSave, onCancel, onDirtyChange }: {
  profile: UiProfile; revision: string; connected: boolean; busy: boolean;
  onSave: (input: UiProfileRename) => Promise<void>; onCancel: () => void; onDirtyChange: (dirty: boolean) => void;
}) {
  const id = useId();
  const [baseline, setBaseline] = useState({ name: profile.name, revision });
  const [name, setName] = useState(profile.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const dirty = name.trim() !== baseline.name;
  const disabled = !connected || busy || saving;
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (disabled || conflict || !dirty || !name.trim()) return;
    setSaving(true); setError("");
    try { await onSave({ name: name.trim(), revision: baseline.revision }); }
    catch (cause) { setError(errorMessage(cause)); setConflict(cause instanceof ApiError && cause.status === 409); }
    finally { setSaving(false); }
  };
  const reload = () => {
    setBaseline({ name: profile.name, revision }); setName(profile.name); setConflict(false); setError("");
  };
  return <form className="profile-name-editor" aria-label="Rename profile" onSubmit={event => void submit(event)} onKeyDown={event => {
    if (event.key === "Escape" && !saving && !busy) { event.preventDefault(); onCancel(); }
  }}>
    <div className="profile-name-editor-row"><label className="sr-only" htmlFor={id}>Profile name</label><input id={id} autoFocus required maxLength={80} value={name} disabled={disabled} autoComplete="off" spellCheck={false} aria-describedby={`${id}-help`} onChange={event => setName(event.target.value)} />
      <button type="submit" className="icon-button" aria-label="Save profile name" title="Save name" disabled={disabled || conflict || !dirty || !name.trim()}><Icon name="check" /></button><button type="button" className="icon-button" aria-label="Cancel rename" title="Cancel rename" disabled={busy || saving} onClick={onCancel}><Icon name="close" /></button></div>
    <p className="field-help" id={`${id}-help`}>Profile ID stays <code>{profile.id}</code>.</p>
    {error && <Notice kind="error" alert><span>{error}</span>{conflict && <button type="button" className="text-button" disabled={disabled} onClick={reload}>Load current name</button>}</Notice>}
  </form>;
}
