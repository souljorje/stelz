// Live, explicit lifecycle experiment in a new test home. No model or harness is used.
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fixture } from "../helpers/fixture.ts";
import { STABLE_OBSERVATIONS, VARIABLE_OBSERVATIONS, summarizeStability, type Observation, type StabilitySample } from "../helpers/observations.ts";

const LIFETIMES = 3, DOCUMENTS = 2, SAMPLES = 3;
const policy = "direct:upstream-language-and-location:stelz-fixture-v2";
const root = resolve(import.meta.dir, "../..");
mkdirSync(join(root, ".state"), { recursive: true });
const home = mkdtempSync(join(root, ".state/native-acceptance-"));
const cli = process.env.STELZ_TEST_CLI || join(root, "packages/stelz/dist/cli.js"), ids = ["profile-01", "profile-02"];
const env: Record<string, string> = { STELZ_HOME: home };
for (const key of ["PATH", "HOME", "LANG", "TMPDIR", "CAMOUFOX_EXECUTABLE"]) if (process.env[key]) env[key] = process.env[key]!;
const clients = new Set<Client>(), started = new Set<string>();
type NativeSample = StabilitySample & { context: { lifetimeOrdinal: number; documentOrdinal: number; sampleOrdinal: number; tabId: string; url: string } };
type LifetimeEvidence = {
  ordinal: number; instanceId: string; serviceInstanceId: string; serverPid: number; startedAt: string;
  pinSha256: string; engineSha256: unknown; savedPinUnchanged: boolean; nativeMarkerUnchanged: boolean;
  nativeMarkerPresent: boolean; nativeBrowserDataPresent: boolean; nativeCookiesPresent: boolean;
  stoppedAt?: string; cleanStop?: boolean; reconnected?: boolean;
};
type ProfileEvidence = {
  profile: string; configuration: { storage: "native" }; samples: NativeSample[]; lifetimes: LifetimeEvidence[];
  initialStorageProbe?: Observation; savedPin?: unknown; nativeMarker?: unknown;
  summary?: ReturnType<typeof summarizeStability>; checks?: Record<string, boolean>;
};
const profiles: ProfileEvidence[] = ids.map(profile => ({ profile, configuration: { storage: "native" }, samples: [], lifetimes: [] }));
const report = {
  schema: 2, result: "incomplete", startedAt: new Date().toISOString(), completedAt: "", evidence: home,
  experiment: { lifetimesPerProfile: LIFETIMES, documentsPerLifetime: DOCUMENTS, samplesPerDocument: SAMPLES,
    maximumActiveBrowsers: 2, policy, origin: "http://127.0.0.1:9510",
    expectedStableFields: STABLE_OBSERVATIONS, variableRenderingFields: VARIABLE_OBSERVATIONS,
    sampling: "Each sample uses fresh canvas, WebGL, and offline audio resources. Fresh documents share a tab within each lifetime.",
    comparisons: "All unordered pairs with equal policy labels. Within-document pairs also count as within-session pairs.",
    canvasRecipe: { width: 240, height: 60, font: "16px Arial", fill: "#123456", text: "Camoufox profile continuity", x: 8, y: 30, hash: "SHA-256 of encoded canvas.toDataURL()" },
    audioRecipe: { channels: 1, frames: 2048, sampleRate: 44100, oscillator: "sine", frequency: 440, hash: "SHA-256 of rendered channel 0 bytes" } },
  contract: [
    "Saved device settings and native cookie, localStorage, and IndexedDB markers must persist across explicit stops and starts.",
    "The experiment requires unchanged pin bytes and complete observations from three native lifetimes under one direct network policy.",
    "Device, screen, window, language, timezone, WebGL, and WebGL2 observations must match within this controlled experiment.",
    "Canvas and audio hashes are measurements. Their values may differ within a lifetime or across restarts.",
    "Missing, invalid, and failed probes are incomplete data. They cannot establish stability.",
    "Null WebGL observations mean no exposed debug renderer. Probe errors remain incomplete data.",
    "Language and timezone follow current policy. Direct-to-proxy policy changes are separate from restart comparisons.",
    "Cross-lifetime differences do not prove that a restart caused the difference.",
    "Observed stability applies only to the recorded samples, browser binary, host, display, and policy. It provides no detection or future-output guarantee.",
  ],
  environment: { platform: platform(), arch: arch(), osRelease: release(), bun: Bun.version, runtimeVersions: process.versions,
    hostLanguage: process.env.LANG ?? null, hostTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    sources: {} as Record<string, string>, runtimeManifest: null as unknown },
  profiles, errors: [] as string[],
};
const pins = new Map<string, string>(), markers = new Map<string, string>();
let site: Awaited<ReturnType<typeof fixture>> | undefined;
function assert(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const file = (id: string, name: string) => join(home, "profiles", id, name);
const unchanged = (id: string, name: string, baseline: string | undefined) => baseline !== undefined
  && existsSync(file(id, name)) && readFileSync(file(id, name), "utf8") === baseline;
async function command(...args: string[]) {
  const child = Bun.spawn([Bun.which("bun")!, "--no-env-file", cli, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw Error(`${args.join(" ")}: ${err || out}`);
}
async function connect(id: string) {
  const client = new Client({ name: "native-stability", version: "2.0.0" }); clients.add(client);
  await client.connect(new StdioClientTransport({ command: Bun.which("bun")!, args: ["--no-env-file", cli, "mcp", "--profile", id], env }));
  const status = await call(client, "profile_status");
  assert(status.phase === "ready", `${id}: profile is not ready`);
  await call(client, "profile_acquire");
  await call(client, "camofox_list_tabs");
  return { client, status };
}
async function disconnect(client: Client) {
  try { await call(client, "profile_release"); }
  finally { await client.close(); clients.delete(client); }
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  const text = (result.content as Array<{ type: string; text?: string }>).filter(c => c.type === "text").map(c => c.text).join("\n");
  if (result.isError) throw Error(text);
  return JSON.parse(text) as Record<string, unknown>;
}
async function observation(id: string): Promise<Observation> {
  for (let n = 0; n < 200; n++) {
    const value = site?.observations.get(id); if (value) return value;
    await Bun.sleep(50);
  }
  throw Error(`Browser observation is missing: ${id}`);
}
async function stored(client: Client, tabId: string, id: string) {
  for (let n = 0; n < 30; n++) {
    const value = await call(client, "camofox_snapshot", { tabId });
    if (String(value.snapshot).includes(`Storage marker: ${id}`)) return;
    await Bun.sleep(100);
  }
  throw Error(`Cookie/localStorage/IndexedDB marker did not persist for ${id}`);
}
function storageMatches(value: Observation, id: string | null) {
  const storage = value.storage as { cookie?: unknown; localStorage?: unknown; indexedDB?: unknown } | null;
  if (!storage || typeof storage.cookie !== "string" || storage.localStorage !== id || storage.indexedDB !== id) return false;
  const cookie = storage.cookie.split(";").map(value => value.trim()).find(value => value.startsWith("profile="));
  return id === null ? cookie === undefined : cookie === `profile=${encodeURIComponent(id)}`;
}
function nativeEvidence(profile: ProfileEvidence, ordinal: number, status: Record<string, unknown>) {
  const id = profile.profile;
  const running = JSON.parse(readFileSync(file(id, "running.json"), "utf8")) as { instanceId: string; serverPid: number };
  assert(typeof running.instanceId === "string" && running.instanceId && Number.isInteger(running.serverPid), `${id}: lifetime process evidence is missing`);
  assert(typeof status.instanceId === "string" && status.instanceId, `${id}: service lifetime evidence is missing`);
  assert(!profile.lifetimes.some(value => value.instanceId === running.instanceId || value.serviceInstanceId === status.instanceId), `${id}: explicit start reused a lifetime`);
  const pin = readFileSync(file(id, "fingerprint.json"), "utf8");
  const marker = readFileSync(file(id, "native-profile.json"), "utf8");
  if (!pins.has(id)) {
    pins.set(id, pin); markers.set(id, marker);
    profile.savedPin = JSON.parse(pin); profile.nativeMarker = JSON.parse(marker);
  }
  const evidence: LifetimeEvidence = { ordinal, instanceId: running.instanceId, serviceInstanceId: status.instanceId as string,
    serverPid: running.serverPid, startedAt: new Date().toISOString(), pinSha256: hash(pin), engineSha256: status.engineSha256,
    savedPinUnchanged: pins.get(id) === pin, nativeMarkerUnchanged: markers.get(id) === marker,
    nativeMarkerPresent: existsSync(file(id, "native-profile.json")), nativeBrowserDataPresent: existsSync(file(id, "browser-data")),
    nativeCookiesPresent: existsSync(file(id, "browser-data/cookies.sqlite")) };
  profile.lifetimes.push(evidence);
  assert(evidence.savedPinUnchanged && evidence.nativeMarkerUnchanged, `${id}: saved pin or native marker changed`);
  assert(evidence.nativeMarkerPresent && evidence.nativeBrowserDataPresent, `${id}: native Firefox profile is missing`);
  return evidence;
}
async function capture(profile: ProfileEvidence, client: Client, lifetime: LifetimeEvidence) {
  const id = profile.profile;
  let tabId: string | undefined;
  if (lifetime.ordinal === 1) {
    const capture = `storage-${id}`;
    const tab = await call(client, "camofox_create_tab", { url: `http://127.0.0.1:9510/?capture=${capture}` });
    tabId = String(tab.tabId);
    profile.initialStorageProbe = await observation(capture);
    assert(storageMatches(profile.initialStorageProbe, null), `${id}: a new native profile contains another profile's storage`);
    await call(client, "camofox_snapshot", { tabId });
    await call(client, "camofox_type", { tabId, selector: "#marker", text: id });
    await call(client, "camofox_snapshot", { tabId });
    await call(client, "camofox_click", { tabId, selector: "#save" });
    await stored(client, tabId, id);
  }
  for (let document = 1; document <= DOCUMENTS; document++) {
    const key = `${id}-lifetime-${lifetime.ordinal}-document-${document}`;
    const url = `http://127.0.0.1:9510/?capture=${key}&samples=${SAMPLES}`;
    if (tabId) {
      await call(client, "camofox_snapshot", { tabId });
      await call(client, "camofox_navigate", { tabId, url });
    } else tabId = String((await call(client, "camofox_create_tab", { url })).tabId);
    let documentId: unknown;
    for (let index = 1; index <= SAMPLES; index++) {
      const sampleId = `${key}-${index}`, value = await observation(sampleId);
      profile.samples.push({ id: sampleId, lifetime: lifetime.instanceId, document: key, policy, observation: value,
        context: { lifetimeOrdinal: lifetime.ordinal, documentOrdinal: document, sampleOrdinal: index, tabId, url } });
      const metadata = value.measurement as Record<string, unknown> | undefined;
      assert(metadata?.recipe === "stelz-fixture-v2" && metadata.captureId === sampleId && metadata.sampleIndex === index
        && metadata.sampleCount === SAMPLES && typeof metadata.documentId === "string" && metadata.documentURL === url, `${sampleId}: capture context is missing or stale`);
      if (index === 1) {
        documentId = metadata.documentId;
        assert(!profile.samples.slice(0, -1).some(sample => (sample.observation.measurement as Record<string, unknown>)?.documentId === documentId), `${sampleId}: document was reused`);
      }
      assert(metadata.documentId === documentId, `${sampleId}: repeated samples changed document`);
      assert(storageMatches(value, id), `${sampleId}: native storage is missing or belongs to another profile`);
    }
    await stored(client, tabId, id);
    assert(readFileSync(file(id, "fingerprint.json"), "utf8") === pins.get(id), `${id}: sampling changed saved device settings`);
  }
  lifetime.nativeCookiesPresent = existsSync(file(id, "browser-data/cookies.sqlite"));
  assert(lifetime.nativeCookiesPresent, `${id}: native cookie database is missing`);
  assert(tabId, `${id}: native browser tab is missing`);
  return tabId;
}
function summarize() {
  for (const profile of profiles) {
    profile.summary = summarizeStability(profile.samples);
    const fields = Object.values(profile.summary.fields);
    profile.checks = {
      completeSeries: profile.lifetimes.length === LIFETIMES && profile.summary.lifetimeCount === LIFETIMES
        && profile.summary.documentCount === LIFETIMES * DOCUMENTS && profile.samples.length === LIFETIMES * DOCUMENTS * SAMPLES,
      completeObservations: fields.every(field => field.validSamples === LIFETIMES * DOCUMENTS * SAMPLES && !field.incompleteSamples.length),
      nativeStorageIsolatedAndPersisted: !!profile.initialStorageProbe && storageMatches(profile.initialStorageProbe, null)
        && profile.samples.length > 0 && profile.samples.every(sample => storageMatches(sample.observation, profile.profile)),
      savedPinAndNativeMarkerUnchanged: profile.lifetimes.length > 0 && profile.lifetimes.every(value => value.savedPinUnchanged && value.nativeMarkerUnchanged)
        && unchanged(profile.profile, "fingerprint.json", pins.get(profile.profile))
        && unchanged(profile.profile, "native-profile.json", markers.get(profile.profile)),
      explicitCleanStops: profile.lifetimes.length === LIFETIMES && profile.lifetimes.every(value => value.cleanStop),
      disconnectReconnectPreservedBrowser: profile.lifetimes.length === LIFETIMES && profile.lifetimes.every(value => value.reconnected),
      expectedObservablesMatch: STABLE_OBSERVATIONS.every(key => {
        const field = profile.summary!.fields[key]!;
        return field.withinSession.status === "observed-stable" && field.acrossRestarts.status === "observed-stable";
      }),
    };
  }
}
try {
  console.log(`Explicit direct-development native stability experiment. Evidence: ${home}`);
  report.environment.sources["tested-cli.js"] = hash(readFileSync(cli));
  for (const name of ["tests/browser/native-integration.ts", "tests/helpers/observations.ts", "tests/helpers/fixture-browser.ts", "tests/helpers/fixture.ts"]) {
    report.environment.sources[name] = hash(readFileSync(join(root, name)));
  }
  await command("init");
  writeFileSync(join(home, "profiles.json"), JSON.stringify({ profiles: ids.map((id, i) => ({ id, port: 9571 + i, storage: "native" })) }));
  await command("setup"); site = await fixture(9510);
  report.environment.runtimeManifest = JSON.parse(readFileSync(join(home, "runtime/versions.json"), "utf8"));
  for (let ordinal = 1; ordinal <= LIFETIMES; ordinal++) {
    for (const id of ids) { started.add(id); await command("start", id); }
    for (const profile of profiles) {
      const { client, status } = await connect(profile.profile);
      const lifetime = nativeEvidence(profile, ordinal, status);
      const tabId = await capture(profile, client, lifetime);
      const runningBefore = readFileSync(file(profile.profile, "running.json"), "utf8");
      await disconnect(client);
      const resumed = await connect(profile.profile);
      assert(resumed.status.instanceId === lifetime.serviceInstanceId, `${profile.profile}: reconnect replaced the service`);
      await stored(resumed.client, tabId, profile.profile);
      assert(readFileSync(file(profile.profile, "running.json"), "utf8") === runningBefore, `${profile.profile}: reconnect replaced the browser`);
      assert(unchanged(profile.profile, "fingerprint.json", pins.get(profile.profile))
        && unchanged(profile.profile, "native-profile.json", markers.get(profile.profile)), `${profile.profile}: reconnect changed native profile settings`);
      lifetime.reconnected = true;
      await disconnect(resumed.client);
    }
    for (const profile of profiles) {
      await command("stop", profile.profile); started.delete(profile.profile);
      const lifetime = profile.lifetimes.at(-1)!;
      const stopped = JSON.parse(readFileSync(file(profile.profile, "stopped.json"), "utf8")) as { instanceId: string };
      lifetime.stoppedAt = new Date().toISOString(); lifetime.cleanStop = stopped.instanceId === lifetime.instanceId;
      assert(lifetime.cleanStop, `${profile.profile}: explicit clean stop is unconfirmed`);
    }
    console.log(`Measured native lifetime ${ordinal}/${LIFETIMES} for both profiles.`);
  }
} catch (error) { report.errors.push(String(error)); }
finally {
  for (const client of clients) await disconnect(client).catch(error => report.errors.push(`Disconnect: ${String(error)}`));
  for (const id of started) await command("stop", id).catch(error => report.errors.push(`Cleanup ${id}: ${String(error)}`));
  site?.stop();
  try { summarize(); } catch (error) { report.errors.push(`Summary: ${String(error)}`); }
  report.result = !report.errors.length && profiles.every(profile => profile.checks && Object.values(profile.checks).every(Boolean)) ? "passed" : "failed";
  if (report.result !== "passed") process.exitCode = 1;
  report.completedAt = new Date().toISOString();
  writeFileSync(join(home, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(`${report.result}: ${join(home, "report.json")}`);
  for (const profile of profiles) console.log(JSON.stringify({ profile: profile.profile, checks: profile.checks,
    fields: profile.summary && Object.fromEntries(Object.entries(profile.summary.fields).map(([key, field]) => [key, {
      uniqueValueCount: field.uniqueValueCount, withinSessionDifferences: field.withinSession.differenceCount,
      restartDifferences: field.acrossRestarts.differenceCount, incompleteSamples: field.incompleteSamples.length,
    }])) }));
  for (const error of report.errors) console.error(error);
}
