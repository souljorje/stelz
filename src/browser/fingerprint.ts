import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Device profile is persistent; location, session state and security policy are not. */
export type Fingerprint = Record<string, unknown>;
export type LaunchOptions = { env?: Record<string, string>; firefoxUserPrefs?: Fingerprint; proxy?: Record<string, unknown> };

// Classification follows camoufox-profile-manager's device/runtime distinction.
// See THIRD_PARTY_NOTICES.md. Keep this allowlist small and test observable output.
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

export function applyFingerprint(options: LaunchOptions, stateDir: string, binary: string, proxied: boolean) {
  if (proxied && !options.proxy) throw Error("Proxy launch configuration is missing; direct fallback is disabled");
  const env = options.env || {};
  const chunks = Object.entries(env)
    .filter(([key]) => /^CAMOU_CONFIG_[1-9]\d*$/.test(key))
    .sort(([a], [b]) => Number(a.split("_").at(-1)) - Number(b.split("_").at(-1)));
  if (!chunks.length || chunks.some(([key], index) => key !== `CAMOU_CONFIG_${index + 1}`)) {
    throw Error("Missing/incomplete generated fingerprint");
  }

  const generated = JSON.parse(chunks.map(([, value]) => value).join("")) as Fingerprint;
  const path = join(stateDir, "fingerprint.json");
  const engineSha256 = createHash("sha256").update(readFileSync(binary)).digest("hex");
  type Pin = { version: number; engineSha256: string; config: Fingerprint };
  let pin: Pin;
  if (existsSync(path)) {
    pin = JSON.parse(readFileSync(path, "utf8")) as Pin;
    if (![1, 2].includes(pin.version) || pin.engineSha256 !== engineSha256 ||
      typeof pin.config?.["navigator.userAgent"] !== "string" || !pin.config["navigator.userAgent"]) {
      throw Error("Fingerprint pin is corrupt or browser binary changed; explicit migration required");
    }
  } else {
    if (!generated["navigator.userAgent"]) throw Error("Generated fingerprint has no user agent");
    pin = { version: 2, engineSha256, config: freezeDevice(generated) };
    writeFileSync(path, JSON.stringify(pin, null, 2), { mode: 0o600, flag: "wx" });
  }

  const effective = applyProxyLocale(replayFingerprint(pin.config, generated), proxied);
  for (const [key] of chunks) delete env[key];
  const serialized = JSON.stringify(effective);
  for (let offset = 0; offset < serialized.length; offset += 32767) {
    env[`CAMOU_CONFIG_${offset / 32767 + 1}`] = serialized.slice(offset, offset + 32767);
  }
  options.env = env;
  options.firefoxUserPrefs = launchPreferences(options.firefoxUserPrefs, proxied, pin.config);
  if (options.proxy) options.proxy.bypass = "127.0.0.1,localhost";
  const fingerprintSha256 = createHash("sha256").update(JSON.stringify(freezeDevice(pin.config))).digest("hex");
  return { fingerprintSha256, engineSha256 };
}
