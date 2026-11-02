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
  return { ...generated, ...freezeDevice(saved) };
}

export function launchPreferences(current: Fingerprint | undefined, proxied: boolean): Fingerprint {
  // Never replay old Firefox preferences. They include policy, not just identity.
  // Apply the mandatory rule last, including when a direct identity switches to a proxy.
  return { ...current, ...(proxied ? { "media.peerconnection.enabled": false } : {}) };
}
