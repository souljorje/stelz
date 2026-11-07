import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeFingerprintDiagnostics,
  validateEffectiveFingerprint,
  validateFingerprint,
  validateNewFingerprint,
  validateRuntimeObservation,
  validateSavedFingerprint,
  validateSerializedFingerprint,
} from "../../src/browser/fingerprint-validation.ts";

const identity = {
  "navigator.userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0",
  "navigator.platform": "MacIntel",
  "navigator.oscpu": "Intel Mac OS X 10.15",
  "navigator.userAgentData": { platform: "macOS", architecture: "arm" },
  "navigator.hardwareConcurrency": 10,
  "navigator.deviceMemory": 16,
  "screen.width": 1728,
  "screen.height": 1117,
  "screen.availWidth": 1728,
  "screen.availHeight": 1085,
  "screen.colorDepth": 24,
  "screen.pixelDepth": 24,
  "window.innerWidth": 1536,
  "window.innerHeight": 864,
  "window.outerWidth": 1572,
  "window.outerHeight": 952,
  "window.devicePixelRatio": 2,
  "webGl:vendor": "Mozilla",
  "webGl:renderer": "ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 (0x00002684) Metal, Metal)",
  "webGl:version": "WebGL 1.0",
  "webGl:parameters": { 37445: 1 },
  "webGl:supportedExtensions": ["EXT_texture_filter_anisotropic", "WEBGL_debug_renderer_info"],
  "webGl2:vendor": "Mozilla",
  "webGl2:renderer": "ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 (0x00002684) Metal, Metal)",
  "webGl2:version": "WebGL 2.0",
  "webGl2:parameters": { 37445: 1 },
  "webGl2:supportedExtensions": ["EXT_color_buffer_float"],
};

const preferences = { "webgl.enable-webgl2": true };
const engineHash = "a".repeat(64);

function diagnosticCodes(result: ReturnType<typeof validateFingerprint>): string[] {
  return result.diagnostics.map(diagnostic => diagnostic.code);
}

test("diagnostic normalization projects public fields, deduplicates, and preserves stable ordering", () => {
  const input = Object.freeze([
    Object.freeze({ code: "z", path: "pin", severity: "warning" as const, message: "Last", kind: "engine" }),
    Object.freeze({ code: "a", path: "pin.z", severity: "warning" as const, message: "Later path", kind: "identity" }),
    Object.freeze({ code: "a", path: "pin.a", severity: "warning" as const, message: "Warning", kind: "schema" }),
    Object.freeze({ code: "a", path: "pin.a", severity: "error" as const, message: "First", kind: "schema", privateValue: "hidden" }),
    Object.freeze({ code: "a", path: "pin.a", severity: "error" as const, message: "First", kind: "identity", privateValue: "different" }),
    Object.freeze({ code: "a", path: "pin.a", severity: "error" as const, message: "Second", kind: "engine" }),
  ]);
  const before = structuredClone(input), result = normalizeFingerprintDiagnostics(input);
  assert.deepEqual(result, [
    { code: "a", path: "pin.a", severity: "error", message: "First" },
    { code: "a", path: "pin.a", severity: "error", message: "Second" },
    { code: "a", path: "pin.a", severity: "warning", message: "Warning" },
    { code: "a", path: "pin.z", severity: "warning", message: "Later path" },
    { code: "z", path: "pin", severity: "warning", message: "Last" },
  ]);
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(input, before);
});

test("known Direct3D suffixes are invalid on macOS while NVIDIA ANGLE OpenGL is valid", () => {
  for (const suffix of [9, 10, 11, 12]) {
    const result = validateNewFingerprint({
      ...identity,
      "webGl:renderer": `ANGLE (NVIDIA, NVIDIA GTX 980 Direct3D${suffix})`,
    }, preferences);
    assert.equal(result.staticValid, false);
    assert.ok(diagnosticCodes(result).includes("webgl.renderer.direct3d_on_macos"));
  }

  const openGl = validateNewFingerprint({
    ...identity,
    "webGl:renderer": "ANGLE (NVIDIA, NVIDIA GeForce RTX 4090, OpenGL 4.6)",
  }, preferences);
  assert.equal(openGl.staticValid, true);
});

test("an uncommon NVIDIA ANGLE GPU and MacIntel are valid on Apple silicon", () => {
  const result = validateNewFingerprint(identity, preferences);
  assert.equal(result.staticValid, true);
  assert.equal(result.engineSha256, "NOT_APPLICABLE");
  assert.equal(result.runtime, "NOT_RUN");
  assert.equal(result.diagnostics.some(diagnostic => diagnostic.severity === "error"), false);
});

test("pin schema and engine hash results stay separate", () => {
  const malformed = validateSavedFingerprint({ version: 1, engineSha256: "bad", config: identity }, {
    expectedEngineSha256: engineHash,
  });
  assert.equal(malformed.staticValid, false);
  assert.equal(malformed.schema, "FAIL");
  assert.equal(malformed.engineSha256, "FAIL");
  assert.ok(diagnosticCodes(malformed).includes("pin.version"));
  assert.ok(diagnosticCodes(malformed).includes("pin.engineSha256.format"));

  const unchecked = validateSavedFingerprint({ version: 2, engineSha256: engineHash, config: identity });
  assert.equal(unchecked.staticValid, true);
  assert.equal(unchecked.schema, "PASS");
  assert.equal(unchecked.engineSha256, "NOT_RUN");
  assert.equal(unchecked.runtime, "NOT_RUN");
  assert.equal(unchecked.admissionBlocked, false);

  const admission = validateSavedFingerprint({ version: 2, engineSha256: engineHash, config: identity }, {
    admissionRequired: true,
  });
  assert.equal(admission.staticValid, true);
  assert.equal(admission.admissionBlocked, true);
  assert.ok(admission.diagnostics.some(diagnostic =>
    diagnostic.code === "engineSha256.NOT_RUN" && diagnostic.severity === "error"
  ));

  const mismatch = validateSavedFingerprint({ version: 2, engineSha256: engineHash, config: identity }, {
    expectedEngineSha256: "b".repeat(64),
  });
  assert.equal(mismatch.staticValid, false);
  assert.equal(mismatch.engineSha256, "FAIL");
  assert.ok(diagnosticCodes(mismatch).includes("engineSha256.mismatch"));
});

test("missing new pin state does not make a new identity invalid", () => {
  const result = validateFingerprint({ newIdentity: identity, newPreferences: preferences });
  assert.equal(result.staticValid, true);
  assert.equal(result.schema, "PASS");
  assert.equal(result.engineSha256, "NOT_APPLICABLE");
});

test("omitted and undefined preferences are absent while null remains invalid", () => {
  const validators: [string, (preferences?: unknown) => ReturnType<typeof validateFingerprint>][] = [
    ["new", value => validateNewFingerprint(identity, value)],
    ["effective", value => validateEffectiveFingerprint(identity, value)],
    ["serialized", value => validateSerializedFingerprint(JSON.stringify(identity), value)],
  ];
  for (const [stage, validate] of validators) {
    for (const [label, value] of [["omitted", undefined], ["undefined", undefined], ["empty", {}]] as const) {
      const result = label === "omitted" ? validate() : validate(value);
      assert.equal(result.staticValid, true, `${stage} ${label}`);
    }
    const invalid = validate(null);
    assert.equal(invalid.staticValid, false, `${stage} null`);
    assert.ok(diagnosticCodes(invalid).includes("preferences.object"), `${stage} null diagnostic`);
  }

  const topLevel = validateFingerprint({
    newIdentity: identity,
    newPreferences: undefined,
    effectiveIdentity: identity,
    effectivePreferences: undefined,
    serialized: JSON.stringify(identity),
    serializedPreferences: undefined,
  });
  assert.equal(topLevel.staticValid, true);

  for (const result of [
    validateNewFingerprint(identity, undefined, { admissionRequired: false }),
    validateEffectiveFingerprint(identity, undefined, { admissionRequired: false }),
    validateSerializedFingerprint(JSON.stringify(identity), undefined, { admissionRequired: false }),
  ]) {
    assert.equal(result.staticValid, true);
    assert.equal(diagnosticCodes(result).includes("preferences.object"), false);
  }

  for (const input of [
    { newIdentity: identity, newPreferences: null },
    { effectiveIdentity: identity, effectivePreferences: null },
    { serialized: JSON.stringify(identity), serializedPreferences: null },
  ]) {
    const invalid = validateFingerprint(input);
    assert.equal(invalid.staticValid, false);
    assert.ok(diagnosticCodes(invalid).includes("preferences.object"));
  }
});

test("geometry bounds and positive finite hardware values are checked conservatively", () => {
  const invalid = validateEffectiveFingerprint({
    ...identity,
    "screen.availWidth": 1900,
    "window.innerHeight": 1000,
    "window.outerHeight": 900,
    "window.devicePixelRatio": Number.POSITIVE_INFINITY,
    "navigator.hardwareConcurrency": 0,
  }, preferences);
  assert.equal(invalid.staticValid, false);
  const codes = diagnosticCodes(invalid);
  assert.ok(codes.includes("screen.available.width.invalid"));
  assert.ok(codes.includes("window.geometry.height.invalid"));
  assert.ok(codes.includes("geometry.value.invalid"));

  for (const difference of [0, 211]) {
    const valid = validateEffectiveFingerprint({
      ...identity,
      "window.outerHeight": identity["window.innerHeight"] + difference,
    }, preferences);
    assert.equal(valid.staticValid, true);
  }
});

test("WebGL preference and capability contradictions block static validity", () => {
  const disabled = validateEffectiveFingerprint(identity, { "webgl.enable-webgl2": false });
  assert.equal(disabled.staticValid, false);
  assert.ok(diagnosticCodes(disabled).includes("webgl.pref.enable2.disabled"));

  const withoutWebGl2 = Object.fromEntries(Object.entries(identity).filter(([key]) => !key.startsWith("webGl2:")));
  const missingCapabilities = validateEffectiveFingerprint(withoutWebGl2, preferences);
  assert.equal(missingCapabilities.staticValid, false);
  assert.ok(diagnosticCodes(missingCapabilities).includes("webgl.pref.enable2.capabilities.missing"));
});

test("serialized identity checks JSON and does not normalize effective input", () => {
  const serialized = JSON.stringify(identity);
  const result = validateFingerprint({
    effectiveIdentity: identity,
    effectivePreferences: preferences,
    serialized,
    serializedPreferences: preferences,
  });
  assert.equal(result.staticValid, true);

  const malformed = validateSerializedFingerprint("{\"navigator.userAgent\":", preferences);
  assert.equal(malformed.staticValid, false);
  assert.ok(diagnosticCodes(malformed).includes("serialized.parse"));

  const mismatch = validateFingerprint({
    effectiveIdentity: identity,
    serialized: JSON.stringify({ ...identity, "navigator.platform": "Win32" }),
  });
  assert.equal(mismatch.staticValid, false);
  assert.ok(diagnosticCodes(mismatch).includes("serialized.identity.mismatch"));

  const chunk = JSON.stringify(identity);
  const chunked = validateSerializedFingerprint({ CAMOU_CONFIG_1: chunk });
  const split = validateSerializedFingerprint([chunk.slice(0, 40), chunk.slice(40)]);
  assert.equal(chunked.staticValid, true);
  assert.equal(split.staticValid, true);
});

test("oscpu operating systems are recognized conservatively", () => {
  const mac = validateNewFingerprint(identity, preferences);
  assert.equal(mac.staticValid, true);

  const windowsIdentity = {
    ...identity,
    "navigator.userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0",
    "navigator.platform": "Win32",
    "navigator.userAgentData": { platform: "Windows", architecture: "x86" },
    "navigator.oscpu": "Windows NT 10.0; Win64; x64",
    "webGl:renderer": "ANGLE (NVIDIA, NVIDIA GTX 980 Direct3D11)",
    "webGl2:renderer": "ANGLE (NVIDIA, NVIDIA GTX 980 Direct3D11)",
  };
  assert.equal(validateNewFingerprint(windowsIdentity, preferences).staticValid, true);

  const mismatch = validateNewFingerprint({ ...windowsIdentity, "navigator.oscpu": "Intel Mac OS X 10.15" }, preferences);
  assert.equal(mismatch.staticValid, false);
  assert.ok(diagnosticCodes(mismatch).includes("identity.oscpu.os.mismatch"));
});

test("static validity, runtime NOT_RUN, and runtime failure remain distinct", () => {
  const runtimeNotRun = validateEffectiveFingerprint(identity, preferences, { admissionRequired: true });
  assert.equal(runtimeNotRun.staticValid, true);
  assert.equal(runtimeNotRun.runtime, "NOT_RUN");
  assert.equal(runtimeNotRun.admissionBlocked, true);

  const runtime = validateRuntimeObservation({ expectedIdentity: identity, observedIdentity: identity, expectedPreferences: preferences,
    observedPreferences: { ...preferences } });
  assert.equal(runtime.status, "PASS");

  const admitted = validateEffectiveFingerprint(identity, preferences, { admissionRequired: true, runtime });
  assert.equal(admitted.staticValid, true);
  assert.equal(admitted.runtime, "PASS");
  assert.equal(admitted.admissionBlocked, false);

  const failedRuntime = validateRuntimeObservation({
    expectedIdentity: identity,
    observedIdentity: { ...identity, "webGl:renderer": "Different GPU" },
    expectedPreferences: preferences,
    observedPreferences: preferences,
  });
  assert.equal(failedRuntime.status, "FAIL");
  const rejected = validateEffectiveFingerprint(identity, preferences, { runtime: failedRuntime });
  assert.equal(rejected.staticValid, true);
  assert.equal(rejected.runtime, "FAIL");
  assert.equal(rejected.admissionBlocked, true);
});

test("validation preserves identity, preferences, and serialized values", () => {
  const preservedIdentity = structuredClone(identity);
  const preservedPreferences = structuredClone(preferences);
  Object.freeze(preservedIdentity["navigator.userAgentData"]);
  Object.freeze(preservedIdentity["webGl:parameters"]);
  Object.freeze(preservedIdentity["webGl:supportedExtensions"]);
  Object.freeze(preservedIdentity["webGl2:parameters"]);
  Object.freeze(preservedIdentity["webGl2:supportedExtensions"]);
  Object.freeze(preservedIdentity);
  Object.freeze(preservedPreferences);
  const serialized = JSON.stringify(preservedIdentity);
  const beforeIdentity = structuredClone(preservedIdentity);
  const beforePreferences = structuredClone(preservedPreferences);

  const result = validateFingerprint({
    newIdentity: preservedIdentity,
    newPreferences: preservedPreferences,
    effectiveIdentity: preservedIdentity,
    effectivePreferences: preservedPreferences,
    serialized,
    serializedPreferences: preservedPreferences,
  });

  assert.equal(result.staticValid, true);
  assert.deepEqual(preservedIdentity, beforeIdentity);
  assert.deepEqual(preservedPreferences, beforePreferences);
  assert.equal(serialized, JSON.stringify(beforeIdentity));
});
