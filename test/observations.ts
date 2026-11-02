import { isDeepStrictEqual } from "node:util";
export type Observation = Record<string, unknown>;
export const STABLE_OBSERVATIONS = ["userAgent", "platform", "hardwareConcurrency", "languages", "timezone", "screen", "window", "webdriver", "webgl"];
const VARIABLE_OBSERVATIONS = ["canvas", "audio"];

export function compareObservations(before: Observation, after: Observation) {
  for (const key of [...STABLE_OBSERVATIONS, ...VARIABLE_OBSERVATIONS]) {
    if (!(key in before) || !(key in after)) throw Error(`Incomplete browser observation: ${key}`);
  }
  return {
    stableDifferences: STABLE_OBSERVATIONS.filter(key => !isDeepStrictEqual(before[key], after[key])),
    variableDifferences: VARIABLE_OBSERVATIONS.filter(key => !isDeepStrictEqual(before[key], after[key])),
  };
}
