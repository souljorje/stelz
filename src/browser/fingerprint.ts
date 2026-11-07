import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { stageFingerprint, type FingerprintOwner } from "./fingerprint-transaction.ts";
import { validateFingerprint } from "./fingerprint-validation.ts";

/** Device profile is persistent; location, session state and security policy are not. */
export type Fingerprint = Record<string, unknown>;
export type LaunchOptions = { env?: Record<string, string>; firefoxUserPrefs?: Fingerprint; proxy?: Record<string, unknown> };

// Classification follows camoufox-profile-manager's device/runtime distinction.
// Keep this allowlist small and test observable output.
const DEVICE_PREFIXES = [
  "navigator.", "screen.", "window.", "webGl:", "webGl2:", "webGl.", "webGl2.",
  "canvas:", "audio:", "fonts", "mediaDevices:", "voices", "AudioContext:",
];
const RUNTIME_KEYS = new Set(["navigator.language", "navigator.languages", "window.history.length", "addons"]);

export function freezeDevice(config: Fingerprint): Fingerprint {
  return Object.fromEntries(Object.entries(config).filter(([key]) =>
    !RUNTIME_KEYS.has(key) && DEVICE_PREFIXES.some(prefix => key.startsWith(prefix))
  ));
}

export function replayFingerprint(saved: Fingerprint, generated: Fingerprint): Fingerprint {
  // Fresh upstream defaults (including future settings) survive. Only device fields replay.
  const device = freezeDevice(saved), effective = { ...generated, ...device };
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

export function launchPreferences(current: Fingerprint | undefined, proxied: boolean, device: Fingerprint = {}): Fingerprint {
  // Never replay old Firefox preferences. They include policy, not just profile.
  // Derive WebGL2 support from the saved GPU, not the newly sampled GPU.
  const capabilities = "webGl:parameters" in device ? { "webgl.enable-webgl2": "webGl2:parameters" in device } : {};
  // Apply the mandatory rule last, including when a direct profile switches to a proxy.
  return { ...current, ...capabilities, ...(proxied ? {
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
  const chunks = Object.entries(env)
    .filter(([key]) => /^CAMOU_CONFIG_[1-9]\d*$/.test(key))
    .sort(([a], [b]) => Number(a.split("_").at(-1)) - Number(b.split("_").at(-1)));
  if (!chunks.length || chunks.some(([key], index) => key !== `CAMOU_CONFIG_${index + 1}`)) {
    throw Error("Missing/incomplete generated fingerprint");
  }

  const generated = JSON.parse(chunks.map(([, value]) => value).join("")) as Fingerprint;
  const engineSha256 = createHash("sha256").update(readFileSync(binary)).digest("hex");
  type Pin = { version: number; engineSha256: string; config: Fingerprint };
  const journal = stageFingerprint(stateDir, owner, () => {
    const device = freezeDevice(generated);
    const preferences = launchPreferences(options.firefoxUserPrefs, proxied, device);
    requireStatic(validateFingerprint({ newIdentity: device, newPreferences: preferences }));
    return { version: 2, engineSha256, config: device };
  }, engineSha256);
  const pin = JSON.parse(journal.candidate) as Pin;
  const effective = applyProxyLocale(replayFingerprint(pin.config, generated), proxied);
  const preferences = launchPreferences(options.firefoxUserPrefs, proxied, pin.config);
  const serializedPreferences = JSON.parse(JSON.stringify(preferences)) as Fingerprint;
  if (!isDeepStrictEqual(preferences, serializedPreferences)) throw Error("Serialized Firefox preferences differ from effective preferences.");
  const preferenceChunks = Object.entries(env).filter(([key]) => /^CAMOU_PREFS_[1-9]\d*$/.test(key))
    .sort(([a], [b]) => Number(a.split("_").at(-1)) - Number(b.split("_").at(-1)));
  if (preferenceChunks.length) {
    if (preferenceChunks.some(([key], index) => key !== `CAMOU_PREFS_${index + 1}`)) throw Error("Serialized Firefox preferences are incomplete.");
    let serialized: unknown;
    try { serialized = JSON.parse(preferenceChunks.map(([, value]) => value).join("")); }
    catch { throw Error("Serialized Firefox preferences are invalid."); }
    if (!isDeepStrictEqual(serialized, preferences)) throw Error("Serialized Firefox preferences differ from effective preferences.");
  }
  requireStatic(validateFingerprint({ pin, effectiveIdentity: effective, effectivePreferences: preferences,
    serialized: JSON.stringify(effective), serializedPreferences },
    { expectedEngineSha256: engineSha256 }));
  for (const [key] of chunks) delete env[key];
  const serialized = JSON.stringify(effective);
  for (let offset = 0; offset < serialized.length; offset += 32767) {
    env[`CAMOU_CONFIG_${offset / 32767 + 1}`] = serialized.slice(offset, offset + 32767);
  }
  options.env = env;
  options.firefoxUserPrefs = preferences;
  if (options.proxy) options.proxy.bypass = "127.0.0.1,localhost";
  const fingerprintSha256 = createHash("sha256").update(JSON.stringify(freezeDevice(pin.config))).digest("hex");
  return { fingerprintSha256, engineSha256, pinSha256: journal.sha256, pin, effective, preferences, owner };
}

export function validateFinalLaunch(options: LaunchOptions, prepared: ReturnType<typeof applyFingerprint>) {
  const env = options.env || {};
  const chunks = Object.entries(env).filter(([key]) => /^CAMOU_CONFIG_[1-9]\d*$/.test(key))
    .sort(([a], [b]) => Number(a.split("_").at(-1)) - Number(b.split("_").at(-1)));
  if (!chunks.length || chunks.some(([key], index) => key !== `CAMOU_CONFIG_${index + 1}`)) throw Error("Serialized fingerprint is incomplete.");
  const effective = JSON.parse(chunks.map(([, value]) => value).join("")) as Fingerprint;
  if (!isDeepStrictEqual(freezeDevice(effective), freezeDevice(prepared.effective)) ||
      !isDeepStrictEqual(options.firefoxUserPrefs, prepared.preferences)) throw Error("Fingerprint changed after validation.");
  requireStatic(validateFingerprint({ pin: prepared.pin, effectiveIdentity: effective, effectivePreferences: prepared.preferences,
    serialized: Object.fromEntries(chunks), serializedPreferences: JSON.parse(JSON.stringify(options.firefoxUserPrefs)) },
    { expectedEngineSha256: prepared.engineSha256 }));
}
