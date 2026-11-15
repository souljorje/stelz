import { useState } from "react";
import type { UiProfile, UiScriptsUpdate } from "../../src/api/contracts.ts";
import { errorMessage } from "./api.ts";
import { Notice } from "./components";

export function ScriptsForm({ profile, connected, busy, onSave }: {
  profile: UiProfile; connected: boolean; busy: boolean;
  onSave: (id: string, update: UiScriptsUpdate) => Promise<UiProfile>;
}) {
  const [selection, setSelection] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const selected = selection ?? profile.allowScripts;
  const pending = busy || !!profile.pendingAction;
  const id = `scripts-${profile.id}`;
  const change = async (next: boolean) => {
    if (next === profile.allowScripts || !connected || pending || selection !== null) return;
    setSelection(next); setError(""); setSaved(false);
    try {
      await onSave(profile.id, { allow: next });
      setSaved(true);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setSelection(null); }
  };
  return <section className="detail-section scripts-section" aria-labelledby={`${id}-heading`}>
    <h2 className="sr-only" id={`${id}-heading`}>Scripts</h2>
    <div className="form-field">
      <label className="check-label" htmlFor={id}>
        <input id={id} type="checkbox" checked={selected} disabled={!connected || pending || selection !== null} aria-describedby={`${id}-help ${id}-status`}
          onChange={event => void change(event.target.checked)} />Allow scripts
      </label>
      <p className="field-help" id={`${id}-help`}>Lets an agent run JavaScript in pages of this profile with tab_evaluate and tab_init_script. Only you can change this setting. MCP cannot. Turning it off keeps scripts that tab_init_script already registered until their tab closes.</p>
      <p className="field-help" id={`${id}-status`} role="status">{selection !== null ? "Saving scripts setting…" : !connected ? "Reconnect to change the scripts setting." : pending ? "Wait for the current service action to finish." : saved ? "Scripts setting saved. Applies to the next call." : ""}</p>
    </div>
    {error && <Notice kind="error" alert>{error}</Notice>}
  </section>;
}
