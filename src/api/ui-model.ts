import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { parseEnv } from "node:util";
import {
  CONFIG_FILE, HOME_DIR, STATE, dir, runtimeDir, settings, typingMode, validateProxy, type Profile, type Settings,
} from "../profiles/config.ts";
import { doctor, logs, reportStatus, status } from "../runtime/runtime.ts";
import { isTypingMode } from "../browser/typing.ts";
import {
  NetworkTransactionError, networkTransactionSecretValues, pendingNetworkTransaction,
} from "../profiles/network-transaction.ts";
import {
  catalogSecretValues, pendingProfileCatalog,
} from "../profiles/profile-catalog.ts";
import { pendingProfileImport, profileImportSecretValues, ProfileImportTransactionError } from "../profiles/profile-import-transaction.ts";
import {
  ProfileCatalogError, ProfileConfigurationError, catalogRevision, createProfile, deleteProfile,
  updateNetwork, updateTyping, renameProfile, networkRevision, typingRevision,
} from "../profiles/profile-configuration.ts";
import { STELZ_VERSION, UPSTREAM_VERSION } from "../versions.ts";
import type {
  UiDiagnostics, UiProfile, UiProfileDetail, UiModel, UiNetwork, UiPhase,
} from "./contracts.ts";

export class UiModelError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = "UiModelError";
  }
}

const configFile = CONFIG_FILE;
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

// Do not follow service files or profile directories outside STELZ_HOME.
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
    const importing = pendingProfileImport();
    if (importing) throw new UiModelError(409, importing);
    const pending = pendingNetworkTransaction();
    if (pending) throw new UiModelError(409, pending.message);
  } catch (error) {
    const importing = pendingProfileImport();
    if (importing) throw new UiModelError(409, importing);
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
function checkProfileFiles(id: string) {
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
  for (const p of config?.profiles || []) {
    for (const name of [p.proxyEnv, p.expectedIPEnv]) if (name) add(process.env[name]);
    try {
      checkProfileFiles(p.id);
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
  for (const value of profileImportSecretValues()) add(value);
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
    text = text.replace(/(?<![\w-])((?:["']?)(?:[\w-]*(?:password|passwd|secret|token|credential|api[_-]?key|access[_-]?key)[\w-]*|proxy[_-]?(?:url|user(?:name)?|pass(?:word)?)|controller[_-]?id|authorization)(?:["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;]+)/gi, "$1[redacted]");
    if (known) text = text.replace(known, "[redacted]");
    return text.slice(0, limit);
  };
}

export function redactUiText(value: string): string {
  return redactor()(value);
}

export function createUiRedactor(): Redact {
  return redactor();
}

function referencedElsewhere(config: Settings, p: Profile, name?: string) {
  return !!name && config.profiles.some(other => other.id !== p.id && [other.proxyEnv, other.expectedIPEnv].includes(name));
}
function network(config: Settings, p: Profile, secrets: ReturnType<typeof readSecrets>): UiNetwork {
  const effective = (name?: string) => name ? process.env[name] ?? secrets.values[name] : undefined;
  const configured = !!p.proxyEnv, proxyEnv = configured ? p.proxyEnv : undefined;
  const proxy = effective(proxyEnv), expected = effective(p.expectedIPEnv);
  let proxyDisplay: string | null = configured ? "Proxy unavailable" : null;
  let proxyConfigured = false;
  if (configured && proxy) {
    try {
      const url = validateProxy(proxy);
      const port = url.port || (url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "1080");
      proxyDisplay = `${url.protocol}//${url.hostname}:${port}`.slice(0, 512);
      proxyConfigured = true;
    } catch {}
  }
  return {
    revision: networkRevision(config, p, secrets),
    proxyEnv: proxyEnv ?? null,
    expectedIPEnv: p.expectedIPEnv ?? null,
    proxyDisplay,
    proxyConfigured,
    expectedIp: ip(expected) ? expected : "",
    proxyReadOnly: !!proxyEnv && (process.env[proxyEnv] !== undefined || referencedElsewhere(config, p, proxyEnv) || proxyEnv === p.expectedIPEnv),
    expectedIpReadOnly: !!p.expectedIPEnv && (process.env[p.expectedIPEnv] !== undefined || referencedElsewhere(config, p, p.expectedIPEnv) || p.proxyEnv === p.expectedIPEnv),
  };
}
function configurationError(p: Profile, secrets: ReturnType<typeof readSecrets>): string | null {
  const importing = pendingProfileImport();
  if (importing) return importing;
  const catalog = pendingProfileCatalog();
  if (catalog) return catalog;
  const pending = pendingNetworkTransaction();
  if (pending && (!pending.profileId || pending.profileId === p.id)) return pending.message;
  if (p.proxyEnv) {
    const proxy = p.proxyEnv && (process.env[p.proxyEnv] ?? secrets.values[p.proxyEnv]);
    if (!proxy) return "Proxy URL is missing. Configure a proxy before starting this profile.";
    try { validateProxy(proxy); } catch { return "Proxy URL is invalid. Use HTTP(S) or unauthenticated SOCKS5."; }
  }
  const expected = p.expectedIPEnv && (process.env[p.expectedIPEnv] ?? secrets.values[p.expectedIPEnv]);
  return expected && !ip(expected) ? "Expected IP must be an IPv4 or IPv6 address." : null;
}
function ownership(value: unknown): UiProfile["ownership"] {
  const item = data(value), allowed = ["owned", "missing", "different", "unverified"];
  return allowed.includes(item.supervisor as string) && allowed.includes(item.server as string)
    ? { supervisor: item.supervisor as string, server: item.server as string } : null;
}
function profile(config: Settings, p: Profile, raw: Data, secrets: ReturnType<typeof readSecrets>, redact: Redact): UiProfile {
  const text = (value: unknown, limit = 1000) => typeof value === "string" ? redact(value, limit).replace(/[\r\n\t]+/g, " ") || null : null;
  const currentPhase = phase(raw.phase), active = currentPhase !== "stopped";
  const defaultTypingMode = active && isTypingMode(raw.typingModeDefault) ? raw.typingModeDefault : typingMode();
  const error = active ? [text(raw.error), text(raw.checkFailure, 500)].filter(Boolean).join(" ") || null : null;
  const controller = data(raw.controller);
  const windows = data(raw.windowControls);
  const windowsAvailable = ["ready", "paused", "verification_failed"].includes(currentPhase) && !raw.controlError && windows.available === true;
  const checkedAt = typeof raw.checkedAt === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(raw.checkedAt) && Number.isFinite(Date.parse(raw.checkedAt)) ? new Date(raw.checkedAt).toISOString() : null;
  return {
    id: p.id, name: p.name === undefined ? p.id : redact(p.name), port: p.port, storage: "native", phase: currentPhase,
    restartToUpdate: raw.restartToUpdate === true,
    location: raw.location as UiProfile["location"],
    instanceId: typeof raw.instanceId === "string" && /^[\w.-]{1,128}$/.test(raw.instanceId) ? text(raw.instanceId, 128) : null,
    exitIp: ip(raw.exitIp) ? raw.exitIp : null,
    checkedAt, fixedIpVerified: raw.fixedIpVerified === true,
    windowControls: { available: windowsAvailable, reason: windowsAvailable ? null : text(windows.reason, 300)
      || "Window controls are unavailable. Update the runtime with stelz setup, then start this profile again." },
    controller: active && Number.isSafeInteger(controller.pid) && (controller.pid as number) >= 1 ? {
      label: text(controller.label, 120) || "MCP client", pid: controller.pid as number,
      activeActions: Number.isSafeInteger(controller.activeActions) && (controller.activeActions as number) >= 0 ? controller.activeActions as number : 0,
      releasing: controller.releasing === true,
    } : null,
    supervisorPid: pid(raw.supervisorPid), serverPid: pid(raw.serverPid), ownership: ownership(raw.ownership),
    fingerprintSha256: digest(raw.fingerprintSha256), engineSha256: digest(raw.engineSha256),
    error, controlError: active ? text(raw.controlError) : null, configurationError: configurationError(p, secrets),
    network: network(config, p, secrets),
    typingMode: p.typingMode ?? defaultTypingMode,
    typing: { revision: typingRevision(p), mode: p.typingMode ?? null, defaultMode: defaultTypingMode },
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
function device(id: string, redact: Redact): UiProfileDetail["device"] {
  const empty = { version: null, properties: [] };
  const file = join(dir(id), "fingerprint.json"), info = localEntry(file, "file");
  if (!info || info.size > 2 * 1024 * 1024) return empty;
  let pin: Data;
  try { pin = data(JSON.parse(readFileSync(file, "utf8"))); } catch { return empty; }
  if (pin.version !== 2) return empty;
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

function findProfile(config: Settings | undefined, id: string) {
  const p = config?.profiles.find(p => p.id === id);
  if (!p) throw new UiModelError(404, "Profile is not configured.");
  return p;
}
async function safe<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) {
    if (error instanceof UiModelError) throw error;
    if (error instanceof ProfileCatalogError || error instanceof ProfileConfigurationError) throw new UiModelError(error.status, error.message);
    if (error instanceof NetworkTransactionError) throw new UiModelError(409, error.message);
    if (error instanceof ProfileImportTransactionError) throw new UiModelError(409, error.message);
    throw new UiModelError(409, "Cannot read or update service state. Inspect the service files before continuing.");
  }
}

export function createUiModel(): UiModel {
  return {
    snapshot: () => safe(async () => {
      const config = readSettings(), secrets = config ? readSecrets() : { text: "", values: {} };
      const observed = await Promise.all((config?.profiles || []).map(async p => {
        checkProfileFiles(p.id);
        return data(await reportStatus(p.id));
      }));
      const redact = redactor(config, observed.map(raw => data(raw.controller).id));
      return {
        home: redact(HOME_DIR), version: STELZ_VERSION, upstreamVersion: UPSTREAM_VERSION,
        initialized: !!config, setup: existsSync(join(runtimeDir(), "versions.json")),
        catalogRevision: catalogRevision(config),
        profiles: config ? config.profiles.map((p, index) => profile(config, p, observed[index]!, secrets, redact)) : [],
        updatedAt: new Date().toISOString(),
      };
    }),
    detail: id => safe(async () => {
      const config = readSettings(), p = findProfile(config, id);
      checkProfileFiles(p.id);
      const raw = data(await reportStatus(p.id)), secrets = readSecrets(), redact = redactor(config, [data(raw.controller).id]);
      for (const name of ["server.log", "supervisor.log"]) localEntry(join(dir(p.id), name), "file");
      const bounded = logs(p.id, 300);
      return {
        profile: profile(config!, p, raw, secrets, redact), directory: join(redact(STATE), p.id), device: device(p.id, redact),
        logs: { server: redact(bounded.server, 65536), supervisor: redact(bounded.supervisor, 65536) },
        mcpCommand: `env STELZ_HOME=${shellQuote(HOME_DIR)} stelz mcp`,
      };
    }),
    diagnostics: () => safe(async () => {
      const config = readSettings();
      for (const p of config?.profiles || []) checkProfileFiles(p.id);
      const raw = data(await doctor()), rows = Array.isArray(raw.profiles) ? raw.profiles.map(data) : [];
      const redact = redactor(config, rows.map(row => data(row.controller).id));
      const result: UiDiagnostics = {
        home: redact(HOME_DIR), initialized: raw.initialized === true, setup: raw.setup === true,
        node: raw.node === true, browserExecutable: raw.browserExecutable === true,
        profiles: (config?.profiles || []).map(p => {
          const row = rows.find(row => row.profileId === p.id) || {};
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
    createProfile: input => safe(async () => {
      const id = await createProfile(input);
      const config = readSettings()!, p = findProfile(config, id), secrets = readSecrets();
      return profile(config, p, data(status(id)), secrets, redactor(config));
    }),
    deleteProfile: (id, revision) => safe(() => deleteProfile(id, revision)),
    renameProfile: (id, input) => safe(async () => {
      const result = await renameProfile(id, input);
      const raw = data(await reportStatus(id));
      return profile(result.config, result.profile, raw, result.secrets, redactor(result.config, [data(raw.controller).id]));
    }),
    updateNetwork: (id, input) => safe(async () => {
      const result = await updateNetwork(id, input);
      return profile(result.config, result.profile, data(result.observation), result.secrets, redactor(result.config, Object.values(result.secrets.values)));
    }),
    updateTyping: (id, input) => safe(async () => {
      const result = await updateTyping(id, input);
      const raw = data(await reportStatus(id));
      return profile(result.config, result.profile, raw, result.secrets, redactor(result.config, [data(raw.controller).id]));
    }),
  };
}
