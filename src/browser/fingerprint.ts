import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { stageFingerprint, type FingerprintOwner } from "./fingerprint-transaction.ts";
import { validateFingerprint } from "./fingerprint-validation.ts";
import { launcher } from "./camoufox.ts";

/** Device profile is persistent; location, session state and security policy are not. */
export type Fingerprint = Record<string, unknown>;
export type LaunchOptions = { env?: Record<string, string>; executablePath?: string; firefoxUserPrefs?: Fingerprint; proxy?: Record<string, unknown> };

// Classification follows camoufox-profile-manager's device/runtime distinction.
// Keep this allowlist small and test observable output.
const DEVICE_PREFIXES = [
  "navigator.", "screen.", "window.", "webGl:", "webGl2:", "webGl.", "webGl2.",
  "canvas:", "audio:", "fonts", "mediaDevices:", "voices", "AudioContext:",
];
// Window sizes follow the real window and engine chrome. Startup checks them against the real window.
const WINDOW_DIMENSIONS = ["window.innerWidth", "window.innerHeight", "window.outerWidth", "window.outerHeight"];
const RUNTIME_KEYS = new Set(["navigator.language", "navigator.languages", "window.history.length", "addons",
  ...WINDOW_DIMENSIONS]);

export function freezeDevice(config: Fingerprint): Fingerprint {
  return Object.fromEntries(Object.entries(config).filter(([key]) =>
    !RUNTIME_KEYS.has(key) && DEVICE_PREFIXES.some(prefix => key.startsWith(prefix))
  ));
}

export function replayFingerprint(saved: Fingerprint, generated: Fingerprint): Fingerprint {
  // Fresh upstream defaults (including future settings) survive. Only device fields replay.
  const device = freezeDevice(saved), effective = { ...generated, ...device };
  // A restored native window can differ from a fresh sample. Let Firefox report its real dimensions.
  for (const key of WINDOW_DIMENSIONS) delete effective[key];
  // The pinned sampler omits WebGL2 fields for GPUs that do not support it.
  if ("webGl:parameters" in device) {
    for (const key of Object.keys(effective)) {
      if (key.startsWith("webGl2:") && !(key in device)) delete effective[key];
    }
  }
  return effective;
}

/** Use the current proxy country's default language instead of resampling it on each launch. */
export function applyProxyLocale(config: Fingerprint, proxied: boolean): Fingerprint {
  const region = config["locale:region"];
  if (!proxied || typeof region !== "string" || !/^[A-Z]{2}$/.test(region) || config["locale:all"]) return config;
  const current = new Intl.Locale(`und-${region}`), maximized = current.maximize();
  if (maximized.region !== current.region) return config;
  const locale = maximized.minimize();
  if (locale.language === "und") return config;
  const effective: Fingerprint = { ...config, "locale:language": locale.language };
  if (locale.script) effective["locale:script"] = locale.script;
  else delete effective["locale:script"];
  return effective;
}

function chunkKeys(env: Record<string, string>, prefix: string) {
  const pattern = new RegExp(`^${prefix}_[1-9]\\d*$`);
  return Object.keys(env).filter(key => pattern.test(key)).sort((a, b) => Number(a.slice(prefix.length + 1)) - Number(b.slice(prefix.length + 1)));
}
/** Read launcher JSON split across numbered variables. Return undefined when no part exists. */
export function readChunks(env: Record<string, string>, prefix: "CAMOU_CONFIG" | "CAMOU_PREFS"): unknown {
  const keys = chunkKeys(env, prefix);
  if (!keys.length) return;
  if (keys.some((key, index) => key !== `${prefix}_${index + 1}`)) throw Error(`${prefix} is incomplete.`);
  try { return JSON.parse(keys.map(key => env[key]).join("")); }
  catch { throw Error(`${prefix} is invalid.`); }
}
/** Return the serialized launch config, or undefined when it is missing or invalid. */
export function readLaunchConfig(options: LaunchOptions): Fingerprint | undefined {
  try { return readChunks(options.env ?? {}, "CAMOU_CONFIG") as Fingerprint | undefined; } catch { return; }
}
/** Replace the serialized config with the upstream writer. Other variables, such as FONTCONFIG_FILE, stay. */
export function writeLaunchConfig(options: LaunchOptions, config: Fingerprint) {
  const env = options.env ?? {}, { getEnvVars, getTargetOs } = launcher();
  for (const key of chunkKeys(env, "CAMOU_CONFIG")) delete env[key];
  for (const [key, value] of Object.entries(getEnvVars(config, getTargetOs(config), options.executablePath)))
    if (key.startsWith("CAMOU_CONFIG_")) env[key] = String(value);
  options.env = env;
}
function writePreferences(env: Record<string, string>, preferences: Fingerprint) {
  for (const key of chunkKeys(env, "CAMOU_PREFS")) delete env[key];
  Object.assign(env, launcher().getPrefEnvVars(preferences));
}

export function launchPreferences(current: Fingerprint | undefined, proxied: boolean, device: Fingerprint = {}): Fingerprint {
  // Never replay old Firefox preferences. They include policy, not just profile.
  // Derive WebGL2 support from the saved GPU, not the newly sampled GPU.
  const capabilities = "webGl:parameters" in device ? { "webgl.enable-webgl2": "webGl2:parameters" in device } : {};
  // Spoofed coordinates must not grant location access to every site.
  const { "permissions.default.geo": _geo, ...policy } = current || {};
  // Apply the mandatory rule last, including when a direct profile switches to a proxy.
  return { ...policy, ...capabilities, ...(proxied ? {
    "media.peerconnection.enabled": false,
    "network.proxy.failover_direct": false,
    "network.proxy.socks_remote_dns": true,
    "network.proxy.socks5_remote_dns": true,
  } : {}) };
}

function requireStatic(result: ReturnType<typeof validateFingerprint>) {
  if (!result.staticValid) throw Error(`Fingerprint validation failed: ${result.diagnostics.filter(d => d.severity === "error").map(d => d.code).join(", ")}`);
}

export function applyFingerprint(options: LaunchOptions, stateDir: string, binary: string, proxied: boolean, owner: FingerprintOwner) {
  if (proxied && !options.proxy) throw Error("Proxy launch configuration is missing; direct fallback is disabled");
  const env = options.env || {};
  const generated = readLaunchConfig(options);
  if (!generated) throw Error("Missing/incomplete generated fingerprint");
  // The launcher serializes its preferences too. They must describe the same input.
  const launched = readChunks(env, "CAMOU_PREFS");
  if (launched !== undefined && !isDeepStrictEqual(launched, JSON.parse(JSON.stringify(options.firefoxUserPrefs ?? {}))))
    throw Error("Serialized Firefox preferences differ from launcher preferences.");
  const engineSha256 = createHash("sha256").update(readFileSync(binary)).digest("hex");
  type Pin = { version: number; engineSha256: string; config: Fingerprint };
  const journal = stageFingerprint(stateDir, owner, () => {
    const device = freezeDevice(generated);
    const preferences = launchPreferences(options.firefoxUserPrefs, proxied, device);
    requireStatic(validateFingerprint({ newIdentity: device, newPreferences: preferences }));
    return { version: 2, engineSha256, config: device };
  }, engineSha256);
  const pin = JSON.parse(journal.candidate) as Pin;
  // The launcher already ran coherence.apply on the generated config. The saved device fields overlay
  // that result, so apply never changes a pin. Validate the overlay, then validateFinalLaunch checks the env.
  const effective = applyProxyLocale(replayFingerprint(pin.config, generated), proxied);
  const preferences = launchPreferences(options.firefoxUserPrefs, proxied, pin.config);
  if (!isDeepStrictEqual(preferences, JSON.parse(JSON.stringify(preferences)))) throw Error("Serialized Firefox preferences differ from effective preferences.");
  requireStatic(validateFingerprint({ pin, effectiveIdentity: effective, effectivePreferences: preferences },
    { expectedEngineSha256: engineSha256 }));
  writeLaunchConfig(options, effective);
  writePreferences(env, preferences);
  options.firefoxUserPrefs = preferences;
  if (options.proxy) options.proxy.bypass = "127.0.0.1,localhost";
  const fingerprintSha256 = createHash("sha256").update(JSON.stringify(freezeDevice(pin.config))).digest("hex");
  return { fingerprintSha256, engineSha256, pinSha256: journal.sha256, pin, effective, preferences, owner };
}

/** The serialized launch must equal the validated config and preferences. */
export function validateFinalLaunch(options: LaunchOptions, prepared: ReturnType<typeof applyFingerprint>) {
  const env = options.env || {};
  if (!isDeepStrictEqual(readLaunchConfig(options), JSON.parse(JSON.stringify(prepared.effective))) ||
      !isDeepStrictEqual(options.firefoxUserPrefs, prepared.preferences) ||
      // The upstream writer omits empty preferences.
      !isDeepStrictEqual(readChunks(env, "CAMOU_PREFS") ?? {}, JSON.parse(JSON.stringify(prepared.preferences)))) throw Error("Fingerprint changed after validation.");
}
