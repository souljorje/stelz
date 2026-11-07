/** Pure fingerprint checks. This module must not load launchers or files. */

export type SerializedFingerprint =
  | string
  | readonly string[]
  | Readonly<Record<string, string>>;

export type DiagnosticSeverity = "error" | "warning";
export type CheckStatus = "PASS" | "FAIL" | "NOT_RUN" | "NOT_APPLICABLE";
export type RuntimeStatus = "NOT_RUN" | "PASS" | "FAIL";

export interface FingerprintDiagnostic {
  readonly code: string;
  readonly path: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
}

export interface FingerprintValidationInput {
  readonly pin?: unknown;
  readonly newIdentity?: unknown;
  readonly effectiveIdentity?: unknown;
  readonly serialized?: SerializedFingerprint;
  readonly newPreferences?: unknown;
  readonly effectivePreferences?: unknown;
  readonly serializedPreferences?: unknown;
}

export interface FingerprintValidationOptions {
  readonly expectedEngineSha256?: string;
  readonly admissionRequired?: boolean;
  readonly runtime?: RuntimeValidationResult;
}

export type FingerprintValidationResult = Readonly<{
  staticValid: boolean;
  schema: CheckStatus;
  engineSha256: CheckStatus;
  runtime: RuntimeStatus;
  admissionBlocked: boolean;
  diagnostics: readonly FingerprintDiagnostic[];
}>;

export interface RuntimeObservationInput {
  readonly expectedIdentity: unknown;
  readonly observedIdentity: unknown;
  readonly expectedPreferences?: unknown;
  readonly observedPreferences?: unknown;
  readonly supportedPaths?: readonly string[];
}

export type RuntimeValidationResult = Readonly<{
  status: RuntimeStatus;
  diagnostics: readonly FingerprintDiagnostic[];
}>;

type CheckKind = "schema" | "identity" | "engine";
type InternalDiagnostic = FingerprintDiagnostic & { readonly kind: CheckKind };
type RecordValue = Readonly<Record<string, unknown>>;
type OsFamily = "android" | "chromeos" | "ios" | "linux" | "macos" | "windows";
type Architecture = "arm" | "x86";

const PIN_VERSION = 2;
const ENGINE_SHA256 = /^[0-9a-f]{64}$/;
const CHUNK_NAME = /^CAMOU_CONFIG_([1-9]\d*)$/;
const DIRECT3D = /\b(?:direct3d(?:9|10|11|12)?|d3d(?:9|10|11|12)?)\b|\b(?:vs|ps)_[0-9]+_[0-9]+\b/i;
const RUNTIME_PATHS = [
  "navigator.userAgent",
  "navigator.platform",
  "navigator.oscpu",
  "navigator.hardwareConcurrency",
  "navigator.deviceMemory",
  "screen.width",
  "screen.height",
  "screen.availWidth",
  "screen.availHeight",
  "screen.colorDepth",
  "screen.pixelDepth",
  "window.innerWidth",
  "window.innerHeight",
  "window.outerWidth",
  "window.outerHeight",
  "window.devicePixelRatio",
  "webGl:vendor",
  "webGl:renderer",
  "webGl:version",
  "webGl2:vendor",
  "webGl2:renderer",
  "webGl2:version",
] as const;
const WEBGL_PREFERENCE_PATHS = [
  "webgl.disabled",
  "webgl.enable-webgl2",
  "webgl.force-enabled",
] as const;
function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function add(
  diagnostics: InternalDiagnostic[],
  kind: CheckKind,
  code: string,
  path: string,
  severity: DiagnosticSeverity,
  message: string,
): void {
  diagnostics.push({ code, path, severity, message, kind });
}

export function normalizeFingerprintDiagnostics(diagnostics: readonly FingerprintDiagnostic[]): readonly FingerprintDiagnostic[] {
  const unique = new Map<string, FingerprintDiagnostic>();
  for (const diagnostic of diagnostics) {
    const { code, path, severity, message } = diagnostic;
    unique.set(`${code}\u0000${path}\u0000${severity}\u0000${message}`, { code, path, severity, message });
  }
  const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
  return Object.freeze([...unique.values()].sort((a, b) =>
    compare(a.code, b.code) || compare(a.path, b.path) || compare(a.severity, b.severity)
  ));
}

function detectUserAgentOs(userAgent: string): OsFamily | undefined {
  if (/\bWindows\b/i.test(userAgent)) return "windows";
  if (/\bAndroid\b/i.test(userAgent)) return "android";
  if (/\b(?:iPhone|iPad|iPod)\b/i.test(userAgent)) return "ios";
  if (/\bCrOS\b/i.test(userAgent)) return "chromeos";
  if (/\bMacintosh\b|\bMac OS X\b/i.test(userAgent)) return "macos";
  if (/\bLinux\b|\bX11\b/i.test(userAgent)) return "linux";
  return undefined;
}

function detectPlatformOs(platform: string): OsFamily | undefined {
  if (/^mac/i.test(platform)) return "macos";
  if (/^win/i.test(platform)) return "windows";
  if (/^linux|^x11/i.test(platform)) return "linux";
  if (/^cros/i.test(platform)) return "chromeos";
  if (/^iphone|^ipad|^ipod/i.test(platform)) return "ios";
  return undefined;
}

function detectOscpuOs(oscpu: string): OsFamily | undefined {
  const value = oscpu.trim();
  if (/^(?:Windows NT|Windows)\b/i.test(value)) return "windows";
  if (/^(?:Intel Mac OS X|PPC Mac OS X|Mac OS X|Macintosh)\b/i.test(value)) return "macos";
  if (/^(?:Linux|X11)\b/i.test(value)) return "linux";
  if (/^(?:CrOS)\b/i.test(value)) return "chromeos";
  if (/^(?:Android)\b/i.test(value)) return "android";
  if (/^(?:iPhone|iPad|iPod)\b/i.test(value)) return "ios";
  return undefined;
}

function detectUserAgentDataOs(platform: string): OsFamily | undefined {
  switch (platform.toLowerCase()) {
    case "macos": return "macos";
    case "windows": return "windows";
    case "linux": return "linux";
    case "android": return "android";
    case "ios": return "ios";
    case "chrome os": return "chromeos";
    default: return undefined;
  }
}

function compatibleOs(left: OsFamily, right: OsFamily): boolean {
  if (left === right) return true;
  if ((left === "android" && right === "linux") || (left === "linux" && right === "android")) return true;
  if ((left === "chromeos" && right === "linux") || (left === "linux" && right === "chromeos")) return true;
  if ((left === "ios" && right === "macos") || (left === "macos" && right === "ios")) return true;
  return false;
}

function classifyArchitecture(value: string): Architecture | undefined {
  const normalized = value.trim().toLowerCase();
  if (/^(?:arm|arm64|aarch64|armv[6-9][a-z0-9_-]*)$/.test(normalized)) return "arm";
  if (/^(?:x86|x64|x86_64|amd64|i[3-6]86|win32|win64|wow64)$/.test(normalized)) return "x86";
  if (/aarch64|\barm64\b|\barmv[6-9]/.test(normalized)) return "arm";
  if (/\bx86_64\b|\bx64\b|\bamd64\b|\bi[3-6]86\b|\bwin64\b|\bwow64\b/.test(normalized)) return "x86";
  return undefined;
}

function checkString(
  identity: RecordValue,
  key: string,
  prefix: string,
  diagnostics: InternalDiagnostic[],
): string | undefined {
  if (!hasOwn(identity, key)) return undefined;
  const value = identity[key];
  if (typeof value !== "string" || !value) {
    add(diagnostics, "identity", "identity.value.invalid", `${prefix}${key}`, "error", "The value must be a non-empty string.");
    return undefined;
  }
  return value;
}

function checkPositiveNumber(
  identity: RecordValue,
  key: string,
  prefix: string,
  diagnostics: InternalDiagnostic[],
  mode: "finite" | "integer" = "integer",
): number | undefined {
  if (!hasOwn(identity, key)) return undefined;
  const value = identity[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || (mode === "integer" && !Number.isInteger(value))) {
    add(diagnostics, "identity", "geometry.value.invalid", `${prefix}${key}`, "error",
      mode === "integer" ? "The value must be a positive integer." : "The value must be a positive finite number.");
    return undefined;
  }
  return value;
}

function validateIdentity(identity: unknown, prefix: string, diagnostics: InternalDiagnostic[]): void {
  if (!isRecord(identity)) {
    add(diagnostics, "schema", "identity.object", prefix.slice(0, -1), "error", "The fingerprint identity must be an object.");
    return;
  }

  const userAgent = checkString(identity, "navigator.userAgent", prefix, diagnostics);
  if (!hasOwn(identity, "navigator.userAgent")) {
    add(diagnostics, "identity", "identity.userAgent.missing", `${prefix}navigator.userAgent`, "error", "The fingerprint needs a user agent.");
  }
  const platformValue = checkString(identity, "navigator.platform", prefix, diagnostics);
  const oscpu = checkString(identity, "navigator.oscpu", prefix, diagnostics);
  const architectureValue = checkString(identity, "navigator.architecture", prefix, diagnostics);

  let userAgentData: RecordValue | undefined;
  if (hasOwn(identity, "navigator.userAgentData")) {
    const value = identity["navigator.userAgentData"];
    if (!isRecord(value)) {
      add(diagnostics, "schema", "identity.userAgentData.object", `${prefix}navigator.userAgentData`, "error", "The user agent data must be an object.");
    } else {
      userAgentData = value;
    }
  }
  const userAgentDataPlatform = userAgentData ? checkString(userAgentData, "platform", `${prefix}navigator.userAgentData.`, diagnostics) : undefined;
  const userAgentDataArchitecture = userAgentData
    ? checkString(userAgentData, "architecture", `${prefix}navigator.userAgentData.`, diagnostics)
    : undefined;

  const userAgentOs = userAgent ? detectUserAgentOs(userAgent) : undefined;
  if (userAgent && !userAgentOs) {
    add(diagnostics, "identity", "identity.userAgent.os.unknown", `${prefix}navigator.userAgent`, "warning", "The operating system is not known from the user agent.");
  }
  if (userAgentOs && platformValue) {
    const platformOs = detectPlatformOs(platformValue);
    if (!platformOs) {
      add(diagnostics, "identity", "identity.platform.unknown", `${prefix}navigator.platform`, "warning", "The platform is not one of the supported forms.");
    } else if (!compatibleOs(userAgentOs, platformOs)) {
      add(diagnostics, "identity", "identity.platform.os.mismatch", `${prefix}navigator.platform`, "error", "The platform disagrees with the user agent operating system.");
    }
  }
  if (userAgentOs && userAgentDataPlatform) {
    const dataOs = detectUserAgentDataOs(userAgentDataPlatform);
    if (!dataOs) {
      add(diagnostics, "identity", "identity.userAgentData.platform.unknown", `${prefix}navigator.userAgentData.platform`, "warning", "The user agent data platform is not known.");
    } else if (!compatibleOs(userAgentOs, dataOs)) {
      add(diagnostics, "identity", "identity.userAgentData.platform.mismatch", `${prefix}navigator.userAgentData.platform`, "error", "The user agent data platform disagrees with the user agent.");
    }
  }
  if (userAgentOs && oscpu) {
    const cpuOs = detectOscpuOs(oscpu);
    if (cpuOs && !compatibleOs(userAgentOs, cpuOs)) {
      add(diagnostics, "identity", "identity.oscpu.os.mismatch", `${prefix}navigator.oscpu`, "error", "The operating system field disagrees with the user agent.");
    }
  }

  const explicitArchitectures = [
    ["navigator.architecture", architectureValue],
    ["navigator.userAgentData.architecture", userAgentDataArchitecture],
  ] as const;
  const knownArchitectures: { path: string; family: Architecture }[] = [];
  for (const [path, value] of explicitArchitectures) {
    if (!value) continue;
    const family = classifyArchitecture(value);
    if (!family) {
      add(diagnostics, "identity", "identity.architecture.unknown", `${prefix}${path}`, "warning", "The architecture is not a known form.");
    } else {
      knownArchitectures.push({ path, family });
    }
  }
  if (userAgent) {
    const userAgentArchitecture = classifyArchitecture(userAgent);
    if (userAgentArchitecture) knownArchitectures.push({ path: "navigator.userAgent", family: userAgentArchitecture });
  }
  if (knownArchitectures.length > 1) {
    const first = knownArchitectures[0]!;
    for (const current of knownArchitectures.slice(1)) {
      if (first.family !== current.family) {
        add(diagnostics, "identity", "identity.architecture.mismatch", `${prefix}${current.path}`, "error", "The architecture disagrees with another identity field.");
      }
    }
  }

  const screenWidth = checkPositiveNumber(identity, "screen.width", prefix, diagnostics);
  const screenHeight = checkPositiveNumber(identity, "screen.height", prefix, diagnostics);
  const availWidth = checkPositiveNumber(identity, "screen.availWidth", prefix, diagnostics);
  const availHeight = checkPositiveNumber(identity, "screen.availHeight", prefix, diagnostics);
  const colorDepth = checkPositiveNumber(identity, "screen.colorDepth", prefix, diagnostics);
  const pixelDepth = checkPositiveNumber(identity, "screen.pixelDepth", prefix, diagnostics);
  if (screenWidth !== undefined && availWidth !== undefined && availWidth > screenWidth) {
    add(diagnostics, "identity", "screen.available.width.invalid", `${prefix}screen.availWidth`, "error", "The available width exceeds the screen width.");
  }
  if (screenHeight !== undefined && availHeight !== undefined && availHeight > screenHeight) {
    add(diagnostics, "identity", "screen.available.height.invalid", `${prefix}screen.availHeight`, "error", "The available height exceeds the screen height.");
  }
  if (colorDepth !== undefined && pixelDepth !== undefined && colorDepth !== pixelDepth) {
    add(diagnostics, "identity", "screen.depth.mismatch", `${prefix}screen.pixelDepth`, "error", "The pixel depth disagrees with the color depth.");
  }

  const innerWidth = checkPositiveNumber(identity, "window.innerWidth", prefix, diagnostics);
  const innerHeight = checkPositiveNumber(identity, "window.innerHeight", prefix, diagnostics);
  const outerWidth = checkPositiveNumber(identity, "window.outerWidth", prefix, diagnostics);
  const outerHeight = checkPositiveNumber(identity, "window.outerHeight", prefix, diagnostics);
  if (innerWidth !== undefined && outerWidth !== undefined && innerWidth > outerWidth) {
    add(diagnostics, "identity", "window.geometry.width.invalid", `${prefix}window.innerWidth`, "error", "The inner width exceeds the outer width.");
  }
  if (innerHeight !== undefined && outerHeight !== undefined && innerHeight > outerHeight) {
    add(diagnostics, "identity", "window.geometry.height.invalid", `${prefix}window.innerHeight`, "error", "The inner height exceeds the outer height.");
  }
  checkPositiveNumber(identity, "window.devicePixelRatio", prefix, diagnostics, "finite");
  checkPositiveNumber(identity, "navigator.hardwareConcurrency", prefix, diagnostics);
  checkPositiveNumber(identity, "navigator.deviceMemory", prefix, diagnostics, "finite");

  const macOs = userAgentOs === "macos" || (oscpu ? detectOscpuOs(oscpu) === "macos" : false);
  for (const prefixName of ["webGl:", "webGl2:"]) {
    for (const suffix of ["vendor", "renderer", "version"]) {
      const key = `${prefixName}${suffix}`;
      const value = checkString(identity, key, prefix, diagnostics);
      if (macOs && suffix === "renderer" && value && DIRECT3D.test(value)) {
        add(diagnostics, "identity", "webgl.renderer.direct3d_on_macos", `${prefix}${key}`, "error", "A macOS GPU renderer cannot report a Direct3D backend.");
      }
    }
    if (hasOwn(identity, `${prefixName}parameters`) && !isRecord(identity[`${prefixName}parameters`])) {
      add(diagnostics, "schema", "webgl.parameters.object", `${prefix}${prefixName}parameters`, "error", "The WebGL parameters must be an object.");
    }
    if (hasOwn(identity, `${prefixName}supportedExtensions`)) {
      const extensions = identity[`${prefixName}supportedExtensions`];
      if (!Array.isArray(extensions) || extensions.some(extension => typeof extension !== "string")) {
        add(diagnostics, "schema", "webgl.extensions.array", `${prefix}${prefixName}supportedExtensions`, "error", "The supported extensions must be an array of strings.");
      }
    }
  }
}

function validatePreferences(
  preferences: unknown,
  prefix: string,
  identity: RecordValue,
  diagnostics: InternalDiagnostic[],
): void {
  if (!isRecord(preferences)) {
    add(diagnostics, "schema", "preferences.object", prefix.slice(0, -1), "error", "The fingerprint preferences must be an object.");
    return;
  }
  for (const key of WEBGL_PREFERENCE_PATHS) {
    if (hasOwn(preferences, key) && typeof preferences[key] !== "boolean") {
      add(diagnostics, "schema", "preferences.value.type", `${prefix}${key}`, "error", "The WebGL preference must be a boolean.");
    }
  }

  const hasWebGl1Parameters = hasOwn(identity, "webGl:parameters");
  const webGl2Keys = Object.keys(identity).filter(key => key.startsWith("webGl2:"));
  const hasWebGl2Parameters = hasOwn(identity, "webGl2:parameters");
  const enableWebGl2 = preferences["webgl.enable-webgl2"];
  if (enableWebGl2 === false && webGl2Keys.length > 0) {
    add(diagnostics, "identity", "webgl.pref.enable2.disabled", `${prefix}webgl.enable-webgl2`, "error", "The WebGL2 preference is disabled while WebGL2 fields are present.");
  }
  if (enableWebGl2 === true && hasWebGl1Parameters && !hasWebGl2Parameters) {
    add(diagnostics, "identity", "webgl.pref.enable2.capabilities.missing", `${prefix}webgl.enable-webgl2`, "error", "The WebGL2 preference is enabled while the saved GPU has no WebGL2 parameters.");
  }
  if (preferences["webgl.disabled"] === true) {
    const webGlKeys = Object.keys(identity).filter(key => key.startsWith("webGl:") || key.startsWith("webGl2:"));
    if (webGlKeys.length > 0) {
      add(diagnostics, "identity", "webgl.pref.disabled.contradiction", `${prefix}webgl.disabled`, "error", "WebGL is disabled while WebGL fingerprint fields are present.");
    }
  }
  if (preferences["webgl.disabled"] === true && preferences["webgl.force-enabled"] === true) {
    add(diagnostics, "identity", "webgl.pref.force.conflict", `${prefix}webgl.force-enabled`, "error", "WebGL cannot be disabled and force-enabled at the same time.");
  }
}

function decodeSerialized(serialized: unknown): unknown {
  let text: string;
  if (typeof serialized === "string") {
    text = serialized;
  } else if (Array.isArray(serialized)) {
    if (serialized.some(chunk => typeof chunk !== "string")) throw new Error("Every serialized fingerprint chunk must be a string.");
    text = serialized.join("");
  } else if (isRecord(serialized)) {
    const chunks: { index: number; value: unknown }[] = [];
    for (const [name, value] of Object.entries(serialized)) {
      const match = CHUNK_NAME.exec(name);
      if (match) chunks.push({ index: Number(match[1]), value });
    }
    chunks.sort((a, b) => a.index - b.index);
    if (!chunks.length) throw new Error("No CAMOU_CONFIG chunks are present.");
    if (chunks.some((chunk, index) => chunk.index !== index + 1)) throw new Error("CAMOU_CONFIG chunks must be consecutive and start at 1.");
    const values: string[] = [];
    for (const chunk of chunks) {
      if (typeof chunk.value !== "string") throw new Error("Every CAMOU_CONFIG chunk must be a string.");
      values.push(chunk.value);
    }
    text = values.join("");
  } else {
    throw new Error("The serialized fingerprint must be a JSON string, string array, or CAMOU_CONFIG object.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("The serialized fingerprint is not valid JSON.");
  }
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => deepEqual(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) =>
    key === rightKeys[index] && deepEqual(left[key], right[key])
  );
}

/** Validate pin, candidate, effective, and serialized forms without normalization. */
export function validateFingerprint(
  input: FingerprintValidationInput,
  options: FingerprintValidationOptions = {},
): FingerprintValidationResult {
  const diagnostics: InternalDiagnostic[] = [];
  let sourceCount = 0;
  let pinPresent = false;
  let pinEngineValid = false;
  let pinEngineValue: string | undefined;
  let pinConfig: RecordValue | undefined;
  let effectiveIdentity: RecordValue | undefined;
  let serializedIdentity: unknown;

  if (!isRecord(input)) {
    add(diagnostics, "schema", "input.object", "input", "error", "The validator input must be an object.");
  } else {
    if (hasOwn(input, "pin")) {
      sourceCount++;
      pinPresent = true;
      if (!isRecord(input.pin)) {
        add(diagnostics, "schema", "pin.object", "pin", "error", "The fingerprint pin must be an object.");
      } else {
        const pin = input.pin;
        if (pin.version !== PIN_VERSION) {
          add(diagnostics, "schema", "pin.version", "pin.version", "error", "The fingerprint pin must use schema version 2.");
        }
        if (typeof pin.engineSha256 === "string" && ENGINE_SHA256.test(pin.engineSha256)) {
          pinEngineValid = true;
          pinEngineValue = pin.engineSha256;
        } else {
          add(diagnostics, "schema", "pin.engineSha256.format", "pin.engineSha256", "error", "The engine SHA-256 must use 64 lowercase hexadecimal digits.");
        }
        if (isRecord(pin.config)) {
          pinConfig = pin.config;
          validateIdentity(pin.config, "pin.config.", diagnostics);
        } else {
          add(diagnostics, "schema", "pin.config.object", "pin.config", "error", "The fingerprint pin config must be an object.");
        }
        if (hasOwn(pin, "preferences") && pin.preferences !== undefined) {
          validatePreferences(pin.preferences, "pin.preferences.", pinConfig ?? {}, diagnostics);
        }
      }
    }

    if (hasOwn(input, "newIdentity")) {
      sourceCount++;
      validateIdentity(input.newIdentity, "new.", diagnostics);
      if (isRecord(input.newIdentity) && hasOwn(input, "newPreferences") && input.newPreferences !== undefined) {
        validatePreferences(input.newPreferences, "newPreferences.", input.newIdentity, diagnostics);
      }
    } else if (hasOwn(input, "newPreferences") && input.newPreferences !== undefined) {
      add(diagnostics, "schema", "newPreferences.unbound", "newPreferences", "error", "New preferences need a new identity.");
    }

    if (hasOwn(input, "effectiveIdentity")) {
      sourceCount++;
      validateIdentity(input.effectiveIdentity, "effective.", diagnostics);
      if (isRecord(input.effectiveIdentity)) {
        effectiveIdentity = input.effectiveIdentity;
        if (hasOwn(input, "effectivePreferences") && input.effectivePreferences !== undefined) {
          validatePreferences(input.effectivePreferences, "effectivePreferences.", input.effectiveIdentity, diagnostics);
        }
      }
    } else if (hasOwn(input, "effectivePreferences") && input.effectivePreferences !== undefined) {
      add(diagnostics, "schema", "effectivePreferences.unbound", "effectivePreferences", "error", "Effective preferences need an effective identity.");
    }

    if (hasOwn(input, "serialized")) {
      sourceCount++;
      try {
        serializedIdentity = decodeSerialized(input.serialized);
        validateIdentity(serializedIdentity, "serialized.", diagnostics);
        if (isRecord(serializedIdentity) && hasOwn(input, "serializedPreferences") && input.serializedPreferences !== undefined) {
          validatePreferences(input.serializedPreferences, "serializedPreferences.", serializedIdentity, diagnostics);
        }
      } catch (error) {
        add(diagnostics, "schema", "serialized.parse", "serialized", "error",
          error instanceof Error ? error.message : "The serialized fingerprint is invalid.");
        if (hasOwn(input, "serializedPreferences") && input.serializedPreferences !== undefined) {
          validatePreferences(input.serializedPreferences, "serializedPreferences.", {}, diagnostics);
        }
      }
    } else if (hasOwn(input, "serializedPreferences") && input.serializedPreferences !== undefined) {
      add(diagnostics, "schema", "serializedPreferences.unbound", "serializedPreferences", "error", "Serialized preferences need a serialized identity.");
    }

    if (effectiveIdentity && serializedIdentity !== undefined && !deepEqual(effectiveIdentity, serializedIdentity)) {
      add(diagnostics, "schema", "serialized.identity.mismatch", "serialized", "error", "The serialized identity differs from the effective identity.");
    }
    if (sourceCount === 0) {
      add(diagnostics, "schema", "input.source.missing", "input", "error", "The validator needs a pin, identity, or serialized fingerprint.");
    }
  }

  let engineSha256: CheckStatus = pinPresent ? "FAIL" : "NOT_APPLICABLE";
  if (pinPresent && pinEngineValid) {
    if (options.expectedEngineSha256 === undefined) {
      engineSha256 = "NOT_RUN";
      add(diagnostics, "engine", "engineSha256.NOT_RUN", "engineSha256",
        options.admissionRequired ? "error" : "warning", "The executable SHA-256 was not supplied.");
    } else if (!ENGINE_SHA256.test(options.expectedEngineSha256)) {
      add(diagnostics, "engine", "engineSha256.expected.format", "engineSha256.expected", "error", "The executable SHA-256 must use 64 lowercase hexadecimal digits.");
    } else if (options.expectedEngineSha256 === pinEngineValue) {
      engineSha256 = "PASS";
    } else {
      add(diagnostics, "engine", "engineSha256.mismatch", "pin.engineSha256", "error", "The pinned engine SHA-256 differs from the executable SHA-256.");
    }
  }

  const schemaFailed = diagnostics.some(diagnostic => diagnostic.kind === "schema" && diagnostic.severity === "error");
  const identityFailed = diagnostics.some(diagnostic => diagnostic.kind === "identity" && diagnostic.severity === "error");
  const staticValid = !schemaFailed && !identityFailed && engineSha256 !== "FAIL";
  const runtime = options.runtime?.status ?? "NOT_RUN";
  if (options.runtime) diagnostics.push(...options.runtime.diagnostics.map(diagnostic => ({ ...diagnostic, kind: "identity" as const })));
  if (runtime === "NOT_RUN") {
    add(diagnostics, "identity", "runtime.NOT_RUN", "runtime", options.admissionRequired ? "error" : "warning",
      "Headed runtime observations were not checked.");
  }
  const admissionBlocked = !staticValid || runtime === "FAIL" ||
    (options.admissionRequired === true && (runtime !== "PASS" || (pinPresent && engineSha256 !== "PASS")));

  return Object.freeze({
    staticValid,
    schema: schemaFailed ? "FAIL" : "PASS",
    engineSha256,
    runtime,
    admissionBlocked,
    diagnostics: normalizeFingerprintDiagnostics(diagnostics),
  });
}

export function validateSavedFingerprint(
  pin: unknown,
  options: FingerprintValidationOptions = {},
): FingerprintValidationResult {
  return validateFingerprint({ pin }, options);
}

export function validateNewFingerprint(
  identity: unknown,
  preferences?: unknown,
  options: FingerprintValidationOptions = {},
): FingerprintValidationResult {
  return validateFingerprint({
    newIdentity: identity,
    ...(preferences === undefined ? {} : { newPreferences: preferences }),
  }, options);
}

export function validateEffectiveFingerprint(
  identity: unknown,
  preferences?: unknown,
  options: FingerprintValidationOptions = {},
): FingerprintValidationResult {
  return validateFingerprint({
    effectiveIdentity: identity,
    ...(preferences === undefined ? {} : { effectivePreferences: preferences }),
  }, options);
}

export function validateSerializedFingerprint(
  serialized: SerializedFingerprint,
  preferences?: unknown,
  options: FingerprintValidationOptions = {},
): FingerprintValidationResult {
  return validateFingerprint({
    serialized,
    ...(preferences === undefined ? {} : { serializedPreferences: preferences }),
  }, options);
}

function runtimeDiagnostics(expected: RecordValue, observed: RecordValue, input: RuntimeObservationInput) {
  const diagnostics: InternalDiagnostic[] = [];
  const supported = input.supportedPaths ?? [];
  if (supported.some(path => typeof path !== "string" || !path)) {
    add(diagnostics, "identity", "runtime.supportedPath.invalid", "supportedPaths", "error", "Every supported runtime path must be a non-empty string.");
  }
  const required = new Set<string>(supported.filter(path => typeof path === "string" && Boolean(path)));
  for (const path of RUNTIME_PATHS) {
    if (hasOwn(expected, path)) required.add(path);
  }
  for (const path of [...required].sort()) {
    if (!hasOwn(expected, path)) {
      add(diagnostics, "identity", "runtime.expectedPath.missing", `expected.${path}`, "error", "The expected identity does not contain the supported runtime path.");
    } else if (!hasOwn(observed, path)) {
      add(diagnostics, "identity", "runtime.observedPath.missing", `observed.${path}`, "error", "The headed observation did not contain a supported runtime path.");
    } else if (!deepEqual(expected[path], observed[path])) {
      add(diagnostics, "identity", "runtime.value.mismatch", `observed.${path}`, "error", "The headed observation differs from the expected identity.");
    }
  }
  for (const path of RUNTIME_PATHS) {
    if (hasOwn(observed, path) && !hasOwn(expected, path)) {
      add(diagnostics, "identity", "runtime.observedPath.unexpected", `observed.${path}`, "warning", "The headed observation has a stable path that the expected identity does not contain.");
    }
  }

  const expectedPreferences = isRecord(input.expectedPreferences) ? input.expectedPreferences : undefined;
  const observedPreferences = isRecord(input.observedPreferences) ? input.observedPreferences : undefined;
  if (input.expectedPreferences !== undefined && !expectedPreferences) {
    add(diagnostics, "identity", "runtime.expectedPreferences.object", "expectedPreferences", "error", "The expected preferences must be an object.");
  }
  if (input.observedPreferences !== undefined && !observedPreferences) {
    add(diagnostics, "identity", "runtime.observedPreferences.object", "observedPreferences", "error", "The observed preferences must be an object.");
  }
  if (expectedPreferences) {
    for (const path of WEBGL_PREFERENCE_PATHS) {
      if (!hasOwn(expectedPreferences, path)) continue;
      required.add(`preferences.${path}`);
      if (!observedPreferences || !hasOwn(observedPreferences, path)) {
        add(diagnostics, "identity", "runtime.preference.missing", `observedPreferences.${path}`, "error", "The headed observation did not contain a supported WebGL preference.");
      } else if (!deepEqual(expectedPreferences[path], observedPreferences[path])) {
        add(diagnostics, "identity", "runtime.preference.mismatch", `observedPreferences.${path}`, "error", "The headed WebGL preference differs from the expected preference.");
      }
    }
  }
  return { diagnostics, compared: required.size };
}

/** Compare new browser measurements to the expected identity. Geometry is exact and has no chrome allowance. */
export function validateRuntimeObservation(input: RuntimeObservationInput): RuntimeValidationResult {
  if (!isRecord(input.expectedIdentity)) {
    return Object.freeze({ status: "FAIL", diagnostics: normalizeFingerprintDiagnostics([
      { code: "runtime.expectedIdentity.object", path: "expectedIdentity", severity: "error", message: "The expected identity must be an object." },
    ]) });
  }
  if (!isRecord(input.observedIdentity)) {
    return Object.freeze({ status: "NOT_RUN", diagnostics: Object.freeze([]) });
  }
  const result = runtimeDiagnostics(input.expectedIdentity, input.observedIdentity, input);
  const failed = result.diagnostics.some(diagnostic => diagnostic.severity === "error");
  return Object.freeze({
    status: failed ? "FAIL" : result.compared > 0 ? "PASS" : "NOT_RUN",
    diagnostics: normalizeFingerprintDiagnostics(result.diagnostics),
  });
}
