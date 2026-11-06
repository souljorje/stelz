import { validateProxy } from "./proxy-url.ts";

export const MAX_PROXY_INPUT = 8192;
export const MAX_PROXY_LIST_BYTES = 1024 * 1024;
export type ProxyProtocol = "http" | "https" | "socks5";
export type ProxyFields = { protocol: ProxyProtocol; host: string; port: string; username: string; password: string };
export const emptyProxyFields = (): ProxyFields => ({ protocol: "http", host: "", port: "80", username: "", password: "" });
export type ParsedProxy = { kind: "proxy"; url: string; display: string; fields: ProxyFields; assumedProtocol: boolean };
export type ProxyInput = ParsedProxy | { kind: "empty" } | { kind: "link"; url: string }
  | { kind: "list" } | { kind: "invalid"; message: string; fields?: ProxyFields };
const defaults: Record<ProxyProtocol, string> = { http: "80", https: "443", socks5: "1080" };
const invalid = (message: string, fields?: ProxyFields): ProxyInput => ({ kind: "invalid", message, ...(fields ? { fields } : {}) });
const encode = (text: string) => encodeURIComponent(text).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const controls = /[\p{Cc}\p{Bidi_Control}\u2028\u2029]/u;

export function proxyFromFields(fields: ProxyFields, assumedProtocol = false): ProxyInput {
  const { protocol, username, password } = fields;
  let host = fields.host.trim();
  const port = fields.port.trim();
  if (!Object.hasOwn(defaults, protocol)) return invalid("Choose HTTP, HTTPS, or SOCKS5.", fields);
  if (!host || /[\s/@?#\\%]/u.test(host) || controls.test(host)) return invalid("Enter the proxy host without a URL or path.", fields);
  if (host.includes(":") && !host.startsWith("[")) host = `[${host}]`;
  if (!/^\d{1,5}$/.test(port) || +port < 1 || +port > 65535) return invalid("Enter a port from 1 to 65535.", fields);
  if (controls.test(username + password)) return invalid("Credentials cannot contain control characters.", fields);
  if (protocol === "socks5" && (username || password)) return invalid("SOCKS5 authentication is unsupported. Use your provider’s HTTP or HTTPS endpoint.", fields);
  try {
    const auth = username || password ? `${encode(username)}${password ? `:${encode(password)}` : ""}@` : "";
    const u = validateProxy(`${protocol}://${auth}${host}:${Number(port)}`);
    const url = `${u.protocol}//${auth}${u.host}`;
    if (url.length > MAX_PROXY_INPUT) return invalid("Proxy details are too long.", fields);
    return { kind: "proxy", url, display: `${u.protocol}//${u.hostname}:${u.port || defaults[protocol]}`,
      fields: { protocol, host: u.hostname, port: u.port || defaults[protocol], username, password }, assumedProtocol };
  } catch { return invalid("Check the proxy host and credentials.", fields); }
}

function endpoint(value: string, protocol: ProxyProtocol, requirePort: boolean): ProxyFields | null {
  const match = /^(\[[^\]]+\]|[^:\s/@?#\\]+)(?::(\d+))?\/?$/.exec(value);
  if (!match || requirePort && !match[2]) return null;
  return { protocol, host: match[1]!, port: match[2] ?? defaults[protocol], username: "", password: "" };
}

// URL-style credentials may already be escaped. Shorthand and separate fields are literal.
function decodeCredential(value: string) {
  return decodeURIComponent(value.replace(/%(?![\da-f]{2})/gi, "%25"));
}

function parseAddress(input: string): ProxyInput {
  const scheme = /^([a-z][a-z\d+.-]*):\/\//i.exec(input);
  const protocol = (scheme?.[1]?.toLowerCase() ?? "http") as ProxyProtocol;
  if (!Object.hasOwn(defaults, protocol)) return invalid("Use HTTP, HTTPS, or unauthenticated SOCKS5.");
  if (scheme) {
    try {
      const url = new URL(input);
      if (url.pathname !== "/" && url.pathname !== "" || url.search || url.hash) {
        if (["http", "https"].includes(protocol) && !url.username && !url.password && (url.pathname !== "/" || url.search))
          return { kind: "link", url: url.href };
        return invalid("A proxy endpoint cannot include a path, query, or fragment. Enter its details separately.");
      }
    } catch { /* Raw credential characters can make a provider address invalid as a URL. */ }
  }
  const address = scheme ? input.slice(scheme[0].length) : input;
  const candidates: ProxyInput[] = [];
  const shorthand = /^(\[[^\]]+\]|[^:\s/@?#\\]+):(\d+):([^:]*):(.*)$/u.exec(address);
  if (shorthand) candidates.push(proxyFromFields({ protocol, host: shorthand[1]!, port: shorthand[2]!, username: shorthand[3]!, password: shorthand[4]! }, !scheme));
  const at = address.lastIndexOf("@");
  if (at >= 0) {
    const fields = endpoint(address.slice(at + 1), protocol, !scheme);
    if (fields) {
      const auth = address.slice(0, at), colon = auth.indexOf(":");
      try {
        fields.username = decodeCredential(colon < 0 ? auth : auth.slice(0, colon));
        fields.password = decodeCredential(colon < 0 ? "" : auth.slice(colon + 1));
        candidates.push(proxyFromFields(fields, !scheme));
      } catch { candidates.push(invalid("Credential encoding is unclear. Enter the username and password separately.", fields)); }
    }
  } else {
    const fields = endpoint(address, protocol, !scheme);
    if (fields) candidates.push(proxyFromFields(fields, !scheme));
  }
  const recognized = candidates.filter((candidate): candidate is ParsedProxy => candidate.kind === "proxy");
  if (new Set(recognized.map(candidate => candidate.url)).size > 1)
    return invalid("This format is ambiguous. Confirm the host and credentials below.", recognized[0]!.fields);
  if (recognized.length) return recognized[0]!;
  if (candidates.length) return candidates[0]!;
  return invalid("Format not recognized. Enter the proxy details separately.");
}

// Read shell quoting only. No execution, substitutions, environment lookup, or config-file reads.
function curlWords(input: string): string[] | null {
  const words: string[] = [];
  let word = "", quote = "", started = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quote === "'") { if (c === "'") quote = ""; else word += c; continue; }
    if (c === "\\" && (!quote || /["\\$`\n\r]/.test(input[i + 1] ?? ""))) {
      const next = input[++i];
      if (next === undefined) return null;
      if (next === "\r" && input[i + 1] === "\n") i++;
      else if (next !== "\n") word += next;
      continue;
    }
    if (quote === '"') { if (c === '"') quote = ""; else { if (c === "$" || c === "`") return null; word += c; } continue; }
    if (c === "'" || c === '"') { quote = c; started = true; }
    else if (/\s/.test(c)) { if (started || word) words.push(word); word = ""; started = false; }
    else if (/[;|&<>`$]/.test(c)) return null;
    else { word += c; started = true; }
  }
  if (quote) return null;
  if (started || word) words.push(word);
  return words;
}

function parseCurl(input: string): ProxyInput {
  const words = curlWords(input);
  const message = "Copy a cURL example with one --proxy (-x) and optional --proxy-user (-U), using literal credentials.";
  if (!words || words.shift()?.toLowerCase() !== "curl") return invalid(message);
  let address: string | undefined, auth: string | undefined;
  const valueOptions = new Set(["--url", "-u", "--user", "-H", "--header", "-A", "--user-agent", "-b", "--cookie", "-c", "--cookie-jar",
    "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "-F", "--form", "--form-string", "-X", "--request", "-o", "--output",
    "--connect-timeout", "--max-time", "-m", "--retry", "-e", "--referer", "--cacert", "--cert", "--key", "--resolve", "--connect-to"]);
  const switches = new Set(["--silent", "--show-error", "--location", "--insecure", "--verbose", "--include", "--head", "--fail",
    "--compressed", "--globoff", "--http1.1", "--http2", "--proxy-basic"]);
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (word === "--") break;
    if (valueOptions.has(word)) { if (words[++i] === undefined) return invalid(message); continue; }
    const proxy = word === "-x" || word === "--proxy" || word.startsWith("--proxy=") || word.startsWith("-x");
    const credentials = word === "-U" || word === "--proxy-user" || word.startsWith("--proxy-user=") || word.startsWith("-U");
    if (!proxy && !credentials) {
      if (word.startsWith("-") && !switches.has(word) && !/^-[sSLkviIfg]+$/.test(word)
          && !(word.includes("=") && valueOptions.has(word.slice(0, word.indexOf("="))))
          && !(word.length > 2 && valueOptions.has(word.slice(0, 2)))) return invalid(message);
      continue;
    }
    const value = ["-x", "--proxy", "-U", "--proxy-user"].includes(word) ? words[++i]
      : word.startsWith("--") ? word.slice(word.indexOf("=") + 1) : word.slice(2);
    if (!value || proxy && address !== undefined || credentials && auth !== undefined) return invalid(message);
    if (proxy) address = value; else auth = value;
  }
  if (!address) return invalid(message);
  const parsed = parseAddress(address);
  if (parsed.kind !== "proxy") return parsed.kind === "link" ? invalid("The cURL proxy option must contain a proxy endpoint, not a download link.") : parsed;
  if (auth === undefined) return parsed;
  if (parsed.fields.username || parsed.fields.password) return invalid("The cURL example contains two sets of credentials. Enter the intended credentials separately.", parsed.fields);
  const colon = auth.indexOf(":");
  if (colon < 0) return invalid("The cURL credentials need a username and password separated by a colon.", parsed.fields);
  return proxyFromFields({ ...parsed.fields, username: auth.slice(0, colon), password: auth.slice(colon + 1) }, parsed.assumedProtocol);
}

export function parseProxyInput(value: string): ProxyInput {
  const input = value.trim();
  if (!input) return { kind: "empty" };
  if (input.length > MAX_PROXY_INPUT) return invalid("Proxy details are too long. Import a file for a proxy list.");
  if (/^curl\s/i.test(input)) {
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\p{Bidi_Control}]/u.test(input)) return invalid("Remove control characters from the cURL example.");
    return parseCurl(input);
  }
  if (/\r|\n/.test(input)) return { kind: "list" };
  if (controls.test(input)) return invalid("Proxy details cannot contain control characters.");
  // In host:port:user:password exports the final field is a literal password.
  // Preserve its trailing spaces, while allowing a copied line terminator.
  const literal = value.trimStart().replace(/[\r\n]+$/, "");
  return parseAddress(/^(?:[a-z][a-z\d+.-]*:\/\/)?(?:\[[^\]]+\]|[^:\s/@?#\\]+):\d+:[^:]*:/i.test(literal) ? literal : input);
}

export function normalizeProxyInput(value: unknown): string {
  if (typeof value !== "string") throw Error("Paste a proxy address or enter its details.");
  const parsed = parseProxyInput(value);
  if (parsed.kind === "proxy") return parsed.url;
  if (parsed.kind === "invalid") throw Error(parsed.message);
  if (parsed.kind === "link" || parsed.kind === "list") throw Error("Import the proxy list and select one proxy before saving.");
  throw Error("Proxy details cannot be empty. Remove the proxy explicitly for a direct connection.");
}

export function parseProxyList(value: string): { proxies: ParsedProxy[]; errors: { line: number; message: string }[] } {
  if (new TextEncoder().encode(value).byteLength > MAX_PROXY_LIST_BYTES) throw Error("Choose a proxy list smaller than 1 MB.");
  const proxies: ParsedProxy[] = [], errors: { line: number; message: string }[] = [], seen = new Set<string>();
  const lines = value.split(/\r?\n/);
  if (lines.length > 10_000) throw Error("Split the list into files with at most 10,000 lines.");
  for (const [index, line] of lines.entries()) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const parsed = parseProxyInput(line);
    if (parsed.kind === "proxy") { if (!seen.has(parsed.url)) { proxies.push(parsed); seen.add(parsed.url); } }
    else errors.push({ line: index + 1, message: parsed.kind === "invalid" ? parsed.message : "Use one proxy endpoint per line." });
  }
  return { proxies, errors };
}
