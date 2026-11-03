import { test } from "node:test";
import assert from "node:assert/strict";
import { compareObservations, summarizeStability, type Observation, type StabilitySample } from "./observations.ts";
const sample = { userAgent: "UA", platform: "MacIntel", hardwareConcurrency: 8, languages: ["en-US"],
  timezone: "America/New_York", screen: { width: 1440, height: 900, availWidth: 1440, availHeight: 850, colorDepth: 24 },
  window: { innerWidth: 1200, innerHeight: 740, outerWidth: 1200, outerHeight: 800, devicePixelRatio: 2 }, webdriver: false,
  webgl: { vendor: "GPU", renderer: "Renderer" }, webgl2: { vendor: "GPU", renderer: "Renderer" }, canvas: "canvas-a", audio: "audio-a" };
function capture(id: string, lifetime: string, overrides: Observation = {}, document = `${lifetime}-document`, policy = "direct"): StabilitySample {
  return { id, lifetime, document, policy, observation: { ...sample, ...overrides } };
}
test("observable device drift fails even when the saved fingerprint file is unchanged", () => {
  assert.deepEqual(compareObservations(sample, { ...sample, hardwareConcurrency: 4 }).stableDifferences, ["hardwareConcurrency"]);
});
test("known variable rendering signals are recorded separately", () => {
  assert.deepEqual(compareObservations(sample, { ...sample, canvas: "canvas-b", audio: "audio-b" }),
    { stableDifferences: [], variableDifferences: ["canvas", "audio"] });
});
test("WebGL2 support drift fails the observable profile check", () => {
  assert.deepEqual(compareObservations(sample, { ...sample, webgl2: null }).stableDifferences, ["webgl2"]);
});
test("missing samples cannot pass as two identical undefined values", () => {
  assert.throws(() => compareObservations({}, {}), /Incomplete browser observation/);
});
test("the proxy comparison retains its exact public result shape", () => {
  assert.deepEqual(compareObservations(sample, { ...sample, timezone: "UTC", canvas: "canvas-b" }),
    { stableDifferences: ["timezone"], variableDifferences: ["canvas"] });
});
test("matching missing, failed, or partial probes cannot establish stability", () => {
  const invalid: Observation[] = [
    { canvas: undefined }, { canvas: null }, { canvas: "" }, { audio: "unavailable" },
    { audio: "audio-a", errors: { audio: "rendering failed" } }, { webgl: null, errors: { webgl: "probe failed" } },
    { hardwareConcurrency: NaN }, { hardwareConcurrency: 0 }, { languages: [] }, { languages: Array(1) }, { timezone: null },
    { screen: { width: 1440 } }, { window: { ...sample.window, innerHeight: undefined } }, { webgl: {} },
  ];
  for (const overrides of invalid) {
    const observation = { ...sample, ...overrides };
    assert.throws(() => compareObservations(observation, observation), /Incomplete browser observation/);
    const summary = summarizeStability([capture("a", "one", overrides), capture("b", "two", overrides)]);
    const field = summary.fields[Object.keys(overrides)[0]!]!;
    assert.equal(field.validSamples, 0);
    assert.equal(field.uniqueValueCount, 0);
    assert.equal(field.acrossRestarts.status, "incomplete");
    assert.equal(field.acrossRestarts.comparedPairs, 0);
    assert.equal(field.acrossRestarts.incompletePairs, 1);
  }
});
test("inherited values cannot fill a missing probe", () => {
  const inherited = Object.assign(Object.create({ canvas: "canvas-a" }), sample) as Observation;
  delete inherited.canvas;
  assert.throws(() => compareObservations(inherited, inherited), /canvas/);
});
test("false webdriver and explicitly unexposed WebGL renderers are valid observations", () => {
  const value = { ...sample, webgl: null, webgl2: null };
  assert.deepEqual(compareObservations(value, value), { stableDifferences: [], variableDifferences: [] });
  const summary = summarizeStability([capture("a", "one", value), capture("b", "two", value)]);
  assert.equal(summary.fields.webgl!.uniqueValueCount, 1);
  assert.equal(summary.fields.webgl!.acrossRestarts.status, "observed-stable");
});
test("three lifetimes distinguish same-document noise from lifetime-specific output", () => {
  const series = ["one", "two", "three"].flatMap(lifetime => [
    capture(`${lifetime}-a`, lifetime, { canvas: "a", audio: lifetime }),
    capture(`${lifetime}-b`, lifetime, { canvas: "b", audio: lifetime }),
  ]);
  const summary = summarizeStability(series);
  assert.equal(summary.sampleCount, 6);
  assert.equal(summary.lifetimeCount, 3);
  assert.equal(summary.documentCount, 3);
  const canvas = summary.fields.canvas!, audio = summary.fields.audio!;
  assert.equal(canvas.category, "rendering");
  assert.equal(canvas.uniqueValueCount, 2);
  assert.deepEqual(canvas.perLifetime.map(value => value.uniqueValueCount), [2, 2, 2]);
  assert.equal(canvas.withinDocument.comparedPairs, 3);
  assert.equal(canvas.withinSession.differenceCount, 3);
  assert.equal(canvas.acrossRestarts.comparedPairs, 12);
  assert.equal(canvas.acrossRestarts.differenceCount, 6);
  assert.equal(audio.uniqueValueCount, 3);
  assert.equal(audio.withinSession.status, "observed-stable");
  assert.equal(audio.acrossRestarts.status, "drift");
  assert.equal(audio.acrossRestarts.differenceCount, 12);
  assert.equal(summary.fields.hardwareConcurrency!.category, "device");
  assert.equal(summary.fields.hardwareConcurrency!.acrossRestarts.status, "observed-stable");
  assert.deepEqual(canvas.withinSession.differences[0], { before: "one-a", after: "one-b" });
});
test("fresh-document drift counts within the lifetime without claiming same-document drift", () => {
  const summary = summarizeStability([
    capture("a", "one", { canvas: "a" }, "document-a"), capture("b", "one", { canvas: "b" }, "document-b"),
    capture("c", "two", { canvas: "a" }, "document-a"),
  ]);
  assert.equal(summary.documentCount, 3);
  assert.equal(summary.fields.canvas!.withinDocument.status, "insufficient-data");
  assert.equal(summary.fields.canvas!.withinSession.differenceCount, 1);
  assert.equal(summary.fields.canvas!.acrossRestarts.differenceCount, 1);
});
test("the native experiment has 18 same-document, 45 same-lifetime, and 108 cross-lifetime pairs", () => {
  const series: StabilitySample[] = [];
  for (let lifetime = 1; lifetime <= 3; lifetime++) for (let document = 1; document <= 2; document++) for (let index = 1; index <= 3; index++) {
    const id = `${lifetime}-${document}-${index}`;
    series.push(capture(id, String(lifetime), { canvas: id }, String(document)));
  }
  const summary = summarizeStability(series), field = summary.fields.canvas!;
  assert.equal(summary.documentCount, 6);
  assert.equal(field.withinDocument.differenceCount, 18);
  assert.equal(field.withinSession.differenceCount, 45);
  assert.equal(field.acrossRestarts.differenceCount, 108);
  assert.deepEqual(field.perLifetime.map(value => value.uniqueValueCount), [6, 6, 6]);
});
test("location policy changes are separate from restart drift for every field", () => {
  const proxied = { languages: ["en-GB"], timezone: "Europe/London", hardwareConcurrency: 4 };
  const summary = summarizeStability([
    capture("a", "one"), capture("b", "two"),
    capture("c", "three", proxied, "doc", "proxy"), capture("d", "four", proxied, "doc", "proxy"),
  ]);
  assert.equal(summary.policyChanges.length, 4);
  assert.deepEqual(summary.policyChanges[0], { before: "a", after: "c", fields: ["hardwareConcurrency", "languages", "timezone"], incompleteFields: [] });
  for (const key of ["hardwareConcurrency", "languages", "timezone"]) {
    assert.equal(summary.fields[key]!.acrossRestarts.comparedPairs, 2);
    assert.equal(summary.fields[key]!.acrossRestarts.status, "observed-stable");
  }
  assert.equal(summary.fields.timezone!.category, "policy");
  assert.equal(summary.fields.hardwareConcurrency!.uniqueValueCount, 2);
});
test("language drift under an unchanged policy remains restart drift", () => {
  const summary = summarizeStability([capture("a", "one"), capture("b", "two", { languages: ["de-DE"] })]);
  assert.equal(summary.policyChanges.length, 0);
  assert.equal(summary.fields.languages!.acrossRestarts.status, "drift");
});
test("empty and single-lifetime series never claim restart stability", () => {
  for (const series of [[], [capture("a", "one")], [capture("a", "one"), capture("b", "one")]]) {
    const summary = summarizeStability(series);
    assert.equal(summary.fields.canvas!.acrossRestarts.status, "insufficient-data");
    assert.equal(summary.fields.canvas!.acrossRestarts.comparedPairs, 0);
  }
});
test("a missing sample does not disappear from a partly valid series", () => {
  const summary = summarizeStability([capture("a", "one"), capture("b", "one", { audio: undefined }), capture("c", "two")]);
  const field = summary.fields.audio!;
  assert.equal(field.validSamples, 2);
  assert.equal(field.uniqueValueCount, 1);
  assert.deepEqual(field.incompleteSamples, [{ id: "b", problem: "missing" }]);
  assert.equal(field.acrossRestarts.comparedPairs, 1);
  assert.equal(field.acrossRestarts.incompletePairs, 1);
  assert.equal(field.acrossRestarts.status, "incomplete");
});
test("deep value equality ignores property order and preserves raw input", () => {
  const series = [capture("a", "one"), capture("b", "two", { webgl: { renderer: "Renderer", vendor: "GPU" } })];
  const before = structuredClone(series);
  const summary = summarizeStability(series);
  assert.equal(summary.fields.webgl!.uniqueValueCount, 1);
  assert.deepEqual(summary.fields.webgl!.values[0]!.sampleIds, ["a", "b"]);
  assert.deepEqual(series, before);
});
test("duplicate captures and ambiguous lifetime labels are rejected", () => {
  assert.throws(() => summarizeStability([capture("a", "one"), capture("a", "two")]), /unique IDs/);
  assert.throws(() => summarizeStability([capture("a", "")]), /context labels/);
  assert.throws(() => summarizeStability([capture("a", "one"), capture("b", "one", {}, "doc", "proxy")]), /different policy/);
});
