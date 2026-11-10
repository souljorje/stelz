// Opt-in live checks through the same MCP connection used by browser clients.
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { dedicatedProxyInputs } from "../helpers/dedicated-proxy.ts";
import { lockPublicProfile, PUBLIC_PROFILE } from "../helpers/public-profile.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { STELZ_VERSION } from "../../src/versions.ts";
import { assessSite, detectHumanChallenge, type Assessment, type SiteId, type Verdict } from "../helpers/public-site-verdicts.ts";
import { assertTestHome } from "../helpers/test-home.ts";
import { proxyRedactor } from "../helpers/proxy-acceptance-helpers.ts";
import { routeProfileTools } from "../helpers/mcp-client.ts";
const ROOT = resolve(import.meta.dir, "../..");
const cli = process.env.STELZ_TEST_CLI || join(ROOT, "src/cli/cli.ts");

export const PUBLIC_SITES: ReadonlyArray<{ id: SiteId; name: string; url: string; screenshotHeading?: string; screenshotControl?: string }> = [
  // Phase 6 order: Playground first, then web scraping, Pixelscan, and Rebrowser.
  { id: "fingerprint-playground", name: "Fingerprint Playground", url: "https://demo.fingerprint.com/playground" },
  { id: "fingerprint-web-scraping", name: "Fingerprint web scraping", url: "https://demo.fingerprint.com/web-scraping",
    screenshotHeading: "Search for today's flights", screenshotControl: "Search" },
  { id: "pixelscan", name: "Pixelscan", url: "https://pixelscan.net/fingerprint-check" },
  { id: "rebrowser", name: "Rebrowser", url: "https://bot-detector.rebrowser.net/" },
];

export type ToolReply = { isError?: boolean; content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> };
export type PublicConnection = {
  call(name: string, args: Record<string, unknown>): Promise<ToolReply>;
  close(): Promise<void>;
};
export type SiteResult = {
  id: SiteId; name: string; url: string; status: Verdict; reason: string;
  details: Record<string, string>; errors: string[]; observedVerdict?: Verdict;
  tabId?: string; finalUrl?: string; startedAt?: string; finishedAt?: string;
  snapshot?: string; screenshot?: string;
  warnings?: string[]; screenshotHeading?: string; screenshotControl?: string; screenshotFramed?: boolean;
};
export type PublicReport = {
  browser: "Camoufox"; profile: string; serviceHome: string; outputDir: string;
  startedAt: string; finishedAt?: string; interrupted?: string;
  initialInstanceId?: string; finalInstanceId?: string;
  initialTabIds: string[]; finalTabIds?: string[]; released: boolean; stopped: boolean;
  results: SiteResult[]; errors: string[];
};
type RunOptions = {
  profile: string; home: string; outputDir?: string; signal?: AbortSignal;
  connect?: () => Promise<PublicConnection>;
  stop?: (profile: string, home: string) => Promise<void>;
  confirmHuman?: (site: SiteResult, prompt: string, signal?: AbortSignal) => Promise<boolean>;
  now?: () => number; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  timeoutMs?: number; pollMs?: number; log?: (message: string) => void;
};
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function textResult(reply: ToolReply): Record<string, unknown> {
  const text = reply.content.filter(block => block.type === "text").map(block => block.text ?? "").join("\n");
  if (reply.isError) throw Error(text || "MCP tool failed without an error message.");
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("MCP tool returned an invalid JSON object.");
  return value as Record<string, unknown>;
}

function screenshotBytes(reply: ToolReply): Buffer {
  if (reply.isError) throw Error(reply.content.map(block => block.text ?? "").join("\n") || "Screenshot failed.");
  const image = reply.content.find(block => block.type === "image" && block.mimeType === "image/png");
  if (!image?.data) throw Error("MCP response contains no PNG screenshot.");
  const bytes = Buffer.from(image.data, "base64");
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || bytes.toString("ascii", 12, 16) !== "IHDR" || !bytes.readUInt32BE(16) || !bytes.readUInt32BE(20)) {
    throw Error("MCP screenshot contains invalid PNG bytes.");
  }
  return bytes;
}

function tabIds(value: Record<string, unknown>): string[] {
  if (!Array.isArray(value.tabs)) throw Error("MCP tab listing contains no tabs array.");
  return value.tabs.map((tab: { tabId?: unknown; id?: unknown }) => {
    const id = tab.tabId ?? tab.id;
    if (typeof id !== "string" || !uuid.test(id)) throw Error("MCP tab listing contains an invalid tab ID.");
    return id;
  });
}

function samePage(requested: string, actual: string): boolean {
  try {
    const a = new URL(requested), b = new URL(actual);
    return a.origin === b.origin && a.pathname.replace(/\/$/, "") === b.pathname.replace(/\/$/, "")
      && !b.searchParams.has("disableBotDetection");
  } catch { return false; }
}

function observedButton(snapshot: string, name: string): string | undefined {
  for (const line of snapshot.split("\n")) {
    const match = /^\s*- button\s+("(?:\\.|[^"\\])*")\s+(.*)$/.exec(line);
    if (!match || /\[disabled(?:=true)?\]/.test(match[2]!)) continue;
    if (JSON.parse(match[1]!) === name) return /\[(e\d+)\]/.exec(match[2]!)?.[1];
  }
}

function writePrivate(file: string, value: string | Buffer) {
  writeFileSync(file + ".tmp", value, { mode: 0o600 });
  renameSync(file + ".tmp", file);
}
const md = (value: string) => value.replace(/[\\`*_[\]<>|]/g, character => "\\" + character).replace(/\r?\n/g, " ");
function persist(report: PublicReport) {
  writePrivate(join(report.outputDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  const lines = ["# Camoufox public-site checks", "", "Profile: " + md(report.profile), "", "Started: " + report.startedAt,
    "", "Browser stopped: " + (report.stopped ? "yes" : "no"),
    "", "| Site | Result | Reason |", "| --- | --- | --- |",
    ...report.results.map(site => "| " + md(site.name) + " | " + site.status + " | " + md(site.reason) + " |")];
  if (report.errors.length) lines.push("", "Run errors:", ...report.errors.map(error => "- " + md(error)));
  for (const site of report.results) {
    lines.push("", "## " + md(site.name), "", "[Requested page](" + site.url + ")", "", md(site.reason));
    if (site.finalUrl) lines.push("", "Final URL: " + md(site.finalUrl));
    for (const [key, value] of Object.entries(site.details)) lines.push("", "- " + md(key) + ": " + md(value));
    for (const warning of site.warnings ?? []) lines.push("", "- Warning: " + md(warning));
    if (site.errors.length) lines.push("", ...site.errors.map(error => "- Error: " + md(error)));
    if (site.snapshot) lines.push("", "[Snapshot](./" + site.id + ".snapshot.json)");
    if (site.screenshot) lines.push("", "![" + site.name + "](./" + site.id + ".png)");
  }
  writePrivate(join(report.outputDir, "report.md"), lines.join("\n") + "\n");
}

export function publicRunPassed(report: PublicReport): boolean {
  return !!report.finishedAt && report.released && report.stopped && !report.errors.length && !report.interrupted
    && report.results.length === PUBLIC_SITES.length && report.results.every(site =>
      site.status === "PASS" && !!site.screenshot && !!site.snapshot && !site.errors.length
      && (!site.screenshotControl || site.screenshotFramed === true));
}

function serviceEnvironment(home: string): Record<string, string> {
  const env: Record<string, string> = { STELZ_HOME: assertTestHome(home) };
  for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "CAMOUFOX_EXECUTABLE"]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return env;
}

async function stopProfile(profile: string, home: string): Promise<void> {
  const child = Bun.spawn([process.execPath, "--no-env-file", cli, "stop", profile], {
    cwd: ROOT, env: serviceEnvironment(home), stdout: "pipe", stderr: "pipe",
  });
  const [out, error, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (code) throw Error(error.trim() || out.trim() || "The lifecycle stop command failed.");
  const status = JSON.parse(out) as Record<string, unknown>;
  if (status.profileId !== profile || status.phase !== "stopped") throw Error("The lifecycle command did not confirm a stopped profile.");
}

async function connectMcp(profile: string, home: string): Promise<PublicConnection> {
  const client = routeProfileTools(new Client({ name: "stelz-public-sites", version: STELZ_VERSION }), profile);
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: ["--no-env-file", cli, "mcp"], env: serviceEnvironment(home), stderr: "inherit" }));
  } catch (error) { await client.close().catch(() => {}); throw error; }
  return {
    call: async (name, args) => await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 }) as ToolReply,
    close: () => client.close(),
  };
}

async function sleep(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) throw Error(message(signal.reason));
  await new Promise<void>((resolveWait, reject) => {
    const abort = () => { clearTimeout(timer); reject(Error(message(signal?.reason))); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolveWait(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function confirmHuman(site: SiteResult, prompt: string, signal?: AbortSignal): Promise<boolean> {
  console.log("WAITING_FOR_HUMAN: " + site.name + ". " + prompt + " Complete this action in the same Camoufox window.");
  if (!process.stdin.isTTY || !process.stdout.isTTY || signal?.aborted) return false;
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await input.question("Type done to resume, or press Enter to end the run: ", { signal })).trim().toLowerCase() === "done"; }
  catch { return false; }
  finally { input.close(); }
}

export async function runPublicSites(options: RunOptions): Promise<PublicReport> {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(options.profile)) throw Error("Select a valid disposable test profile ID.");
  const now = options.now ?? Date.now, stamp = () => new Date(now()).toISOString();
  const timeout = options.timeoutMs ?? 120_000, poll = options.pollMs ?? 2_000;
  const wait = options.sleep ?? sleep, signal = options.signal, log = options.log ?? console.log;
  const home = assertTestHome(options.home);
  const parent = join(ROOT, ".state/public-sites");
  if (!options.outputDir) mkdirSync(parent, { recursive: true, mode: 0o700 });
  const outputDir = resolve(options.outputDir ?? mkdtempSync(join(parent, stamp().replace(/[:.]/g, "-") + "-")));
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const report: PublicReport = { browser: "Camoufox", profile: options.profile, serviceHome: home, outputDir,
    startedAt: stamp(), released: false, stopped: false, initialTabIds: [], errors: [],
    results: PUBLIC_SITES.map(site => ({ ...site, status: "INCONCLUSIVE", reason: "Not visited.", details: {}, errors: [] })) };
  let connection: PublicConnection | undefined, acquired = false, ready = false, halt = false;
  const checkAbort = () => { if (signal?.aborted) throw Error(message(signal.reason)); };
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    checkAbort(); return textResult(await connection!.call(name, args));
  };
  const checkReady = async () => {
    ready = false;
    const status = await call("profile_status");
    if (status.profileId !== options.profile || status.phase !== "ready" || status.controlError) {
      ready = false;
      throw Error("Profile is " + String(status.phase) + ". Start or restore it explicitly before running the suite.");
    }
    if (typeof status.instanceId !== "string" || (report.initialInstanceId && status.instanceId !== report.initialInstanceId)) {
      ready = false; throw Error("The selected Camoufox browser lifetime changed.");
    }
    ready = true; return status;
  };
  persist(report);
  log("Camoufox profile: " + options.profile + ". Report: " + join(outputDir, "report.md"));
  try {
    checkAbort(); connection = await (options.connect ?? (() => connectMcp(options.profile, home)))();
    report.initialInstanceId = String((await checkReady()).instanceId);
    const lease = await call("profile_acquire");
    if (typeof lease.controlHandle !== "string" || !lease.controlHandle) throw Error("The profile did not return a control handle.");
    acquired = true;
    report.initialTabIds = tabIds(await call("camofox_list_tabs"));
    persist(report);
    for (const site of report.results) {
      checkAbort();
      site.startedAt = stamp();
      log("Checking " + site.name + " in Camoufox...");
      let lastImageError: string | undefined;
      let deadline = now() + timeout;
      let controlObserved = false, framePending = false;
      const capture = (reply: ToolReply) => {
        const bytes = screenshotBytes(reply);
        site.screenshot = join(outputDir, site.id + ".png");
        writePrivate(site.screenshot, bytes);
        lastImageError = undefined;
      };
      try {
        await checkReady();
        const tab = await call("camofox_create_tab", { url: site.url });
        if (typeof tab.tabId !== "string" || !uuid.test(tab.tabId)) throw Error("MCP returned an invalid tab ID.");
        site.tabId = tab.tabId;
        while (true) {
          checkAbort();
          if (now() >= deadline && !framePending) {
            site.status = "INCONCLUSIVE";
            site.reason = "No completed verdict within " + timeout / 1000 + " seconds. " + site.reason;
            break;
          }
          const pages: Record<string, unknown>[] = [];
          const parts: string[] = [];
          let offset = 0, previousUrl: string | undefined;
          site.screenshot = undefined;
          while (true) {
            checkAbort();
            if (pages.length && now() >= deadline) throw Error("The site deadline expired during snapshot pagination.");
            const reply = await connection.call("camofox_snapshot", { tabId: site.tabId, ...(offset ? { offset } : {}) });
            const value = textResult(reply);
            if (typeof value.snapshot !== "string" || typeof value.url !== "string") throw Error("MCP returned an invalid snapshot.");
            if (previousUrl && previousUrl !== value.url) throw Error("The page changed during snapshot pagination.");
            previousUrl = value.url;
            pages.push({ url: value.url, snapshot: value.snapshot, offset, hasMore: value.hasMore, nextOffset: value.nextOffset });
            try { capture(reply); } catch (error) { lastImageError = message(error); }
            site.finalUrl = value.url;
            site.snapshot = join(outputDir, site.id + ".snapshot.json");
            writePrivate(site.snapshot, JSON.stringify({ capturedAt: stamp(), pages }, null, 2) + "\n");
            if (!value.hasMore) { parts.push(value.snapshot); break; }
            if (typeof value.nextOffset !== "number" || !Number.isInteger(value.nextOffset) || value.nextOffset <= offset
              || value.nextOffset - offset > value.snapshot.length || pages.length >= 100) {
              throw Error("MCP snapshot pagination did not advance.");
            }
            // Upstream repeats a navigation tail in every window. Omit it until the final window.
            parts.push(value.snapshot.slice(0, value.nextOffset - offset));
            offset = value.nextOffset;
          }
          const snapshot = parts.join("");
          if (framePending) { site.screenshotFramed = true; framePending = false; }
          const challenge = detectHumanChallenge(snapshot);
          if (challenge) {
            site.status = "INCONCLUSIVE"; site.reason = "Human authentication is required: " + challenge;
            if (!site.screenshot) { try { capture(await connection.call("camofox_screenshot", { tabId: site.tabId })); } catch (error) { lastImageError = message(error); } }
            await call("profile_pause"); ready = false; persist(report);
            const confirmed = await (options.confirmHuman ?? confirmHuman)(site, challenge, signal);
            if (!confirmed || signal?.aborted) { site.reason += ". The run ended before authentication was confirmed."; halt = true; break; }
            await call("profile_resume"); await checkReady();
            controlObserved = false; site.screenshotFramed = undefined;
            deadline = now() + timeout;
            continue;
          }
          if (site.screenshotControl && !controlObserved && samePage(site.url, site.finalUrl!) && now() < deadline
            && snapshot.replace(/[‘’]/g, "'").includes(site.screenshotHeading!)) {
            checkAbort();
            const ref = observedButton(snapshot, site.screenshotControl);
            if (ref) {
              site.screenshot = undefined;
              // Native locator clicks scroll the observed control into view before activating it.
              await call("camofox_click", { tabId: site.tabId, ref });
              controlObserved = true; framePending = true;
              continue;
            }
          }
          const assessment: Assessment = samePage(site.url, site.finalUrl!) ? assessSite(site.id, snapshot)
            : { verdict: "INCONCLUSIVE" as const, reason: "Unexpected final URL: " + site.finalUrl, details: {} };
          site.status = assessment.verdict; site.reason = assessment.reason; site.details = assessment.details;
          site.warnings = assessment.warnings;
          site.observedVerdict = assessment.verdict;
          if (site.screenshotControl && !controlObserved && samePage(site.url, site.finalUrl!)) {
            site.status = "INCONCLUSIVE";
            site.reason = "Waiting for an observed test-area control before capturing the result.";
          }
          if (now() > deadline) {
            site.status = "INCONCLUSIVE";
            site.reason = "The completed observation arrived after the " + timeout / 1000 + " second deadline. " + site.reason;
            break;
          }
          persist(report);
          if (site.status !== "INCONCLUSIVE") break;
          if (now() >= deadline) { site.reason = "No completed verdict within " + timeout / 1000 + " seconds. " + site.reason; break; }
          await wait(Math.min(poll, Math.max(0, deadline - now())), signal);
        }
      } catch (error) {
        site.status = "ERROR"; site.reason = message(error); site.errors.push(site.reason);
        try { await checkReady(); } catch (error) { halt = true; report.errors.push(message(error)); }
      }
      // The snapshot's native image is preferred: it shows the same observation as the verdict.
      if (!site.screenshot && site.tabId && ready && !halt && !signal?.aborted) {
        try { capture(await connection.call("camofox_screenshot", { tabId: site.tabId })); }
        catch (error) { lastImageError = message(error); }
      }
      if (!site.screenshot && site.tabId) {
        site.errors.push("Screenshot: " + (lastImageError ?? "No screenshot was captured."));
        site.status = "ERROR";
      }
      site.finishedAt = stamp(); persist(report);
      log(site.status + ": " + site.name + ". " + site.reason);
      if (halt) break;
    }
    if (!halt && !signal?.aborted) {
      await checkReady();
      report.finalTabIds = tabIds(await call("camofox_list_tabs"));
      const required = [...report.initialTabIds, ...report.results.flatMap(site => site.tabId ? [site.tabId] : [])];
      if (required.some(id => !report.finalTabIds!.includes(id))) report.errors.push("A pre-existing tab or suite tab disappeared during the run.");
    }
  } catch (error) { report.errors.push(message(error)); }
  finally {
    if (signal?.aborted) report.interrupted = message(signal.reason);
    // Save every artifact before the explicit lifecycle command closes the browser.
    report.finishedAt = stamp();
    try { persist(report); } catch (error) { report.errors.push("Report: " + message(error)); }
    if (connection) {
      if (acquired) {
        try {
          const current = textResult(await connection.call("profile_status", {}));
          report.finalInstanceId = typeof current.instanceId === "string" ? current.instanceId : undefined;
          if (current.profileId !== options.profile || report.finalInstanceId !== report.initialInstanceId || current.controlError
            || !["ready", "paused", "blocked", "verification_failed", "stopping", "stopped"].includes(String(current.phase))) {
            throw Error("The original Camoufox browser lifetime cannot be verified. No stop was requested.");
          }
          // Retain the controller until shutdown so another client cannot acquire it between release and stop.
          if (current.phase !== "stopped") await (options.stop ?? stopProfile)(options.profile, home);
          const stopped = textResult(await connection.call("profile_status", {}));
          if (stopped.profileId !== options.profile || stopped.instanceId !== report.initialInstanceId || stopped.phase !== "stopped" || stopped.controlError) {
            throw Error("The selected Camoufox browser did not confirm shutdown.");
          }
          report.stopped = true;
          // Shutdown ends the service's controller lease. A release RPC would target a stopped service.
          report.released = true;
          log("Stopped Camoufox profile: " + options.profile + ".");
        } catch (error) { report.errors.push("Stop: " + message(error)); }
        if (!report.stopped) {
          try {
            const release = textResult(await connection.call("profile_release", {}));
            if (release.released !== true) throw Error("The profile did not acknowledge controller release.");
            report.released = true;
          } catch (error) { report.errors.push("Release: " + message(error)); }
        }
      } else if (report.initialInstanceId) {
        try {
          const status = textResult(await connection.call("profile_status", {}));
          report.finalInstanceId = typeof status.instanceId === "string" ? status.instanceId : undefined;
          if (status.profileId !== options.profile || report.finalInstanceId !== report.initialInstanceId || !["ready", "paused", "blocked", "verification_failed"].includes(String(status.phase))) {
            report.errors.push("The original Camoufox browser lifetime was not preserved.");
          }
        } catch (error) { report.errors.push("Final status: " + message(error)); }
      }
      try { await connection.close(); } catch (error) { report.errors.push("Disconnect: " + message(error)); }
    }
    if (signal?.aborted) report.interrupted = message(signal.reason);
    report.finishedAt = stamp();
    try { persist(report); } catch (error) { report.errors.push("Report: " + message(error)); }
  }
  return report;
}

export function parsePublicArgs(args: string[]): { help: boolean } {
  const flags = args.filter(argument => argument !== "--");
  if (!flags.length) return { help: false };
  if (flags.length === 1 && ["--help", "-h"].includes(flags[0]!)) return { help: true };
  throw Error("Use: bun run test:public. Existing profiles are not supported.");
}

if (import.meta.main) {
  try {
    const args = parsePublicArgs(process.argv.slice(2));
    if (args.help) console.log("Use: bun run test:public\nRequires PROXY_TEST_ENV with PROXY_TEST_USAGE=dedicated-public and a persistent PUBLIC_TEST_HOME. See docs/development/testing.md.");
    else {
      const input = dedicatedProxyInputs(process.env.PROXY_TEST_ENV, "public");
      const proxy = input.PROXY_TEST_URL!, expected = input.PROXY_TEST_EXPECTED_IP || undefined;
      const { home, release } = lockPublicProfile(process.env.PUBLIC_TEST_HOME, proxy, expected), profile = PUBLIC_PROFILE;
      let started = false;
      const redact = proxyRedactor([proxy]), env = serviceEnvironment(home);
      async function command(...args: string[]) {
        assertTestHome(home);
        const child = Bun.spawn([process.execPath, "--no-env-file", cli, ...args], {
          cwd: ROOT, env, stdout: "pipe", stderr: "pipe",
        });
        const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        if (code) throw Error(redact(err || out || "The disposable profile command failed."));
      }
      const abort = new AbortController(), onInt = () => abort.abort("SIGINT"), onTerm = () => abort.abort("SIGTERM");
      process.once("SIGINT", onInt); process.once("SIGTERM", onTerm);
      try {
        writeFileSync(join(home, "secrets.env"), `PUBLIC_TEST_PROXY_URL=${JSON.stringify(proxy)}\n`
          + (expected ? `PUBLIC_TEST_EXPECTED_IP=${JSON.stringify(expected)}\n` : ""), { mode: 0o600 });
        await command("setup", "--yes"); started = true; await command("start", profile);
        const report = await runPublicSites({ profile, home, signal: abort.signal });
        started = !report.stopped;
        for (const error of report.errors) console.error(error);
        console.log("Report: " + join(report.outputDir, "report.md"));
        process.exitCode = report.interrupted ? 130 : publicRunPassed(report) ? 0 : 1;
      } finally {
        if (started) {
          try { await command("stop", profile); started = false; }
          catch (error) { console.error(message(error)); process.exitCode = 1; }
        }
        try { if (!started) rmSync(join(home, "secrets.env"), { force: true }); }
        finally { if (!started) release(); }
        process.off("SIGINT", onInt); process.off("SIGTERM", onTerm);
      }
    }
  } catch (error) { console.error(message(error)); process.exitCode = 1; }
}
