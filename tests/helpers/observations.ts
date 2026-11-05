import { isDeepStrictEqual } from "node:util";
export type Observation = Record<string, unknown>;
export const STABLE_OBSERVATIONS = ["userAgent", "platform", "hardwareConcurrency", "languages", "timezone", "screen", "window", "webdriver", "webgl", "webgl2"];
export const VARIABLE_OBSERVATIONS = ["canvas", "audio"];
export const POLICY_OBSERVATIONS = ["languages", "timezone"];
const FIELDS = [...STABLE_OBSERVATIONS, ...VARIABLE_OBSERVATIONS];

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown) => typeof value === "string" && value.trim().length > 0 && value !== "unavailable";
const positive = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0;

/** Null WebGL means no exposed debug renderer. Probe errors are separate from that observation. */
export function observationProblem(value: Observation, key: string): string | undefined {
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

export type StabilitySample = {
  id: string;
  lifetime: string;
  document: string;
  // A policy label includes network mode, language/location policy, and probe recipe.
  policy: string;
  observation: Observation;
};
type Pair = { before: string; after: string };
type StabilityStatus = "insufficient-data" | "incomplete" | "drift" | "observed-stable";
type ComparisonCounts = {
  attemptedPairs: number;
  comparedPairs: number;
  incompletePairs: number;
  differenceCount: number;
  differences: Pair[];
  status: StabilityStatus;
};
type ValueGroup = { value: unknown; sampleIds: string[] };

function uniqueValues(samples: readonly StabilitySample[], key: string): ValueGroup[] {
  const groups: ValueGroup[] = [];
  for (const sample of samples) {
    if (observationProblem(sample.observation, key)) continue;
    const existing = groups.find(group => isDeepStrictEqual(group.value, sample.observation[key]));
    if (existing) existing.sampleIds.push(sample.id);
    else groups.push({ value: sample.observation[key], sampleIds: [sample.id] });
  }
  return groups;
}

/** Compare all unordered pairs with equal policy. Cross-lifetime changes do not establish their cause. */
export function summarizeStability(samples: readonly StabilitySample[]) {
  const ids = new Set<string>();
  const lifetimes = new Map<string, { policy: string; documents: Map<string, StabilitySample[]>; samples: StabilitySample[] }>();
  for (const sample of samples) {
    if (![sample.id, sample.lifetime, sample.document, sample.policy].every(text) || ids.has(sample.id)) {
      throw Error("Stability samples require unique IDs and nonempty context labels");
    }
    ids.add(sample.id);
    let lifetime = lifetimes.get(sample.lifetime);
    if (!lifetime) {
      lifetime = { policy: sample.policy, documents: new Map(), samples: [] };
      lifetimes.set(sample.lifetime, lifetime);
    }
    if (lifetime.policy !== sample.policy) throw Error("A lifetime cannot contain different policy labels");
    lifetime.samples.push(sample);
    const document = lifetime.documents.get(sample.document) || [];
    document.push(sample); lifetime.documents.set(sample.document, document);
  }
  const policyChanges: Array<Pair & { fields: string[]; incompleteFields: string[] }> = [];
  const fields: Record<string, {
    category: "device" | "policy" | "rendering";
    validSamples: number;
    incompleteSamples: Array<{ id: string; problem: string }>;
    uniqueValueCount: number;
    values: ValueGroup[];
    perLifetime: Array<{ lifetime: string; policy: string; sampleCount: number; validSamples: number; uniqueValueCount: number }>;
    withinDocument: ComparisonCounts;
    withinSession: ComparisonCounts;
    acrossRestarts: ComparisonCounts;
  }> = {};
  const counts = (): ComparisonCounts => ({ attemptedPairs: 0, comparedPairs: 0, incompletePairs: 0, differenceCount: 0, differences: [], status: "insufficient-data" });
  for (const key of FIELDS) {
    const values = uniqueValues(samples, key);
    fields[key] = {
      category: VARIABLE_OBSERVATIONS.includes(key) ? "rendering" : POLICY_OBSERVATIONS.includes(key) ? "policy" : "device",
      validSamples: values.reduce((n, group) => n + group.sampleIds.length, 0),
      incompleteSamples: samples.flatMap(sample => {
        const problem = observationProblem(sample.observation, key);
        return problem ? [{ id: sample.id, problem }] : [];
      }),
      uniqueValueCount: values.length, values,
      perLifetime: Array.from(lifetimes, ([lifetime, group]) => ({ lifetime, policy: group.policy, sampleCount: group.samples.length,
        validSamples: group.samples.filter(sample => !observationProblem(sample.observation, key)).length,
        uniqueValueCount: uniqueValues(group.samples, key).length })),
      withinDocument: counts(), withinSession: counts(), acrossRestarts: counts(),
    };
  }
  for (let i = 0; i < samples.length; i++) for (let j = i + 1; j < samples.length; j++) {
    const before = samples[i]!, after = samples[j]!;
    const pair = { before: before.id, after: after.id };
    if (before.policy !== after.policy) {
      policyChanges.push({ ...pair,
        fields: FIELDS.filter(key => !observationProblem(before.observation, key) && !observationProblem(after.observation, key)
          && !isDeepStrictEqual(before.observation[key], after.observation[key])),
        incompleteFields: FIELDS.filter(key => observationProblem(before.observation, key) || observationProblem(after.observation, key)),
      });
      continue;
    }
    for (const key of FIELDS) {
      const field = fields[key]!;
      const targets = before.lifetime !== after.lifetime ? [field.acrossRestarts]
        : before.document === after.document ? [field.withinSession, field.withinDocument] : [field.withinSession];
      for (const target of targets) {
        target.attemptedPairs++;
        if (observationProblem(before.observation, key) || observationProblem(after.observation, key)) target.incompletePairs++;
        else {
          target.comparedPairs++;
          if (!isDeepStrictEqual(before.observation[key], after.observation[key])) {
            target.differenceCount++; target.differences.push(pair);
          }
        }
      }
    }
  }
  for (const field of Object.values(fields)) for (const target of [field.withinDocument, field.withinSession, field.acrossRestarts]) {
    target.status = field.incompleteSamples.length ? "incomplete" : target.comparedPairs === 0 ? "insufficient-data"
      : target.differenceCount ? "drift" : "observed-stable";
  }
  return {
    sampleCount: samples.length, lifetimeCount: lifetimes.size,
    documentCount: Array.from(lifetimes.values()).reduce((n, group) => n + group.documents.size, 0),
    comparisonMethod: "all unordered sample pairs with equal policy labels",
    fields, policyChanges,
  };
}
