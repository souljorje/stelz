import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { parseEnv } from "node:util";
import {
  HOME_DIR, STATE, dir, settings, validateProxy, validateSettings, type Profile, type Settings,
} from "./config.ts";
import { doctor, lock, logs, recoverNetworkConfiguration, reportStatus, running, status } from "./runtime.ts";
import {
  NetworkTransactionError, networkTransactionSecretValues, pendingNetworkTransaction, saveNetworkTransaction,
} from "./network-transaction.ts";
import {
  IdentityCatalogError, catalogRevision, catalogSecretValues, createIdentity, deleteIdentity,
  pendingIdentityCatalog, recoverIdentityCatalog,
} from "./identity-catalog.ts";
import { STELZ_VERSION, UPSTREAM_VERSION } from "./versions.ts";
import type {
  UiDiagnostics, UiIdentity, UiIdentityDetail, UiModel, UiNetwork, UiNetworkUpdate, UiPhase,
} from "./ui-types.ts";

export class UiModelError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = "UiModelError";
  }
}

const configFile = join(HOME_DIR, "identities.json");
const secretsFile = join(HOME_DIR, "secrets.env");
const phases = new Set<UiPhase>([
  "starting", "ready", "paused", "verification_failed", "blocked", "stopping", "stopped",
  "orphaned", "ownership_unknown", "unclean",
]);
const sensitiveName = /password|passwd|secret|token|credential|proxy|authorization|api[_-]?key|access[_-]?key/i;
type Data = Record<string, unknown>;
type Redact = (value: string, limit?: number) => string;
const data = (value: unknown): Data => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Data : {};
const ip = (value: unknown): value is string => typeof value === "string" && !value.includes("%") && isIP(value) !== 0;
const pid = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 1 ? value as number : null;
const phase = (value: unknown): UiPhase => phases.has(value as UiPhase) ? value as UiPhase : "unclean";
const digest = (value: unknown) => typeof value === "string" && /^[a-f\d]{64}$/i.test(value) ? value : null;

// Do not follow service files or identity directories outside STELZ_HOME.
function localEntry(file: string, kind: "file" | "directory", optional = true) {
  try {
    const info = lstatSync(file);
    if (info.isSymbolicLink() || (kind === "file" ? !info.isFile() || info.nlink !== 1 : !info.isDirectory()))
      throw new UiModelError(409, "Service state contains an unsafe file or directory. Inspect it before continuing.");
    return info;
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}
function readSettings(): Settings | undefined {
  try {
    localEntry(HOME_DIR, "directory");
    if (localEntry(configFile, "file")) return settings();
    const pending = pendingNetworkTransaction();
    if (pending) throw new UiModelError(409, pending.message);
  } catch (error) {
    const pending = pendingNetworkTransaction();
    if (pending) throw new UiModelError(409, pending.message);
    throw error;
  }
}
function readSecrets(): { text: string; values: ReturnType<typeof parseEnv> } {
  const info = localEntry(secretsFile, "file");
  if (info && info.size > 1024 * 1024) throw new UiModelError(409, "The secrets file exceeds the size limit.");
  const text = info ? readFileSync(secretsFile, "utf8") : "";
  return { text, values: parseEnv(text) };
}
function checkIdentityFiles(id: string) {
  localEntry(STATE, "directory");
  localEntry(dir(id), "directory");
  for (const name of ["running.json", "status.json", "stopped.json", "access-key"])
    localEntry(join(dir(id), name), "file");
}

function redactor(config?: Settings, extra: unknown[] = []): Redact {
  const hidden = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== "string" || !value || ip(value)) return;
    hidden.add(value);
    try {
      const url = new URL(value);
      for (const credential of [url.username, url.password]) {
        if (credential) { hidden.add(credential); hidden.add(decodeURIComponent(credential)); }
      }
    } catch {}
  };
  try {
    localEntry(HOME_DIR, "directory");
    for (const value of Object.values(readSecrets().values)) add(value);
  } catch {}
  for (const [name, value] of Object.entries(process.env)) if (sensitiveName.test(name)) add(value);
  if (!config) { try { config = readSettings(); } catch {} }
  for (const p of config?.identities || []) {
    for (const name of [p.proxyEnv, p.expectedIPEnv]) if (name) add(process.env[name]);
    try {
      checkIdentityFiles(p.id);
      if (localEntry(join(dir(p.id), "access-key"), "file")) add(readFileSync(join(dir(p.id), "access-key"), "utf8").trim());
      if (localEntry(join(dir(p.id), "status.json"), "file")) {
        const controller = data(data(JSON.parse(readFileSync(join(dir(p.id), "status.json"), "utf8"))).controller);
        add(controller.id);
        add(controller.token);
      }
    } catch {}
  }
  for (const value of extra) add(value);
  for (const value of networkTransactionSecretValues()) add(value);
  for (const value of catalogSecretValues()) add(value);
  for (const value of [...hidden]) {
    hidden.add(encodeURIComponent(value));
    hidden.add(JSON.stringify(value).slice(1, -1));
    hidden.add(value.replace(/%[a-f\d]{2}/gi, part => part.toLowerCase()));
  }
  const escaped = [...hidden].filter(Boolean).sort((a, b) => b.length - a.length).map(value => {
    const literal = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return value.length < 4 ? `(?<![\\w])${literal}(?![\\w])` : literal;
  });
  const known = escaped.length ? new RegExp(escaped.join("|"), "g") : undefined;
  return (value, limit = Infinity) => {
    let text = value
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, "");
    text = text.replace(/(\b[a-z][a-z\d+.-]*:\/\/)[^\s/<>]*@/gi, "$1[redacted]@");
    text = text.replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s<>"']+/gi, raw => {
      try {
        const url = new URL(raw);
        if (!url.username && !url.password && !url.search && !url.hash) return raw;
        return `${url.protocol}//${url.username || url.password ? "[redacted]@" : ""}${url.host}${url.pathname}${url.search ? "?[redacted]" : ""}${url.hash ? "#[redacted]" : ""}`;
      } catch { return raw.replace(/(\/\/)[^/\s]*@/, "$1[redacted]@"); }
    });
    text = text.replace(/\b(Bearer|Basic)\s+[^\s,;"']+/gi, "$1 [redacted]");
    text = text.replace(/((?:["']?)(?:[\w-]*(?:password|passwd|secret|token|credential|api[_-]?key|access[_-]?key)[\w-]*|proxy[_-]?(?:url|user(?:name)?|pass(?:word)?)|controller[_-]?id|authorization)(?:["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;]+)/gi, "$1[redacted]");
    if (known) text = text.replace(known, "[redacted]");
    return text.slice(0, limit);
  };
}

export function redactUiText(value: string): string {
  return redactor()(value);
}

function referencedElsewhere(config: Settings, p: Profile, name?: string) {
  return !!name && config.identities.some(other => other.id !== p.id && [other.proxyEnv, other.expectedIPEnv].includes(name));
}
function network(config: Settings, p: Profile, secrets: ReturnType<typeof readSecrets>): UiNetwork {
  const effective = (name?: string) => name ? process.env[name] ?? secrets.values[name] : undefined;
  const proxy = effective(p.proxyEnv), expected = effective(p.expectedIPEnv);
  let proxyDisplay: string | null = null;
  if (proxy) {
    try {
      const url = validateProxy(proxy);
      const port = url.port || (url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "1080");
      proxyDisplay = `${url.protocol}//${url.hostname}:${port}`.slice(0, 512);
    } catch {}
  }
  return {
    revision: createHash("sha256").update(JSON.stringify({
      config,
      proxy: p.proxyEnv ? [secrets.values[p.proxyEnv] ?? null, process.env[p.proxyEnv] ?? null] : null,
      expected: p.expectedIPEnv ? [secrets.values[p.expectedIPEnv] ?? null, process.env[p.expectedIPEnv] ?? null] : null,
    })).digest("hex"),
    mode: p.mode,
    proxyEnv: p.proxyEnv ?? null,
    expectedIPEnv: p.expectedIPEnv ?? null,
    proxyDisplay,
    proxyConfigured: !!proxyDisplay,
    expectedIp: ip(expected) ? expected : "",
    proxyReadOnly: !!p.proxyEnv && (process.env[p.proxyEnv] !== undefined || referencedElsewhere(config, p, p.proxyEnv) || p.proxyEnv === p.expectedIPEnv),
    expectedIpReadOnly: !!p.expectedIPEnv && (process.env[p.expectedIPEnv] !== undefined || referencedElsewhere(config, p, p.expectedIPEnv) || p.proxyEnv === p.expectedIPEnv),
  };
}
function configurationError(p: Profile, secrets: ReturnType<typeof readSecrets>): string | null {
  const catalog = pendingIdentityCatalog();
  if (catalog) return catalog;
  const pending = pendingNetworkTransaction();
  if (pending && (!pending.identityId || pending.identityId === p.id)) return pending.message;
  if (p.mode === "proxy") {
    const proxy = p.proxyEnv && (process.env[p.proxyEnv] ?? secrets.values[p.proxyEnv]);
    if (!proxy) return "Proxy URL is missing. Configure a proxy before starting this identity.";
    try { validateProxy(proxy); } catch { return "Proxy URL is invalid. Use HTTP(S) or unauthenticated SOCKS5."; }
  }
  const expected = p.expectedIPEnv && (process.env[p.expectedIPEnv] ?? secrets.values[p.expectedIPEnv]);
  return expected && !ip(expected) ? "Expected IP must be an IPv4 or IPv6 address." : null;
}
function ownership(value: unknown): UiIdentity["ownership"] {
  const item = data(value), allowed = ["owned", "missing", "different", "unverified"];
  return allowed.includes(item.supervisor as string) && allowed.includes(item.server as string)
    ? { supervisor: item.supervisor as string, server: item.server as string } : null;
}
function identity(config: Settings, p: Profile, raw: Data, secrets: ReturnType<typeof readSecrets>, redact: Redact): UiIdentity {
  const text = (value: unknown, limit = 1000) => typeof value === "string" ? redact(value, limit).replace(/[\r\n\t]+/g, " ") || null : null;
  const currentPhase = phase(raw.phase), active = currentPhase !== "stopped";
  const error = active ? [text(raw.error), text(raw.checkFailure, 500)].filter(Boolean).join(" ") || null : null;
  const controller = data(raw.controller);
  const checkedAt = typeof raw.checkedAt === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(raw.checkedAt) && Number.isFinite(Date.parse(raw.checkedAt)) ? new Date(raw.checkedAt).toISOString() : null;
  return {
    id: p.id, port: p.port, mode: p.mode, storage: p.storage || "checkpoint", phase: currentPhase,
    instanceId: typeof raw.instanceId === "string" && /^[\w.-]{1,128}$/.test(raw.instanceId) ? text(raw.instanceId, 128) : null,
    exitIp: ip(raw.exitIp) ? raw.exitIp : null,
    checkedAt, fixedIpVerified: raw.fixedIpVerified === true,
    controller: active && Number.isSafeInteger(controller.pid) && (controller.pid as number) >= 1 ? {
      label: text(controller.label, 120) || "MCP client", pid: controller.pid as number,
      activeActions: Number.isSafeInteger(controller.activeActions) && (controller.activeActions as number) >= 0 ? controller.activeActions as number : 0,
      releasing: controller.releasing === true,
    } : null,
    supervisorPid: pid(raw.supervisorPid), serverPid: pid(raw.serverPid), ownership: ownership(raw.ownership),
    fingerprintSha256: digest(raw.fingerprintSha256), engineSha256: digest(raw.engineSha256),
    error, controlError: active ? text(raw.controlError) : null, configurationError: configurationError(p, secrets),
    network: network(config, p, secrets),
  };
}

// Each entry names a scalar device property. Saved launch preferences and objects never enter the UI.
const deviceFields: [string, string, number, number?][] = [
  ["navigator.userAgent", "User agent", 512], ["navigator.appVersion", "Browser version", 256],
  ["navigator.platform", "Platform", 64], ["navigator.oscpu", "Operating system", 128],
  ["navigator.vendor", "Browser vendor", 128],
  ["navigator.hardwareConcurrency", "CPU cores", 1024, 1], ["navigator.deviceMemory", "Device memory (GiB)", 1024, 0.25],
  ["navigator.maxTouchPoints", "Touch points", 1024, 0],
  ["screen.width", "Screen width (px)", 32768, 1], ["screen.height", "Screen height (px)", 32768, 1],
  ["screen.availWidth", "Available width (px)", 32768, 1], ["screen.availHeight", "Available height (px)", 32768, 1],
  ["screen.colorDepth", "Color depth (bits)", 128, 1], ["screen.pixelDepth", "Pixel depth (bits)", 128, 1],
  ["window.devicePixelRatio", "Pixel ratio", 16, 0.1],
  ["webGl:vendor", "GPU vendor", 128], ["webGl:renderer", "GPU renderer", 256],
];
function device(id: string, redact: Redact): UiIdentityDetail["device"] {
  const empty = { version: null, properties: [] };
  const file = join(dir(id), "fingerprint.json"), info = localEntry(file, "file");
  if (!info || info.size > 2 * 1024 * 1024) return empty;
  let pin: Data;
  try { pin = data(JSON.parse(readFileSync(file, "utf8"))); } catch { return empty; }
  if (pin.version !== 1 && pin.version !== 2) return empty;
  const config = data(pin.config), properties: { name: string; value: string }[] = [];
  for (const [key, name, limit, minimum] of deviceFields) {
    const value = config[key];
    if (minimum === undefined && typeof value === "string") {
      properties.push({ name, value: redact(value, limit).replace(/[\r\n\t]+/g, " ") });
    } else if (minimum !== undefined && typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= limit) {
      properties.push({ name, value: String(value) });
    }
  }
  return { version: pin.version, properties };
}
const shellQuote = (value: string) => /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

function validateUpdate(value: UiNetworkUpdate): UiNetworkUpdate {
  const item = data(value);
  if (!value || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(item).some(key => !["revision", "mode", "proxyUrl", "expectedIp"].includes(key)) ||
      typeof item.revision !== "string" || !/^[a-f\d]{64}$/.test(item.revision) ||
      !["direct", "proxy"].includes(item.mode as string))
    throw new UiModelError(400, "Network input is invalid. Supply a revision and a direct or proxy mode.");
  if (Object.hasOwn(item, "proxyUrl")) {
    if (typeof item.proxyUrl !== "string" || !item.proxyUrl || item.proxyUrl.length > 8192 ||
        /[\s\\\x00-\x1f\x7f]/.test(item.proxyUrl) || !/^(?:https?|socks5):\/\//i.test(item.proxyUrl))
      throw new UiModelError(400, "Proxy URL must be a nonempty HTTP(S) or unauthenticated SOCKS5 URL.");
    try { encodeURIComponent(item.proxyUrl); validateProxy(item.proxyUrl); } catch { throw new UiModelError(400, "Proxy URL is invalid. Use HTTP(S) or unauthenticated SOCKS5."); }
  }
  if (Object.hasOwn(item, "expectedIp") && (typeof item.expectedIp !== "string" || item.expectedIp !== "" && !ip(item.expectedIp)))
    throw new UiModelError(400, "Expected IP must be empty or an IPv4 or IPv6 address.");
  return value;
}

// Replace only selected assignment values. Preserve comments, duplicate keys, and unrelated multiline values.
function editSecrets(text: string, updates: Map<string, string>): string {
  const edits: { start: number; end: number; value: string }[] = [], found = new Set<string>();
  for (let start = 0; start < text.length;) {
    const newline = text.indexOf("\n", start), lineEnd = newline < 0 ? text.length : newline;
    const match = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*/.exec(text.slice(start, lineEnd));
    let end = lineEnd;
    if (match) {
      const valueStart = start + match[0].length, quote = text[valueStart];
      let valueEnd: number;
      if (quote === "\"" || quote === "'") {
        const close = text.indexOf(quote, valueStart + 1);
        if (close < 0) throw new UiModelError(409, "The secrets file contains an incomplete quoted value.");
        const next = text.indexOf("\n", close + 1);
        end = next < 0 ? text.length : next;
        valueEnd = close + 1;
      } else {
        const comment = text.indexOf("#", valueStart);
        valueEnd = comment >= 0 && comment < lineEnd ? comment : lineEnd;
        while (valueEnd > valueStart && /[ \t\r]/.test(text[valueEnd - 1]!)) valueEnd--;
      }
      if (updates.has(match[1]!)) {
        edits.push({ start: valueStart, end: valueEnd, value: updates.get(match[1]!) || '""' });
        found.add(match[1]!);
      }
    }
    start = end + 1;
  }
  let result = text;
  for (const edit of edits.reverse()) result = result.slice(0, edit.start) + edit.value + result.slice(edit.end);
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  for (const [name, value] of updates) if (!found.has(name)) {
    if (result && !result.endsWith("\n")) result += newline;
    result += `${name}=${value || '""'}${newline}`;
  }
  const before = parseEnv(text), after = parseEnv(result);
  for (const name of new Set([...Object.keys(before), ...Object.keys(after), ...updates.keys()])) {
    if (after[name] !== (updates.has(name) ? updates.get(name) : before[name]))
      throw new UiModelError(409, "The secrets file cannot be edited safely. Inspect its assignment syntax.");
  }
  return result;
}

function findIdentity(config: Settings | undefined, id: string) {
  const p = config?.identities.find(p => p.id === id);
  if (!p) throw new UiModelError(404, "Identity is not configured.");
  return p;
}
async function safe<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) {
    if (error instanceof UiModelError) throw error;
    if (error instanceof IdentityCatalogError) throw new UiModelError(error.status, error.message);
    if (error instanceof NetworkTransactionError) throw new UiModelError(409, error.message);
    throw new UiModelError(409, "Cannot read or update service state. Inspect the service files before continuing.");
  }
}

export function createUiModel(): UiModel {
  return {
    snapshot: () => safe(async () => {
      const config = readSettings(), secrets = config ? readSecrets() : { text: "", values: {} };
      const observed = await Promise.all((config?.identities || []).map(async p => {
        checkIdentityFiles(p.id);
        return data(await reportStatus(p.id));
      }));
      const redact = redactor(config, observed.map(raw => data(raw.controller).id));
      return {
        home: redact(HOME_DIR), version: STELZ_VERSION, upstreamVersion: UPSTREAM_VERSION,
        initialized: !!config, setup: existsSync(join(HOME_DIR, "runtime/versions.json")),
        maxActive: config?.maxActive ?? 2,
        catalogRevision: catalogRevision(config),
        identities: config ? config.identities.map((p, index) => identity(config, p, observed[index]!, secrets, redact)) : [],
        updatedAt: new Date().toISOString(),
      };
    }),
    detail: id => safe(async () => {
      const config = readSettings(), p = findIdentity(config, id);
      checkIdentityFiles(p.id);
      const raw = data(await reportStatus(p.id)), secrets = readSecrets(), redact = redactor(config, [data(raw.controller).id]);
      for (const name of ["server.log", "supervisor.log"]) localEntry(join(dir(p.id), name), "file");
      const bounded = logs(p.id, 300);
      return {
        identity: identity(config!, p, raw, secrets, redact), device: device(p.id, redact),
        logs: { server: redact(bounded.server, 65536), supervisor: redact(bounded.supervisor, 65536) },
        mcpCommand: `env STELZ_HOME=${shellQuote(HOME_DIR)} stelz mcp --identity ${shellQuote(p.id)}`,
      };
    }),
    diagnostics: () => safe(async () => {
      const config = readSettings();
      for (const p of config?.identities || []) checkIdentityFiles(p.id);
      const raw = data(await doctor()), rows = Array.isArray(raw.identities) ? raw.identities.map(data) : [];
      const redact = redactor(config, rows.map(row => data(row.controller).id));
      const result: UiDiagnostics = {
        home: redact(HOME_DIR), initialized: raw.initialized === true, setup: raw.setup === true,
        node: raw.node === true, browserExecutable: raw.browserExecutable === true,
        identities: (config?.identities || []).map(p => {
          const row = rows.find(row => row.identityId === p.id) || {};
          return {
            id: p.id, phase: phase(row.phase),
            configuration: typeof row.configuration === "string" ? redact(row.configuration, 1000) : "Configuration is unavailable.",
            accessKeyPresent: row.accessKey === true,
            supervisorPid: pid(row.supervisorPid), serverPid: pid(row.serverPid), ownership: ownership(row.ownership),
          };
        }),
      };
      return result;
    }),
    createIdentity: input => safe(async () => {
      const id = await createIdentity(input);
      const config = readSettings()!, p = findIdentity(config, id), secrets = readSecrets();
      return identity(config, p, data(status(id)), secrets, redactor(config));
    }),
    deleteIdentity: (id, revision) => safe(() => deleteIdentity(id, revision)),
    updateNetwork: (id, input) => safe(async () => {
      const update = validateUpdate(input), initial = readSettings();
      findIdentity(initial, id);
      localEntry(STATE, "directory");
      mkdirSync(STATE, { recursive: true, mode: 0o700 });
      return lock(join(STATE, "admission.lock"), async () => {
        await recoverIdentityCatalog();
        await recoverNetworkConfiguration();
        findIdentity(readSettings(), id);
        localEntry(dir(id), "directory");
        mkdirSync(dir(id), { recursive: true, mode: 0o700 });
        return lock(join(dir(id), "lifecycle.lock"), async () => {
        const config = readSettings()!, p = findIdentity(config, id), secrets = readSecrets();
        checkIdentityFiles(id);
        const recordFile = join(dir(id), "running.json");
        if (existsSync(recordFile)) {
          const record = data(JSON.parse(readFileSync(recordFile, "utf8")));
          if (record.version !== undefined && record.version !== 2)
            throw new UiModelError(409, "The process record version is unknown. Inspect it before changing the network.");
        }
        const raw = data(status(id));
        if (raw.phase !== "stopped" || running(id))
          throw new UiModelError(409, "Stop the identity cleanly before changing its network.");
        const current = network(config, p, secrets);
        if (update.revision !== current.revision)
          throw new UiModelError(409, "Network configuration changed. Refresh it before saving.");
        const candidate = structuredClone(config), next = candidate.identities.find(item => item.id === id)!;
        next.mode = update.mode;
        const updates = new Map<string, string>();
        const used = new Set([...Object.keys(secrets.values), ...Object.keys(process.env), ...config.identities.flatMap(item => [item.proxyEnv, item.expectedIPEnv].filter((name): name is string => !!name))]);
        const set = (field: "proxyEnv" | "expectedIPEnv", value: string) => {
          let name = next[field];
          if (name && (process.env[name] !== undefined || referencedElsewhere(config, p, name) || p.proxyEnv === p.expectedIPEnv))
            throw new UiModelError(409, "This secret has an environment override or a shared reference. Edit it outside the UI.");
          if (!name) {
            do { name = `STELZ_${id.replaceAll("-", "_").toUpperCase()}_${field === "proxyEnv" ? "PROXY_URL" : "EXPECTED_IP"}_${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`; } while (used.has(name));
            next[field] = name;
            used.add(name);
          }
          updates.set(name, value);
        };
        if (update.proxyUrl !== undefined) set("proxyEnv", update.proxyUrl);
        if (update.expectedIp !== undefined && (update.expectedIp || next.expectedIPEnv)) set("expectedIPEnv", update.expectedIp);
        validateSettings(candidate);
        const changedSecrets = editSecrets(secrets.text, updates), candidateSecrets = { text: changedSecrets, values: parseEnv(changedSecrets) };
        const error = configurationError(next, candidateSecrets);
        if (error) throw new UiModelError(400, error);
        const result = identity(candidate, next, raw, candidateSecrets, redactor(candidate, Object.values(candidateSecrets.values)));
        const previousConfig = readFileSync(configFile, "utf8");
        const before = { config: previousConfig, secrets: existsSync(secretsFile) ? secrets.text : null };
        saveNetworkTransaction(id, before, { config: JSON.stringify(candidate, null, 2) + "\n", secrets: updates.size ? changedSecrets : before.secrets });
        return result;
        });
      });
    }),
  };
}
