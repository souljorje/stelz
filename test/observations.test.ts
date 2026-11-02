import { test } from "node:test";
import assert from "node:assert/strict";
import { compareObservations } from "./observations.ts";
const sample = { userAgent: "UA", platform: "MacIntel", hardwareConcurrency: 8, languages: ["en-US"],
  timezone: "America/New_York", screen: { width: 1440 }, window: { outerWidth: 1200 }, webdriver: false,
  webgl: { vendor: "GPU" }, canvas: "canvas-a", audio: "audio-a" };
test("observable device drift fails even when the saved fingerprint file is unchanged", () => {
  assert.deepEqual(compareObservations(sample, { ...sample, hardwareConcurrency: 4 }).stableDifferences, ["hardwareConcurrency"]);
});
test("known variable rendering signals are recorded separately", () => {
  assert.deepEqual(compareObservations(sample, { ...sample, canvas: "canvas-b", audio: "audio-b" }),
    { stableDifferences: [], variableDifferences: ["canvas", "audio"] });
});
test("missing samples cannot pass as two identical undefined values", () => {
  assert.throws(() => compareObservations({}, {}), /Incomplete browser observation/);
});
