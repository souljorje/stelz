import { isDeepStrictEqual } from "node:util";
export type Observation = Record<string, unknown>;
const STABLE_OBSERVATIONS = ["userAgent", "platform", "hardwareConcurrency", "languages", "timezone", "screen", "window", "webdriver", "webgl", "webgl2"];
const VARIABLE_OBSERVATIONS = ["canvas", "audio"];
const FIELDS = [...STABLE_OBSERVATIONS, ...VARIABLE_OBSERVATIONS];

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown) => typeof value === "string" && value.trim().length > 0 && value !== "unavailable";
const positive = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0;

/** Null WebGL means no exposed debug renderer. Probe errors are separate from that observation. */
function observationProblem(value: Observation, key: string): string | undefined {
  if (!Object.hasOwn(value, key) || value[key] === undefined) return "missing";
  if (record(value.errors) && Object.hasOwn(value.errors, key)) return `probe failed: ${String(value.errors[key])}`;
  const field = value[key];
  let valid: boolean;
  switch (key) {
    case "hardwareConcurrency": valid = positive(field) && Number.isInteger(field); break;
    case "webdriver": valid = typeof field === "boolean"; break;
    case "languages": valid = Array.isArray(field) && field.length > 0 && Array.from(field).every(text); break;
    case "screen": case "window": {
      const keys = key === "screen" ? ["width", "height", "availWidth", "availHeight", "colorDepth"]
        : ["innerWidth", "innerHeight", "outerWidth", "outerHeight", "devicePixelRatio"];
      valid = record(field) && keys.every(name => Object.hasOwn(field, name) && positive(field[name]));
      break;
    }
    case "webgl": case "webgl2": valid = field === null || record(field) && text(field.vendor) && text(field.renderer); break;
    default: valid = text(field);
  }
  return valid ? undefined : "invalid or unavailable";
}

export function compareObservations(before: Observation, after: Observation) {
  for (const key of FIELDS) {
    const problem = observationProblem(before, key) || observationProblem(after, key);
    if (problem) throw Error(`Incomplete browser observation: ${key} (${problem})`);
  }
  return {
    stableDifferences: STABLE_OBSERVATIONS.filter(key => !isDeepStrictEqual(before[key], after[key])),
    variableDifferences: VARIABLE_OBSERVATIONS.filter(key => !isDeepStrictEqual(before[key], after[key])),
  };
}
