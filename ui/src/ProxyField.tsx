import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { MAX_PROXY_INPUT, MAX_PROXY_LIST_BYTES, emptyProxyFields, parseProxyInput, parseProxyList, proxyFromFields } from "../../src/profiles/proxy-input.ts";
import type { ParsedProxy, ProxyFields } from "../../src/profiles/proxy-input.ts";
import { Modal, Notice, Select } from "./components";

export function ProxyField({ value, savedValue, disabled, readOnly = false, help, onChange, onValidityChange }: {
  value: string; savedValue?: string; disabled: boolean; readOnly?: boolean; help?: ReactNode;
  onChange: (value: string) => void; onValidityChange: (valid: boolean) => void;
}) {
  const id = useId(), input = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const [manual, setManual] = useState<ProxyFields | null>(null);
  const [importing, setImporting] = useState(false);
  const parsed = useMemo(() => parseProxyInput(value), [value]);
  const unchanged = savedValue !== undefined && value === savedValue;
  const valid = !manual && !importing && (unchanged || parsed.kind === "proxy" || parsed.kind === "empty");
  useEffect(() => { onValidityChange(valid); }, [valid, onValidityChange]);
  const manualResult = manual ? proxyFromFields(manual) : null;
  const openManual = () => setManual("fields" in parsed && parsed.fields ? { ...parsed.fields } : emptyProxyFields());
  const change = (next: string) => { setManual(null); onChange(next); };
  const apply = () => {
    if (disabled || manualResult?.kind !== "proxy") return;
    // Opening the fields must not replace hidden saved credentials with empty values.
    if (!unchanged || parsed.kind !== "proxy" || JSON.stringify(manualResult.fields) !== JSON.stringify(parsed.fields)) onChange(manualResult.url);
    setManual(null);
    input.current?.focus();
  };
  const preview = !focused && !unchanged && parsed.kind === "proxy";
  const problem = !unchanged && parsed.kind === "invalid" && !focused;

  return <div className="form-field proxy-field">
    <label htmlFor={id}>Proxy <span className="label-note">{readOnly ? "Managed externally" : "Optional"}</span></label>
    <input ref={input} id={id} type={unchanged || preview ? "text" : "password"} value={preview && parsed.kind === "proxy" ? parsed.display : value}
      autoComplete="off" maxLength={MAX_PROXY_INPUT} spellCheck={false} disabled={disabled} readOnly={readOnly}
      placeholder="Paste proxy details" aria-invalid={problem || undefined} aria-describedby={`${id}-help`}
      onFocus={() => setFocused(true)} onBlur={() => { setFocused(false); if (!unchanged && parsed.kind === "invalid" && !readOnly) openManual(); }}
      onChange={event => change(event.target.value)} onPaste={event => {
        if (readOnly || disabled) return;
        event.preventDefault(); change(event.clipboardData.getData("text"));
      }} />
    <div id={`${id}-help`} className="proxy-help">
      {readOnly ? help : <>
        {problem && <p className="field-help inline-attention" role="status">{parsed.message}</p>}
        {!unchanged && parsed.kind === "proxy" && (parsed.assumedProtocol || parsed.fields.username || parsed.fields.password) && <p className="field-help" role="status">{[parsed.assumedProtocol && "HTTP assumed", (parsed.fields.username || parsed.fields.password) && "Credentials hidden"].filter(Boolean).join(" · ")}</p>}
        {!unchanged && (parsed.kind === "link" || parsed.kind === "list") && <p className="field-help" role="status">{parsed.kind === "link" ? "This looks like a download link. Import its file to choose a proxy." : "This contains a list. Choose one proxy to use."}</p>}
        {!manual && <div className="proxy-tools"><button type="button" className="text-button" disabled={disabled} onClick={openManual}>{parsed.kind === "proxy" ? "Edit details" : "Enter manually"}</button><button type="button" className="text-button" disabled={disabled} onClick={() => setImporting(true)}>Import list</button></div>}
      </>}
    </div>
    {manual && !readOnly && <fieldset className="proxy-details" disabled={disabled} onKeyDown={event => { if (event.key === "Enter" && event.target instanceof HTMLInputElement) { event.preventDefault(); apply(); } }}>
      <legend className="sr-only">Proxy details</legend>
      {unchanged && !!value && <p className="field-help">Enter any credentials again when replacing a saved proxy.</p>}
      <div className="proxy-details-grid">
        <div className="form-field"><label htmlFor={`${id}-protocol`}>Protocol</label><Select id={`${id}-protocol`} value={manual.protocol} onChange={event => {
          const protocol = event.target.value as ProxyFields["protocol"];
          const ports = { http: "80", https: "443", socks5: "1080" };
          setManual({ ...manual, protocol, port: manual.port === ports[manual.protocol] ? ports[protocol] : manual.port });
        }}><option value="http">HTTP</option><option value="https">HTTPS</option><option value="socks5">SOCKS5</option></Select></div>
        <div className="form-field"><label htmlFor={`${id}-port`}>Port</label><input id={`${id}-port`} inputMode="numeric" autoComplete="off" value={manual.port} onChange={event => setManual({ ...manual, port: event.target.value })} /></div>
        <div className="form-field proxy-host"><label htmlFor={`${id}-host`}>Host</label><input id={`${id}-host`} autoComplete="off" spellCheck={false} value={manual.host} placeholder="proxy.example.com" onChange={event => setManual({ ...manual, host: event.target.value })} /></div>
        <div className="form-field"><label htmlFor={`${id}-user`}>Username <span className="label-note">Optional</span></label><input id={`${id}-user`} autoComplete="off" spellCheck={false} maxLength={MAX_PROXY_INPUT} value={manual.username} onChange={event => setManual({ ...manual, username: event.target.value })} /></div>
        <div className="form-field"><label htmlFor={`${id}-password`}>Password <span className="label-note">Optional</span></label><input id={`${id}-password`} type="password" autoComplete="new-password" maxLength={MAX_PROXY_INPUT} value={manual.password} onChange={event => setManual({ ...manual, password: event.target.value })} /></div>
      </div>
      {manualResult?.kind === "invalid" && manual.host && <p className="field-help inline-attention" role="status">{manualResult.message}</p>}
      <div className="button-row"><button type="button" className="button" onClick={() => setManual(null)}>Cancel</button><button type="button" className="button" disabled={disabled || manualResult?.kind !== "proxy"} onClick={apply}>Use details</button></div>
    </fieldset>}
    {importing && <ProxyListImport initial={parsed.kind === "list" ? value : ""} link={parsed.kind === "link" ? parsed.url : undefined} disabled={disabled}
      onClose={() => setImporting(false)} onSelect={proxy => { change(proxy.url); setImporting(false); input.current?.focus(); }} />}
  </div>;
}

function ProxyListImport({ initial, link, disabled, onClose, onSelect }: {
  initial: string; link?: string; disabled: boolean; onClose: () => void; onSelect: (proxy: ParsedProxy) => void;
}) {
  const id = useId(), alive = useRef(true), generation = useRef(0);
  const [text, setText] = useState(initial);
  const [selection, setSelection] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const result = useMemo(() => {
    try { return { ...parseProxyList(text), error: "" }; }
    catch (cause) { return { proxies: [], errors: [], error: (cause as Error).message }; }
  }, [text]);
  const choose = () => { const proxy = result.proxies[Number(selection)]; if (!disabled && !loading && selection !== "" && proxy) onSelect(proxy); };
  const paste = (value: string) => { generation.current++; setLoading(false); setError(""); setSelection(""); setText(value); };
  return <Modal title="Import proxy list" onClose={onClose}>
    <div className="modal-body proxy-import" onKeyDown={event => { if (event.key === "Enter" && event.target instanceof HTMLInputElement && event.target.type === "password") { event.preventDefault(); choose(); } }}>
      {link && <p className="field-help"><a className="text-button" href={link} target="_blank" rel="noopener noreferrer">Download the list</a>, then choose the file below.</p>}
      <div className="form-field"><label htmlFor={`${id}-file`}>Proxy file</label><input id={`${id}-file`} type="file" accept=".txt,text/plain" disabled={disabled} onChange={async event => {
        const file = event.target.files?.[0], current = ++generation.current;
        setSelection(""); setText(""); setError("");
        if (!file) { setLoading(false); return; }
        if (file.size > MAX_PROXY_LIST_BYTES) { setLoading(false); setError("Choose a proxy list smaller than 1 MB."); return; }
        setLoading(true);
        try { const contents = await file.text(); if (alive.current && current === generation.current) setText(contents); }
        catch { if (alive.current && current === generation.current) setError("Cannot read this file. Choose a text file with one proxy per line."); }
        finally { if (alive.current && current === generation.current) setLoading(false); }
      }} /></div>
      <div className="form-field"><label htmlFor={`${id}-paste`}>Or paste a list</label><input id={`${id}-paste`} type="password" autoComplete="off" disabled={disabled} value={text} placeholder="One proxy per line" onChange={event => paste(event.target.value)} onPaste={event => { event.preventDefault(); paste(event.clipboardData.getData("text")); }} /></div>
      {loading && <p className="field-help" role="status">Reading list…</p>}
      {(error || result.error) && <Notice kind="error" alert>{error || result.error}</Notice>}
      {!!result.errors.length && <p className="field-help inline-attention" role="status">{result.errors.length} {result.errors.length === 1 ? "line could" : "lines could"} not be read. Line {result.errors[0]!.line}: {result.errors[0]!.message}</p>}
      {!!result.proxies.length && <div className="form-field"><label htmlFor={`${id}-selection`}>Choose proxy <span className="label-note">{result.proxies.length} available</span></label><Select id={`${id}-selection`} value={selection} disabled={disabled || loading} onChange={event => setSelection(event.target.value)}><option value="">Select a proxy</option>{result.proxies.map((proxy, index) => <option key={index} value={index}>{index + 1}. {proxy.display}{proxy.fields.username || proxy.fields.password ? " · Authenticated" : ""}{proxy.assumedProtocol ? " · HTTP assumed" : ""}</option>)}</Select></div>}
      {!!text && !loading && !result.proxies.length && !result.errors.length && !result.error && <p className="field-help" role="status">No proxies found. Use one proxy per line.</p>}
    </div>
    <div className="modal-actions"><button type="button" className="button" onClick={onClose}>Cancel</button><button type="button" className="button button-primary" disabled={disabled || loading || selection === "" || !result.proxies[Number(selection)]} onClick={choose}>Use proxy</button></div>
  </Modal>;
}
