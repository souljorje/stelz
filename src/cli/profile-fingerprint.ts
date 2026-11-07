import { existsSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE, HOME_DIR, STATE, dir, executable, validateSettings, type Profile } from "../profiles/config.ts";
import { checkCatalogDirectory, readCatalogFiles } from "../profiles/profile-catalog.ts";
import {
  checkSavedFingerprint,
  engineFileSha256,
  isEngineHashMismatch,
  readSavedFingerprint,
} from "../profiles/fingerprint-check.ts";
import type { FingerprintValidationResult } from "../browser/fingerprint-validation.ts";

export const fingerprintUsage = "stelz profile fingerprint check PROFILE [--json]";

type Input = { id: string; json: boolean };
class FingerprintCliError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "FingerprintCliError"; }
}
const validId = (id: string) => /^[a-z][a-z\d-]{0,63}$/.test(id) && id !== "all";
function invalid(): never { throw new FingerprintCliError("invalid_input", `Use: ${fingerprintUsage}`); }
function parse(args: string[]): Input {
  if (args[0] !== "check" || !args[1] || !validId(args[1])) invalid();
  let json = false;
  for (const arg of args.slice(2)) {
    if (arg === "--json" && !json) json = true;
    else invalid();
  }
  return { id: args[1], json };
}

type Output = {
  ok: boolean;
  format: "stelz-fingerprint-check";
  version: 1;
  profile: Pick<Profile, "id" | "name">;
  browserVerified: false;
  fingerprint: FingerprintValidationResult;
  error?: { code: string; message: string };
};
function resultOutput(profile: Profile, fingerprint: FingerprintValidationResult, error?: Output["error"]): Output {
  return { ok: !error, format: "stelz-fingerprint-check", version: 1,
    profile: { id: profile.id, ...(profile.name ? { name: profile.name } : {}) },
    browserVerified: false, fingerprint, ...(error ? { error } : {}) };
}
function errorOutput(profile: Pick<Profile, "id" | "name">, error: { code: string; message: string }) {
  return { ok: false, format: "stelz-fingerprint-check", version: 1,
    profile: { id: profile.id, ...(profile.name ? { name: profile.name } : {}) },
    browserVerified: false, error };
}
function human(output: Output) {
  const result = output.fingerprint;
  const lines = [
    `Fingerprint check for ${output.profile.id}`,
    `Static identity: ${result.staticValid ? "VALID" : "INVALID"}`,
    `Schema: ${result.schema}`,
    `Engine SHA-256: ${result.engineSha256}`,
    `Runtime: ${result.runtime}`,
    `Admission evidence: ${result.staticValid ? "INCOMPLETE" : "BLOCKED BY STATIC CHECKS"}`,
  ];
  for (const diagnostic of result.diagnostics)
    lines.push(`${diagnostic.severity.toUpperCase()} ${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`);
  lines.push("This static check does not verify a live browser or its readiness. Runtime identity, WebGL effects, and network/location were not observed.");
  if (output.error) lines.push(`${output.error.code}: ${output.error.message}`);
  return lines.join("\n");
}
function errorMessage(result: FingerprintValidationResult, engineUnavailable: boolean) {
  if (engineUnavailable) return { code: "fingerprint_engine_unavailable", message: "The Camoufox executable cannot be read, so the exact engine SHA-256 was not checked." };
  if (isEngineHashMismatch(result))
    return { code: "fingerprint_engine_mismatch", message: "The fingerprint pin uses a different Camoufox executable SHA-256." };
  if (!result.staticValid) return { code: "fingerprint_invalid", message: "The saved fingerprint has a static schema or identity error." };
  return undefined;
}

/** Read-only saved pin check. This path never starts a browser or takes a controller. */
export async function runProfileFingerprint(args: string[]) {
  const json = args.includes("--json");
  let selected: Profile | undefined;
  try {
    if (args.length === 1 && args[0] === "--help" || args.length === 2 && args[0] === "check" && args[1] === "--help") {
      console.log(fingerprintUsage); return;
    }
    const input = parse(args);
    if (!existsSync(CONFIG_FILE) || !existsSync(STATE))
      throw new FingerprintCliError("not_initialized", "Run stelz init first, using the same STELZ_HOME.");
    let profile: Profile | undefined;
    try {
      checkCatalogDirectory(HOME_DIR); checkCatalogDirectory(STATE);
      profile = validateSettings(JSON.parse(readCatalogFiles().config)).profiles.find(candidate => candidate.id === input.id);
      if (profile) checkCatalogDirectory(dir(profile.id), true);
    }
    catch { throw new FingerprintCliError("profile_unavailable", "Cannot read the profile configuration. Run stelz doctor and inspect the service files."); }
    if (!profile) throw new FingerprintCliError("profile_not_found", `Unknown profile: ${input.id}`);
    selected = profile;

    const read = await readSavedFingerprint(join(dir(profile.id), "fingerprint.json"));
    if (read.status === "missing") {
      const error = { code: "fingerprint_uninitialized", message: "The profile has no saved fingerprint pin." };
      console.error(json ? JSON.stringify(errorOutput(profile, error)) : `${error.code}: ${error.message}`);
      process.exitCode = 1; return;
    }

    let expectedEngineSha256: string | undefined, engineUnavailable = false;
    try { expectedEngineSha256 = await engineFileSha256(executable()); }
    catch { engineUnavailable = true; }
    const fingerprint = checkSavedFingerprint(read, {
      ...(expectedEngineSha256 ? { expectedEngineSha256 } : {}), admissionRequired: true,
    });
    const output = resultOutput(profile, fingerprint, errorMessage(fingerprint, engineUnavailable));
    console.log(json ? JSON.stringify(output) : human(output));
    if (output.error) process.exitCode = 1;
  } catch (cause) {
    const error = cause instanceof FingerprintCliError ? { code: cause.code, message: cause.message }
      : { code: "fingerprint_check_failed", message: "The fingerprint check failed. Run stelz doctor and inspect the service files." };
    const id = args[0] === "check" && args[1] && validId(args[1]) ? args[1] : "";
    const profile = selected ?? (id ? { id } : undefined);
    console.error(json ? JSON.stringify(profile ? errorOutput(profile, error) : { ok: false, error })
      : `${error.code}: ${error.message}`);
    process.exitCode = 1;
  }
}
