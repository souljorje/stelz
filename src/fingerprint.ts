/** Device identity is persistent; location, session state and security policy are not. */
export type Fingerprint = Record<string, unknown>;

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

export function launchPreferences(current: Fingerprint | undefined, proxied: boolean, device: Fingerprint = {}): Fingerprint {
  // Never replay old Firefox preferences. They include policy, not just identity.
  // Derive WebGL2 support from the saved GPU, not the newly sampled GPU.
  const capabilities = "webGl:parameters" in device ? { "webgl.enable-webgl2": "webGl2:parameters" in device } : {};
  // Apply the mandatory rule last, including when a direct identity switches to a proxy.
  return { ...current, ...capabilities, ...(proxied ? { "media.peerconnection.enabled": false } : {}) };
}
