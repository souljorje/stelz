import { useState } from "react";
import type { TypingMode, UiProfile, UiTypingUpdate } from "../../../packages/stelz/src/api/contracts.ts";
import { errorMessage } from "./api.ts";
import { Notice } from "./components";

const help: Record<TypingMode, string> = {
  auto: "Paced typing for up to 10 seconds. Longer text is entered instantly.",
  keyboard: "Send individual keystrokes without artificial delays.",
  instant: "Enter the complete text at once.",
};
type Selection = TypingMode | "inherit";

export function TypingForm({ profile, connected, busy, onSave }: {
  profile: UiProfile; connected: boolean; busy: boolean;
  onSave: (id: string, update: UiTypingUpdate) => Promise<UiProfile>;
}) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const preference = profile.typing.mode ?? "inherit";
  const selected = selection ?? preference;
  const mode = selected === "inherit" ? profile.typing.defaultMode : selected;
  const pending = busy || !!profile.pendingAction;
  const id = `typing-${profile.id}`;
  const change = async (next: Selection) => {
    if (next === preference || !connected || pending || selection) return;
    setSelection(next); setError(""); setSaved(false);
    try {
      await onSave(profile.id, { revision: profile.typing.revision, mode: next === "inherit" ? null : next });
      setSaved(true);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setSelection(null); }
  };
  return <section className="detail-section typing-section" aria-labelledby={`${id}-heading`}>
    <h2 className="sr-only" id={`${id}-heading`}>Typing</h2>
    <div className="form-field">
      <label htmlFor={id}>Default typing mode</label>
      <select id={id} value={selected} disabled={!connected || pending || !!selection} aria-describedby={`${id}-help ${id}-status`}
        onChange={event => void change(event.target.value as Selection)}>
        <option value="inherit">Service default ({profile.typing.defaultMode})</option>
        <option value="auto">Automatic</option><option value="keyboard">Keyboard input</option><option value="instant">Instant input</option>
      </select>
      <p className="field-help" id={`${id}-help`}>{help[mode]}</p>
      <p className="field-help" id={`${id}-status`} role="status">{selection ? "Saving typing mode…" : !connected ? "Reconnect to change the typing mode." : pending ? "Wait for the current service action to finish." : saved ? "Typing mode saved. Applies to future typing actions." : ""}</p>
    </div>
    {error && <Notice kind="error" alert>{error}</Notice>}
  </section>;
}
