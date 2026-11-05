import { assessRebrowser } from "./rebrowser-verdict.ts";

export type SiteId = "fingerprint-web-scraping" | "fingerprint-playground" | "pixelscan" | "rebrowser";
export type Verdict = "PASS" | "FAIL" | "INCONCLUSIVE" | "UNSUPPORTED" | "ERROR";
export type Assessment = { verdict: Verdict; reason: string; details: Record<string, string>; warnings?: string[] };

type Node = {
  role: string;
  text: string;
  index: number;
  end: number;
  indent: number;
  parent?: Node;
  ignored: boolean;
  busy: boolean;
};
type Field = { label: string; value: string; index: number; busy: boolean };

const SIGNALS = [
  "Incognito Mode", "Bot", "VPN", "Browser Tampering", "Developer Tools", "Virtual Machine",
  "Privacy Settings", "IP Blocklist", "Proxy Detection", "High-Activity Device", "Rare Device",
];
const CHECKS = ["Browser", "Location", "Proxy", "Fingerprint", "Bot"];
const FLIGHT_FIELDS = ["Departure", "Arrival", "Price per adult", "Total"];
const VALUE_ROLES = new Set(["text", "generic", "paragraph", "heading", "status", "alert", "term", "definition"]);
const CELL_ROLES = new Set(["cell", "gridcell", "rowheader", "columnheader"]);

function clean(text: string): string {
  return text.normalize("NFKC").replace(/[‘’]/g, "'").replace(/[‐‑‒–—]/g, "-").replace(/\s+/g, " ").trim();
}

function key(text: string): string {
  return clean(text).toLowerCase().replace(/[.!?:]+$/, "").trim();
}

function quoted(text: string): { value: string; end: number } | undefined {
  const match = /^("(?:\\.|[^"\\])*"|'(?:''|[^'])*')/.exec(text);
  if (!match) return;
  const token = match[0];
  if (token[0] === "'") return { value: token.slice(1, -1).replace(/''/g, "'"), end: token.length };
  try { return { value: JSON.parse(token), end: token.length }; }
  catch { return { value: token.slice(1, -1), end: token.length }; }
}

function documentation(text: string): boolean {
  return /^(?:learn more|how to use this demo|json responses?|what websites see about you|faq|faqs|frequently asked questions(?: \(faq\))?|(?:sample|example)(?: json| response| responses| result| results| output| code)*)$/.test(key(text));
}

// Read ARIA entries, not text that merely resembles a result inside a YAML scalar.
function parse(snapshot: string): Node[] {
  const nodes: Node[] = [];
  const stack: Node[] = [];
  let blockIndent: number | undefined;
  let documentationLevel: number | undefined;
  for (const line of snapshot.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const indent = /^\s*/.exec(line)![0].length;
    if (blockIndent !== undefined) {
      if (indent > blockIndent) continue;
      blockIndent = undefined;
    }
    const entry = /^\s*-\s+(.+)$/.exec(line);
    if (!entry) continue;
    let source = entry[1]!;
    const outer = quoted(source);
    if (outer && /^\s*:/.test(source.slice(outer.end))) source = outer.value + source.slice(outer.end);
    const role = /^([a-z][\w-]*)(?=\s|:|$)/.exec(source)?.[1];
    if (!role) continue;
    const rest = source.slice(role.length).trim();
    const scalar = rest.startsWith(":") ? rest.slice(1).trim() : undefined;
    const text = clean(scalar !== undefined ? (quoted(scalar)?.value ?? scalar) : (quoted(rest)?.value ?? ""));
    const literal = scalar !== undefined && /^[|>][+-]?$/.test(scalar);
    if (literal) blockIndent = indent;
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop()!.end = nodes.length;
    const parent = stack[stack.length - 1];
    if (role === "heading") {
      const level = Number(/\[level=(\d+)\]/.exec(rest)?.[1] ?? 1);
      if (documentationLevel !== undefined && level <= documentationLevel) documentationLevel = undefined;
      if (documentation(text)) documentationLevel = Math.min(documentationLevel ?? level, level);
    }
    const node: Node = {
      role, text, index: nodes.length, end: 0, indent, parent,
      ignored: !!parent?.ignored || documentationLevel !== undefined || literal ||
        /^(?:code|pre|tooltip)$/.test(role) || /^[{[]/.test(text) ||
        (/^(?:region|group|generic|paragraph|text)$/.test(role) && documentation(text)),
      busy: !!parent?.busy || /\[busy(?:=true)?\]/.test(rest),
    };
    nodes.push(node);
    stack.push(node);
  }
  for (const node of stack) node.end = nodes.length;
  return nodes;
}

function section(nodes: Node[], start: string, stop: RegExp, textMarker = false): Node[] | undefined {
  let first = -1;
  for (const node of nodes) {
    if (!node.ignored && key(node.text) === key(start) &&
      (node.role === "heading" || node.role === "region" || (textMarker && /^(?:text|generic)$/.test(node.role)))) first = node.index;
  }
  if (first < 0) return;
  let last = nodes.length;
  for (let i = first + 1; i < nodes.length; i++) {
    const node = nodes[i]!;
    if (/^(?:heading|region|generic|text|link)$/.test(node.role) && stop.test(key(node.text))) { last = i; break; }
  }
  return nodes.slice(first + 1, last).filter(node => !node.ignored);
}

function splitField(text: string, labels: string[], spaceSeparator = true): { label: string; value: string } | undefined {
  const normalized = clean(text);
  const lower = normalized.toLowerCase();
  for (const label of labels) {
    const name = label.toLowerCase();
    const rest = lower.slice(name.length);
    if (lower === name || (lower.startsWith(name) && (spaceSeparator ? /^[\s:|\-]/ : /^\s*[:|]/).test(rest))) {
      return { label, value: normalized.slice(name.length).replace(/^[\s:|\-]+/, "").trim() };
    }
  }
}

function cellText(cell: Node, nodes: Node[]): string {
  return cell.text || nodes.filter(node => node.index > cell.index && node.index < cell.end &&
    !node.ignored && VALUE_ROLES.has(node.role) && node.text).map(node => node.text).join(" ");
}

function fields(nodes: Node[], labels: string[], options: { rowsOnly?: boolean; valueFirst?: boolean; spaceSeparator?: boolean } = {}): Field[] {
  const result: Field[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    if (node.role === "row") {
      const cells = nodes.filter(child => child.index > node.index && child.index < node.end && CELL_ROLES.has(child.role));
      const label = splitField(cells.length ? cellText(cells[0]!, nodes) : node.text, labels);
      if (label) result.push({ ...label,
        value: label.value || (cells[1] ? cellText(cells[1], nodes) : ""), index: node.index,
        busy: node.busy || cells.some(cell => cell.busy),
      });
      while (i + 1 < nodes.length && nodes[i + 1]!.index < node.end) i++;
      continue;
    }
    if (options.rowsOnly || !VALUE_ROLES.has(node.role)) continue;
    const label = splitField(node.text, labels, options.spaceSeparator ?? false);
    if (!label) continue;
    let value = label.value;
    let busy = node.busy;
    if (!value) {
      const step = options.valueFirst ? -1 : 1;
      for (let j = i + step; j >= 0 && j < nodes.length; j += step) {
        const next = nodes[j]!;
        if (splitField(next.text, labels, options.spaceSeparator ?? false) || next.role === "row") break;
        if (VALUE_ROLES.has(next.role) && next.text) { value = next.text; busy ||= next.busy; break; }
      }
    }
    result.push({ label: label.label, value, index: node.index, busy });
  }
  return result;
}

function detailsFor(observed: Field[]): Record<string, string> {
  const details: Record<string, string> = {};
  for (const field of observed) details[field.label] = details[field.label] === undefined ? field.value : `${details[field.label]} | ${field.value}`;
  return details;
}

function assessment(verdict: Verdict, reason: string, details: Record<string, string> = {}, warnings: string[] = []): Assessment {
  return { verdict, reason, details, ...(warnings.length ? { warnings } : {}) };
}

function humanChallenge(nodes: Node[]): string | undefined {
  const visible = nodes.filter(node => !node.ignored);
  const verification = /^(?:please )?(?:verify (?:that )?you(?: are|'re) (?:a )?human|verify (?:that )?you(?: are|'re) not a (?:robot|bot)|confirm (?:that )?you(?: are|'re) (?:a )?human|human verification|complete (?:the )?(?:captcha|security check)|authentication required|sign in to continue|log in to continue|verify your profile|enter (?:your |the )?(?:verification|authentication|security|one-time) code)$/;
  const action = visible.some(node => /^(?:button|checkbox)$/.test(node.role) && /^(?:verify|continue|submit|i'm not a robot|i am not a robot|i am human)$/.test(key(node.text)));
  for (const node of visible) {
    const name = key(node.text);
    if (/^(?:heading|dialog|alert)$/.test(node.role) && verification.test(name)) return `Human action required: ${node.text}`;
    if (node.role === "checkbox" && /^(?:i'm not a robot|i am not a robot|i am human|verify you are human)$/.test(name)) return `Human verification required: ${node.text}`;
    if (node.role === "iframe" && /^(?:recaptcha|hcaptcha|(?:widget containing a )?cloudflare security challenge)$/.test(name)) return `Human verification required: ${node.text}`;
    if (node.role === "textbox" && /^(?:captcha|captcha code|verification code|authentication code|one-time (?:code|password)|security code)$/.test(name)) return `Human authentication required: ${node.text}`;
    if (/^(?:text|generic|paragraph|status)$/.test(node.role) &&
      (/^verifying you are human(?:\. this may take a few seconds)?$/.test(name) || (action && verification.test(name)))) return `Human verification required: ${node.text}`;
    if (/^(?:heading|form|dialog)$/.test(node.role) && /^(?:sign in|log in|login|two-factor authentication|multi-factor authentication)$/.test(name)) {
      const inputs = visible.some(input => input.role === "textbox" &&
        /^(?:email(?: address)?|username|password|verification code|one-time (?:code|password))$/.test(key(input.text)) &&
        (node.role === "heading" || (input.index > node.index && input.index < node.end)));
      if (inputs) return `Human authentication required: ${node.text}`;
    }
  }
}

export function detectHumanChallenge(snapshot: string): string | undefined {
  return humanChallenge(parse(snapshot));
}

function binary(field: Field): "clear" | "detected" | "unknown" {
  if (field.busy) return "unknown";
  const value = key(field.value.replace(/^[\p{S}\uFE0F\u200D\s]+|[\p{S}\uFE0F\u200D\s]+$/gu, ""));
  const label = key(field.label);
  if (["no", "false", "not detected", "not a bot", "you are not a bot", `${label} not detected`, `no ${label} detected`].includes(value)) return "clear";
  if (["yes", "true", "detected", "you are a bot", "bot detected", "automation detected", "tampering detected", `${label} detected`].includes(value)) return "detected";
  if (field.label === "Proxy Detection" && /^your ip is used by (?:a |an )?(?:residential|public|datacenter|data center|mobile) proxy(?: \(confidence: (?:low|medium|high), ml score: [\d.]+\))?$/.test(value)) return "detected";
  return "unknown";
}

function playground(nodes: Node[]): Assessment {
  const scope = section(nodes, "SMART SIGNALS", /^(?:mobile smart signals|how to use this demo|json responses?)$/);
  if (!scope) return assessment("INCONCLUSIVE", "The desktop SMART SIGNALS section is absent.");
  const observed = fields(scope, SIGNALS, { rowsOnly: true });
  const details = detailsFor(observed);
  const advisory = (field: Field) => field.label === "Proxy Detection" && binary(field) === "detected"
    && /\(confidence: low, ml score: [\d.]+\)$/i.test(field.value);
  const warnings = observed.filter(advisory).map(field => field.label + ": " + field.value);
  const detected = observed.find(field => binary(field) === "detected" && !advisory(field));
  if (detected) return assessment("FAIL", `${detected.label} reports detection.`, details, warnings);
  const missing = SIGNALS.filter(label => !observed.some(field => field.label === label));
  const unknown = observed.filter(field => binary(field) === "unknown").map(field => field.label);
  if (missing.length) details.missingSignals = missing.join(", ");
  if (unknown.length) details.unknownSignals = unknown.join(", ");
  if (missing.length || unknown.length || scope.some(node => node.busy || pending(node.text))) {
    return assessment("INCONCLUSIVE", "Desktop SMART SIGNALS are incomplete or unknown.", details, warnings);
  }
  return assessment("PASS", warnings.length ? "Desktop SMART SIGNALS pass with a low-confidence proxy warning."
    : "All 11 desktop SMART SIGNALS report no detection.", details, warnings);
}

function pending(text: string): boolean {
  return /^(?:(?:loading|scanning|checking|initializing)(?: (?:your |the )?(?:browser|fingerprint|location|proxy|bot|scan|results|data)(?: results| checks)?)?|pending|in progress|please wait|not started|waiting for results)[\s.!…]*$/.test(clean(text).toLowerCase());
}

function adverse(text: string): boolean {
  const value = key(text);
  return /^(?:(?:your )?browser fingerprint is (?:inconsistent|not consistent|suspicious|masked)|(?:browser |location |fingerprint )?(?:mismatch|masking|tampering|inconsistency|automation|automated behavior|bot(?:-like)?(?: behavior)?) detected|(?:vpn(?: or proxy)?|proxy) detected|(?:browser|location|fingerprint) (?:is )?(?:inconsistent|suspicious)|you are (?:a bot|using a (?:proxy|vpn))|warning(?:[!:] .*)?|headless(?:chrome| browser).*)$/.test(value);
}

function pixelscan(nodes: Node[]): Assessment {
  const scope = section(nodes, "Fingerprint Scan", /^(?:what websites see about you|faq|faqs|frequently asked questions(?: \(faq\))?)$/, true);
  if (!scope) return assessment("INCONCLUSIVE", "The Fingerprint Scan summary is absent.");
  const labels = ["Browser", "Location", "Proxy", "Fingerprint", "Bot check", "Bot"];
  const values = scope.filter(node => VALUE_ROLES.has(node.role) && node.text);
  const firstLabel = values.findIndex(node => {
    const field = splitField(node.text, labels, false);
    return field && !field.value;
  });
  const previous = values[firstLabel - 1];
  // The native cards can put each value before its label.
  const valueFirst = !!previous && !splitField(previous.text, labels, false) &&
    !/^your browser fingerprint is /.test(key(previous.text)) && key(previous.text) !== "fingerprint checks";
  const observed = fields(scope, labels, { valueFirst }).map(field => ({ ...field, label: field.label === "Bot check" ? "Bot" : field.label }));
  const details = detailsFor(observed);
  const headlines = scope.filter(node => VALUE_ROLES.has(node.role) && /^your browser fingerprint is /.test(key(node.text)));
  const warning = observed.find(field => adverse(field.value));
  const negative = scope.find(node => VALUE_ROLES.has(node.role) && adverse(node.text));
  if (warning || negative) {
    details.warning = warning?.value ?? negative!.text;
    return assessment("FAIL", "The native scan summary reports an adverse result.", details);
  }
  const consistent = headlines.some(node => key(node.text) === "your browser fingerprint is consistent");
  if (consistent) details.headline = "Your Browser Fingerprint is consistent";
  const clear = (field: Field): boolean => {
    const value = clean(field.value);
    if (field.busy || /\b(?:unknown|unavailable|undefined|null|error|loading)\b|n\/a/i.test(value)) return false;
    switch (field.label) {
      case "Browser": return /^(?:(?:google|microsoft) )?(?:chrome|chromium|firefox|safari|edge|opera|brave|vivaldi|samsung internet)\s+\d[\d.]*\s+on\s+\S.+$/i.test(value);
      case "Location": {
        const places = value.split("/").map(part => part.trim());
        return places.length === 2 && places.every(place => /^[\p{L}\p{N}][\p{L}\p{M}\p{N}\p{P} ]*$/u.test(place));
      }
      case "Proxy": return key(value) === "no proxy detected";
      case "Fingerprint": return key(value) === "no masking detected";
      case "Bot": return key(value) === "no automated behavior detected";
      default: return false;
    }
  };
  const missing = CHECKS.filter(label => !observed.some(field => field.label === label));
  if (missing.length) details.missingChecks = missing.join(", ");
  if (!consistent || missing.length || observed.some(field => !clear(field)) || scope.some(node => node.busy || pending(node.text))) {
    return assessment("INCONCLUSIVE", "The scan summary is incomplete or unknown.", details);
  }
  return assessment("PASS", "The fingerprint is consistent and all five native checks are clear.", details);
}

function money(value: string): boolean {
  return /(?:[$€£₾₽¥₹₩₺₫฿]|\b(?:USD|EUR|GBP|GEL|RUB|JPY|CNY|INR|CAD|AUD|CHF|TRY|AED))\s*\d[\d,.]*|\d[\d,.]*\s*(?:[$€£₾₽¥₹₩₺₫฿]|\b(?:USD|EUR|GBP|GEL|RUB|JPY|CNY|INR|CAD|AUD|CHF|TRY|AED)\b)/i.test(value);
}

function flightCard(observed: Field[]): boolean {
  return FLIGHT_FIELDS.every(label => {
    const field = observed.find(field => field.label === label);
    if (!field || field.busy || !field.value || pending(field.value) || /^(?:unknown|n\/a|select|choose|example|sample)\b/i.test(field.value)) return false;
    return label === "Price per adult" || label === "Total" ? money(field.value) : true;
  });
}

function flights(nodes: Node[]): Assessment {
  const scope = section(nodes, "Search for today's flights", /^learn more$/);
  if (!scope) return assessment("INCONCLUSIVE", "The flight result section is absent.");
  const messages = scope.filter(node => VALUE_ROLES.has(node.role));
  const denied = messages.find(node => /^(?:(?:error|result|status): )?(?:you are a bot|bot detected|automation detected|browser tampering detected|tampering detected|access denied|access blocked|request blocked|suspicious activity detected)(?:[.!]|[!:] .*)?$/.test(clean(node.text).toLowerCase()));
  if (denied) return assessment("FAIL", "The flight result reports bot detection, tampering, or denied access.", { result: denied.text });
  const error = messages.find(node => /^(?:error|(?:network|application|server|internal server) error|service unavailable|request timed out|(?:failed|unable) to (?:load|fetch|retrieve)(?: (?:the )?(?:flights|results|data))?|something went wrong|an error occurred)(?:[.!]|[.:] .*)?$/.test(clean(node.text).toLowerCase()));
  if (error) return assessment("ERROR", "The flight result reports an operational error.", { error: error.text });
  if (scope.some(node => node.busy || pending(node.text))) return assessment("INCONCLUSIVE", "The flight results are still loading.");
  const observed = fields(scope, FLIGHT_FIELDS, { spaceSeparator: true });
  for (let i = 0; i < observed.length; i++) {
    if (observed[i]!.label !== "Departure") continue;
    let end = i + 1;
    while (end < observed.length && observed[end]!.label !== "Departure") end++;
    let container = scope.find(node => node.index === observed[i]!.index)?.parent;
    while (container && !/^(?:article|listitem|group)$/.test(container.role)) container = container.parent;
    const card = observed.slice(i, end).filter(field => !container || (field.index > container.index && field.index < container.end));
    if (flightCard(card)) return assessment("PASS", "A rendered flight card contains routes and prices.", detailsFor(card));
  }
  for (const node of scope) {
    if (!/^(?:article|listitem|group|row|text|generic|paragraph)$/.test(node.role) || node.busy) continue;
    const card = /^Departure[: ]+(.+?)\s+Arrival[: ]+(.+?)\s+Price per adult[: ]+(.+?)\s+Total[: ]+(.+)$/i.exec(node.text);
    if (!card) continue;
    const values = FLIGHT_FIELDS.map((label, i) => ({ label, value: card[i + 1]!, index: node.index, busy: false }));
    if (flightCard(values)) return assessment("PASS", "A rendered flight card contains routes and prices.", detailsFor(values));
  }
  return assessment("INCONCLUSIVE", "No complete rendered flight card is present.", detailsFor(observed));
}

export function assessSite(site: SiteId, snapshot: string): Assessment {
  const nodes = parse(snapshot);
  const challenge = humanChallenge(nodes);
  if (challenge) return assessment("INCONCLUSIVE", challenge, { challenge });
  switch (site) {
    case "fingerprint-web-scraping": return flights(nodes);
    case "fingerprint-playground": return playground(nodes);
    case "pixelscan": return pixelscan(nodes);
    case "rebrowser": return assessRebrowser(snapshot);
  }
}
