import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Tool, ToolResult } from "../browser/catalog.ts";
import { MAX_MAX_CHARS, NO_REF_NOTE } from "../browser/snapshot-view.ts";
import type { TypingMode } from "../browser/typing.ts";
import { createControlRegistry, type Binding, type ControlTransport } from "../mcp/control-registry.ts";
import { createDispatch, type Dispatch } from "../mcp/dispatch.ts";
import { assertScriptsAllowed } from "../profiles/allow-scripts.ts";

// The script SDK. It calls the same dispatch as the MCP server and reads the raw payloads. It never parses formatted text.
// src/sdk/index.ts connects it to the browser service. Tests connect it to a fake transport.
type Json = Record<string, unknown>;
export type ProfileStatus = { phase: string; [key: string]: unknown };
export type Tab = { tabId: string; url: string; title?: string };
export type Direction = "up" | "down" | "left" | "right";
/** `nth` picks one of several elements with the same role and name. It counts from 0, in page order. */
export type TargetOptions = { nth?: number };
export type TypeOptions = TargetOptions & { mode?: TypingMode; pressEnter?: boolean };
export type TimeoutOptions = { timeoutMs?: number };
export type SnapshotOptions = { scope?: { role: string; name?: string; nth?: number }; contains?: string; diff?: boolean };
export type StartOptions = { signal?: AbortSignal };
export type AcquireOptions = {
  /** The name that the UI shows for the job that holds the profile. The default is the file name of the script. */
  label?: string;
  /** Opt in. A failed job saves a snapshot and a screenshot here. The files can contain private page content. */
  artifactsDir?: string;
  /** Receives a warning about the profile. The default is console.warn. */
  onNotice?: (message: string) => void;
};

/** What one SDK call needs from Stelz: the dispatch of the MCP server, a way to end its connection, and the service directory. */
export type Link = { call: Dispatch["call"]; close(): Promise<void>; home: string };
export type Connect = (label: string) => Promise<Link>;
/** One control registry and one dispatch for one call of the SDK. The SDK needs the core tools and tab_evaluate. */
export function createLink<B extends Binding>(options: { defs: readonly Tool[]; transport: ControlTransport<B>; home: string; label: string }): Link {
  const registry = createControlRegistry(options.transport);
  const dispatch = createDispatch({ defs: options.defs, registry, tools: "core,tab_evaluate", home: options.home, label: () => options.label });
  return { call: dispatch.call, close: () => registry.close(), home: options.home };
}

const OWNED_PROFILE_TOOLS = new Set(["profile_release", "profile_pause", "profile_resume"]);
const defined = (value: Json): Json => Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
function object(value: unknown, what: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error(`Stelz returned an invalid ${what}.`);
  return value as Json;
}
const payload = (result: ToolResult, what: string) => object(result.payload, what);
const defaultLabel = () => basename(process.argv[1] ?? "") || "Stelz SDK";

class Session {
  handle?: string;
  closed = false;
  tail: Promise<unknown> = Promise.resolve();
  private redactions = new Set<string>();
  constructor(readonly link: Link, readonly profileId: string) {}
  /** Hide the control handle and every typed text. */
  clean(text: string) {
    for (const value of [this.handle, ...this.redactions]) if (value) text = text.replaceAll(value, "[redacted]");
    return text;
  }
  async call(name: string, args: Json = {}): Promise<ToolResult> {
    const owned = name.startsWith("tab_") || OWNED_PROFILE_TOOLS.has(name);
    if (owned && !this.handle) throw Error("This session has no profile control.");
    if (name === "tab_type" && typeof args.text === "string") this.redactions.add(args.text);
    try {
      return await this.link.call(name, { ...args, profileId: this.profileId, ...(owned ? { controlHandle: this.handle } : {}) });
    } catch (error) {
      throw Error(this.clean(`${name}: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
  /** One queue for the session. A failure cancels the work that comes after it. */
  run<T>(work: () => Promise<T>): Promise<T> {
    const closed = () => Error("This profile session is closed. Use the browser only inside the work function of acquire().");
    if (this.closed) return Promise.reject(closed());
    const next = this.tail.then(() => {
      if (this.closed) throw closed();
      return work();
    });
    this.tail = next;
    return next;
  }
}

// A window that shows interactive lines without a ref starts with this note and a line break.
const NOTE_LINE = `${NO_REF_NOTE}\n`;
/**
 * The text of a page. A long page comes in windows of one view. The next offset of a window tells how they join:
 * the window ended at a line break that the offset skips, or inside a line that is longer than `maxChars`.
 * The joined text has the note about lines without a ref once, on top, as one window has it.
 */
async function readPage(session: Session, tabId: string, options: SnapshotOptions = {}): Promise<string> {
  let text = "", end = 0, offset = 0, noted = false;
  // A script needs every item. A collapsed run would hide some of them.
  let args: Json = defined({ tabId, scope: options.scope, contains: options.contains, diff: options.diff, collapse: false, maxChars: MAX_MAX_CHARS });
  for (;;) {
    const page = payload(await session.call("tab_snapshot", args), "snapshot");
    if (typeof page.snapshot !== "string") throw Error("The snapshot has no text.");
    const hasNote = page.snapshot.startsWith(NOTE_LINE), slice = hasNote ? page.snapshot.slice(NOTE_LINE.length) : page.snapshot;
    noted ||= hasNote;
    const skipped = offset - end;
    if (skipped !== 0 && skipped !== 1) throw Error("The windows of the snapshot do not join.");
    text += (skipped ? "\n" : "") + slice;
    end = offset + slice.length;
    if (page.truncated !== true || typeof page.nextOffset !== "number") return noted ? NOTE_LINE + text : text;
    if (typeof page.viewId !== "string" || page.nextOffset <= offset) throw Error("The snapshot has no valid next window.");
    offset = page.nextOffset;
    args = { tabId, offset, viewId: page.viewId };
  }
}

const target = (role: string, name: string, options: TargetOptions) => ({ role, name, ...(options.nth === undefined ? {} : { nth: options.nth }) });

export class Page {
  constructor(private session: Session, readonly tabId: string) {}
  private tool(name: string, args: Json = {}) { return this.session.call(name, { tabId: this.tabId, ...args }); }
  private act(name: string, args: Json) {
    // The service finds the element in a fresh snapshot in the same step. A script checks the result with expect*.
    return this.session.run(async () => { await this.tool(name, { ...args, observe: "none" }); });
  }
  navigate(url: string) {
    return this.session.run(async () => { await this.tool("tab_navigate", { url }); });
  }
  click(role: string, name: string, options: TargetOptions = {}) {
    return this.act("tab_click", { target: target(role, name, options) });
  }
  /** Uses the typing semantics of Stelz. The profile decides the mode when `mode` is missing. */
  type(role: string, name: string, text: string, options: TypeOptions = {}) {
    return this.act("tab_type", defined({ target: target(role, name, options), text, mode: options.mode, pressEnter: options.pressEnter }));
  }
  select(role: string, name: string, option: string, options: TargetOptions = {}) {
    return this.act("tab_select", { target: target(role, name, options), option });
  }
  press(key: string) {
    return this.act("tab_press", { key });
  }
  scroll(direction: Direction, amount = 500) {
    return this.session.run(async () => { await this.tool("tab_scroll", { direction, amount }); });
  }
  /** The whole page as text, with no collapsed items. It reads every window of a long page. */
  snapshot(options: SnapshotOptions = {}): Promise<string> {
    return this.session.run(() => readPage(this.session, this.tabId, options));
  }
  /** Fails when the element is not on the page before the time limit. The default limit is 10 seconds. The maximum is 60 seconds. */
  expectElement(role: string, name: string, options: TimeoutOptions = {}) {
    return this.expect(`${role} ${JSON.stringify(name)}`, { target: { role, name } }, options);
  }
  /** Fails when no line of the page contains the text before the time limit. The match is not case-sensitive. */
  expectText(text: string, options: TimeoutOptions = {}) {
    return this.expect(`text ${JSON.stringify(text)}`, { contains: text }, options);
  }
  private expect(what: string, condition: Json, options: TimeoutOptions) {
    return this.session.run(async () => {
      const result = payload(await this.tool("tab_wait", defined({ ...condition, timeout: options.timeoutMs })), "wait result");
      if (result.found === true) return;
      const reason = result.reason === "paused" ? "A person paused the profile."
        : result.reason === "releasing" ? "Control of the profile is ending." : `It did not appear in ${result.waitedMs} ms.`;
      throw Error(this.session.clean(`Expected ${what} on the page. ${reason}`));
    });
  }
  /** Runs JavaScript in the page. The service refuses it unless a person turned on Allow scripts for the profile. */
  evaluate(expression: string, options: TimeoutOptions = {}): Promise<unknown> {
    return this.session.run(async () => {
      // The tool list has no tab_evaluate when no profile allows scripts. This check gives the reason in both cases.
      assertScriptsAllowed(this.session.link.home, this.session.profileId, "tab_evaluate");
      return payload(await this.tool("tab_evaluate", defined({ expression, timeoutMs: options.timeoutMs })), "evaluate result").result;
    });
  }
}

export class Browser {
  private lastPage?: Page;
  constructor(private session: Session) {}
  tabs(): Promise<Tab[]> {
    return this.session.run(() => this.list());
  }
  private async list(): Promise<Tab[]> {
    const { tabs } = payload(await this.session.call("tab_list"), "tab list");
    if (!Array.isArray(tabs)) throw Error("Stelz returned an invalid tab list.");
    return tabs.map(value => {
      const tab = object(value, "tab");
      if (typeof tab.tabId !== "string" || typeof tab.url !== "string") throw Error("Stelz returned an invalid tab.");
      return { tabId: tab.tabId, url: tab.url, ...(typeof tab.title === "string" ? { title: tab.title } : {}) };
    });
  }
  page(tabId: string): Page {
    return this.lastPage = new Page(this.session, tabId);
  }
  /** Reuses a tab with exactly this URL or the blank tab of a new browser. Otherwise it creates a tab. */
  open(url: string): Promise<Page> {
    return this.session.run(async () => {
      const tabs = await this.list();
      const existing = tabs.find(tab => tab.url === url) ?? tabs.find(tab => tab.url === "about:blank");
      if (existing) {
        if (existing.url !== url) await this.session.call("tab_navigate", { tabId: existing.tabId, url });
        return this.page(existing.tabId);
      }
      const created = payload(await this.session.call("tab_create", { url }), "tab");
      if (typeof created.tabId !== "string") throw Error("tab_create returned no tab ID.");
      return this.page(created.tabId);
    });
  }
  /** Pauses the browser actions so that a person can work in the same window. The script keeps control. */
  pause() {
    return this.session.run(async () => { await this.session.call("profile_pause"); });
  }
  /** Resumes after the work of a person. The service can check the IP first. */
  resume() {
    return this.session.run(async () => { await this.session.call("profile_resume"); });
  }
  /** Saves a snapshot and a screenshot of the last page that the script used. Both can contain private page content. */
  async captureFailure(directory: string) {
    if (!this.lastPage) return;
    const { tabId } = this.lastPage, path = join(directory, `${Date.now()}-${crypto.randomUUID()}`);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    try { writeFileSync(join(path, "snapshot.txt"), await readPage(this.session, tabId), { mode: 0o600 }); }
    catch { /* A blocked service can refuse diagnostics. Keep the original failure. */ }
    try {
      // A snapshot has no screenshot, so ask for one.
      const image = payload(await this.session.call("tab_screenshot", { tabId }), "screenshot");
      if (image.type === "image" && image.mimeType === "image/png" && typeof image.data === "string")
        writeFileSync(join(path, "page.png"), Buffer.from(image.data, "base64"), { mode: 0o600 });
    } catch { /* A diagnostic is optional. */ }
  }
}

function assertReady(profileId: string, status: Json) {
  if (status.phase === "stopped") throw Error(`Profile ${profileId} is stopped. Call start("${profileId}") first. acquire() does not start a browser.`);
  if (status.phase !== "ready") throw Error(`Profile ${profileId} is not ready. Its phase is ${status.phase}. Run "stelz status ${profileId}".`);
  if (status.verificationRequired && status.verificationStatus !== "verified")
    throw Error(`Profile ${profileId} is not verified. Its verification status is ${status.verificationStatus}. Run "stelz recheck ${profileId}".`);
}

export function createSdk(connect: Connect) {
  /** Starts the browser of a profile, as `profile_start` does, and returns its status. A browser that runs stays as it is. */
  async function start(profileId: string, options: StartOptions = {}): Promise<ProfileStatus> {
    const link = await connect(defaultLabel());
    try {
      // A location failure is a LocationError. It keeps its code and its location details.
      const status = object((await link.call("profile_start", { profileId }, options.signal)).payload, "status");
      return status as ProfileStatus;
    } finally { await link.close(); }
  }

  /** Takes control of one running profile, runs `work`, and releases control. It never starts a browser. */
  async function acquire<T>(profileId: string, work: (browser: Browser) => Promise<T>, options: AcquireOptions = {}): Promise<T> {
    const link = await connect(options.label ?? defaultLabel());
    const session = new Session(link, profileId), browser = new Browser(session);
    const errors: unknown[] = [];
    let value!: T;
    try {
      const status = payload(await session.call("profile_status"), "status");
      assertReady(profileId, status);
      const notice = options.onNotice ?? console.warn;
      if (status.restartToUpdate) notice(`Profile ${profileId} runs an older runtime. Restart it with "stelz restart ${profileId}" when it is safe.`);
      const evidence = (status.location as { evidence?: { stale?: boolean; comparison?: { result?: string } } } | undefined)?.evidence;
      if (evidence?.stale || evidence?.comparison?.result === "conflicting")
        notice(`Stelz reports stale or conflicting location data for profile ${profileId}. Run "stelz status ${profileId}" to see the evidence.`);
      const acquired = payload(await session.call("profile_acquire"), "acquisition");
      if (typeof acquired.controlHandle !== "string" || !acquired.controlHandle) throw Error("Acquisition returned no control handle.");
      session.handle = acquired.controlHandle;
      value = await work(browser);
      await session.tail;
    } catch (error) { errors.push(error); }
    finally {
      session.closed = true;
      try { await session.tail; } catch (error) { if (!errors.includes(error)) errors.push(error); }
      if (session.handle) {
        if (errors.length && options.artifactsDir) {
          try { await browser.captureFailure(options.artifactsDir); } catch { /* Cleanup must still release control. */ }
        }
        try { await session.call("profile_release"); } catch (error) { errors.push(error); }
        session.handle = undefined;
      }
      // A failed release leaves the lease unconfirmed. Closing the registry tries the release once more, as a lost MCP connection does.
      try { await link.close(); } catch { /* The release error is already in errors. */ }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "The job or its cleanup failed.");
    return value;
  }
  return { start, acquire };
}
