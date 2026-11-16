import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAria } from "../../src/browser/aria.ts";
import type { Contracts } from "../../src/browser/catalog.ts";
import { LocationError, locationResult } from "../../src/browser/location.ts";
import { NO_REF_NOTE, buildView, windowRows, windowView, type Row } from "../../src/browser/snapshot-view.ts";
import type { Binding, ControlTransport } from "../../src/mcp/control-registry.ts";
import { createLink, createSdk, type Browser, type Connect } from "../../src/sdk/client.ts";
import { annotate, helpers } from "../helpers/aria-fixtures.ts";
import { service } from "../helpers/control-service.ts";

// The SDK runs over the real control registry and the real dispatch. The fake service answers the requests of the tools.
// profile_status and profile_start read the live runtime, so the connection answers those two itself.
const upstream = await import(new URL("../../node_modules/@askjo/camofox-browser/mcp/lib/tool-contracts.mjs", import.meta.url).href) as Contracts;
const tab = "79bed5c4-d5b8-4369-9d13-b159451ece91", other = "11111111-1111-4111-8111-111111111111";
const ready = { phase: "ready", verificationRequired: true, verificationStatus: "verified" };

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function temporary(prefix: string) { const directory = mkdtempSync(join(tmpdir(), prefix)); directories.push(directory); return directory; }

type Reply = (args: Record<string, unknown>) => unknown;
function fixture(profiles: Array<Record<string, unknown>> = [{ id: "alpha", port: 9401, allowScripts: true }, { id: "beta", port: 9402 }]) {
  const home = temporary("stelz-sdk-");
  writeFileSync(join(home, "profiles.json"), JSON.stringify({ profiles }));
  const s = service(), replies = new Map<string, Reply>();
  const transport: ControlTransport<Binding> = { ...s.transport, async request(binding, action, body) {
    const result = await s.transport.request(binding, action, body);
    if (action !== "tool") return result;
    const { name, args } = body as { name: string; args: Record<string, unknown> };
    return (replies.get(name)?.(args) ?? { kind: "json", payload: { ok: true } }) as Record<string, unknown>;
  } };
  const state = { status: ready as Record<string, unknown>, startError: undefined as Error | undefined, handles: [] as string[], labels: [] as string[],
    started: [] as Array<{ args: Record<string, unknown>; signal?: AbortSignal }> };
  const connect: Connect = async label => {
    state.labels.push(label);
    const link = createLink({ defs: upstream.TOOL_DEFS, transport, home, label });
    return { ...link, async call(name, args, signal) {
      if (name === "profile_status") return { kind: "json", payload: state.status };
      if (name === "profile_start") {
        state.started.push({ args, signal });
        if (state.startError) throw state.startError;
        return { kind: "json", payload: state.status };
      }
      const result = await link.call(name, args, signal);
      if (name === "profile_acquire") state.handles.push((result.payload as { controlHandle: string }).controlHandle);
      return result;
    } };
  };
  const tools = () => s.sent.filter(request => request.action === "tool").map(request => request.body as { name: string; args: Record<string, unknown> });
  const actions = () => s.sent.map(request => request.action);
  return { home, s, replies, state, sdk: createSdk(connect), tools, actions, reply(name: string, reply: Reply) { replies.set(name, reply); } };
}
const didNotFail = (): never => { throw Error("The work did not fail."); };
const text = (snapshot: string, more: Record<string, unknown> = {}) => ({ kind: "snapshot", payload: { url: "https://example.test/", refsCount: 0, truncated: false, viewId: "v1", snapshot, ...more } });

test("start runs profile_start for the profile, passes the signal, and never acquires control", async () => {
  const f = fixture(), signal = new AbortController().signal;
  f.state.status = { ...ready, profileId: "alpha" };
  expect<unknown>(await f.sdk.start("alpha", { signal })).toEqual(f.state.status);
  // A second start returns the status of the browser that runs. The SDK starts nothing itself.
  expect<unknown>(await f.sdk.start("alpha")).toEqual(f.state.status);
  expect(f.state.started).toEqual([{ args: { profileId: "alpha" }, signal }, { args: { profileId: "alpha" }, signal: undefined }]);
  expect(f.s.sent).toHaveLength(0);
});

test("start keeps the code and the location details of a location failure", async () => {
  const f = fixture(), location = { ...locationResult("blocked"), code: "GEOIP_DATA_STALE", message: "The location data is stale. Run stelz setup." };
  f.state.startError = new LocationError(location);
  const error = await f.sdk.start("alpha").then(didNotFail, cause => cause as LocationError);
  expect(error).toBeInstanceOf(LocationError);
  expect(error.location).toEqual(location);
  expect(error.message).toBe(location.message);
});

test("acquire fails on a stopped profile, names start(), and neither starts nor acquires", async () => {
  const f = fixture();
  f.state.status = { phase: "stopped" };
  let ran = false;
  await expect(f.sdk.acquire("alpha", async () => { ran = true; })).rejects.toThrow('Call start("alpha") first');
  expect(ran).toBe(false);
  expect(f.state.started).toHaveLength(0);
  expect(f.s.sent).toHaveLength(0);
});

test("acquire refuses a profile that is not ready or not verified, before it takes control", async () => {
  const f = fixture();
  f.state.status = { phase: "paused" };
  await expect(f.sdk.acquire("alpha", async () => {})).rejects.toThrow('not ready. Its phase is paused. Run "stelz status alpha"');
  f.state.status = { ...ready, verificationStatus: "unverified" };
  await expect(f.sdk.acquire("alpha", async () => {})).rejects.toThrow('not verified. Its verification status is unverified. Run "stelz recheck alpha"');
  f.state.status = { phase: "ready" };
  expect(await f.sdk.acquire("alpha", async () => "done")).toBe("done");
  expect(f.actions()).toEqual(["acquire", "release"]);
});

test("acquire warns about an older runtime and about stale or conflicting location evidence", async () => {
  const notices: string[] = [], f = fixture();
  await f.sdk.acquire("alpha", async () => {}, { onNotice: message => notices.push(message) });
  expect(notices).toEqual([]);
  f.state.status = { ...ready, restartToUpdate: true, location: { evidence: { stale: true } } };
  await f.sdk.acquire("alpha", async () => {}, { onNotice: message => notices.push(message) });
  expect(notices).toHaveLength(2);
  expect(notices[0]).toContain('"stelz restart alpha"');
  expect(notices[1]).toContain("stale or conflicting");
  f.state.status = { ...ready, location: { evidence: { stale: false, comparison: { result: "conflicting" } } } };
  await f.sdk.acquire("alpha", async () => {}, { onNotice: message => notices.push(message) });
  expect(notices).toHaveLength(3);
});

test("the controller label is the option, or the file name of the script", async () => {
  const f = fixture();
  await f.sdk.acquire("alpha", async () => {}, { label: "nightly report" });
  const previous = process.argv[1];
  process.argv[1] = "/jobs/daily.ts";
  try { await f.sdk.acquire("alpha", async () => {}); } finally { process.argv[1] = previous; }
  expect(f.s.sent.filter(request => request.action === "acquire").map(request => request.body.label)).toEqual(["nightly report", "daily.ts"]);
  expect(f.state.labels).toEqual(["nightly report", "daily.ts"]);
});

test("acquire releases control on success and on error, and leaves the browser and its tabs open", async () => {
  const f = fixture();
  expect(await f.sdk.acquire("alpha", async browser => { await browser.page(tab).click("button", "Save"); return 7; })).toBe(7);
  expect(f.s.owners.size).toBe(0);
  await expect(f.sdk.acquire("alpha", async browser => { await browser.page(tab).press("Enter"); throw Error("job failed"); })).rejects.toThrow("job failed");
  expect(f.s.owners.size).toBe(0);
  expect(f.actions()).toEqual(["acquire", "tool", "release", "acquire", "tool", "release"]);
  expect(f.tools().map(call => call.name)).not.toContain("tab_close");
});

test("acquire releases control when the work ends with an action that nobody awaited", async () => {
  const f = fixture(), gate = f.s.blockWork();
  const job = f.sdk.acquire("alpha", async browser => { void browser.page(tab).click("button", "Save"); });
  await Bun.sleep(10);
  expect(f.s.owners.size).toBe(1);
  gate.resolve();
  await job;
  expect(f.actions()).toEqual(["acquire", "tool", "release"]);
});

test("the control handle never reaches a service request, and a closed session refuses more work", async () => {
  const f = fixture();
  const kept = await f.sdk.acquire<Browser>("alpha", async browser => { await browser.page(tab).click("button", "Save"); return browser; });
  expect(JSON.stringify(f.s.sent.map(request => request.body))).not.toContain(f.state.handles[0]!);
  await expect(kept.page(tab).click("button", "Save")).rejects.toThrow("closed");
  await expect(kept.tabs()).rejects.toThrow("closed");
});

test("an error hides the control handle and the typed text", async () => {
  const f = fixture();
  f.reply("tab_type", args => { throw Error(`Cannot type ${args.text} with ${f.state.handles[0]}`); });
  const error = await f.sdk.acquire("alpha", async browser => { await browser.page(tab).type("textbox", "Password", "hunter2"); }).then(didNotFail, cause => cause as Error);
  expect(error.message).toBe("tab_type: Cannot type [redacted] with [redacted]");
  f.reply("tab_wait", () => ({ kind: "json", payload: { found: false, waitedMs: 10, reason: "timeout" } }));
  const failed = await f.sdk.acquire("alpha", async browser => {
    const page = browser.page(tab);
    f.reply("tab_type", () => ({ kind: "json", payload: { ok: true } }));
    await page.type("textbox", "Password", "hunter2");
    await page.expectText("hunter2 saved", { timeoutMs: 10 });
  }).then(didNotFail, cause => cause as Error);
  expect(failed.message).toBe('Expected text "[redacted] saved" on the page. It did not appear in 10 ms.');
});

test("one queue runs one action at a time, in order", async () => {
  const f = fixture(), gate = f.s.blockWork();
  const job = f.sdk.acquire("alpha", async browser => {
    const page = browser.page(tab);
    const first = page.click("button", "Save"), second = page.type("textbox", "Note", "hello"), third = page.press("Enter");
    await Bun.sleep(10);
    expect(f.tools().map(call => call.name)).toEqual(["tab_click"]);
    gate.resolve();
    await Promise.all([first, second, third]);
  });
  await job;
  expect(f.tools().map(call => call.name)).toEqual(["tab_click", "tab_type", "tab_press"]);
});

test("a failed action cancels the queued work after it, and the SDK never retries it", async () => {
  const f = fixture();
  f.reply("tab_click", () => { throw Error("Timed out. The outcome is unknown."); });
  const error = await f.sdk.acquire("alpha", async browser => {
    const page = browser.page(tab), results = await Promise.allSettled([page.click("button", "Save"), page.click("button", "Save"), page.type("textbox", "Note", "hello")]);
    expect(results.map(result => result.status)).toEqual(["rejected", "rejected", "rejected"]);
    // New work after the failure stays cancelled too.
    await expect(page.press("Enter")).rejects.toThrow("outcome is unknown");
  }).then(didNotFail, cause => cause as Error);
  expect(error.message).toBe("tab_click: Timed out. The outcome is unknown.");
  expect(f.tools().map(call => call.name)).toEqual(["tab_click"]);
  expect(f.s.owners.size).toBe(0);
});

test("actions use a role and name target with observe none", async () => {
  const f = fixture();
  await f.sdk.acquire("alpha", async browser => {
    const page = browser.page(tab);
    await page.navigate("https://example.test/");
    await page.click("button", "Add item", { nth: 1 });
    await page.click("link", "Home");
    await page.type("textbox", "Note", "hello", { mode: "instant", pressEnter: true });
    await page.type("textbox", "Name", "Ada");
    await page.select("combobox", "Size", "large");
    await page.press("Enter");
    await page.scroll("down", 200);
    await page.scroll("up");
  });
  expect(f.tools().map(({ name, args }) => ({ name, args }))).toEqual([
    { name: "tab_navigate", args: { tabId: tab, url: "https://example.test/" } },
    { name: "tab_click", args: { tabId: tab, target: { role: "button", name: "Add item", nth: 1 }, observe: "none" } },
    { name: "tab_click", args: { tabId: tab, target: { role: "link", name: "Home" }, observe: "none" } },
    { name: "tab_type", args: { tabId: tab, target: { role: "textbox", name: "Note" }, text: "hello", mode: "instant", pressEnter: true, observe: "none" } },
    { name: "tab_type", args: { tabId: tab, target: { role: "textbox", name: "Name" }, text: "Ada", observe: "none" } },
    { name: "tab_select", args: { tabId: tab, target: { role: "combobox", name: "Size" }, option: "large", observe: "none" } },
    { name: "tab_press", args: { tabId: tab, key: "Enter", observe: "none" } },
    { name: "tab_scroll", args: { tabId: tab, direction: "down", amount: 200 } },
    { name: "tab_scroll", args: { tabId: tab, direction: "up", amount: 500 } },
  ]);
});

// The windows come from the real windowing code of the service, so the SDK reads what the service sends.
const lines = (...rows: string[]) => rows.map(line => ({ text: line }));
function served(rows: Row[], maxChars: number, refsCount = 0) {
  return (args: Record<string, unknown>) => {
    const page = windowView(rows, typeof args.offset === "number" ? args.offset : 0, maxChars, refsCount, helpers);
    return text(page.text, { truncated: page.truncated, ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }) });
  };
}

test("snapshot returns the page as text, with no collapsed items and every window of a long page", async () => {
  const rows = lines('- heading "One"', ...Array.from({ length: 300 }, (_, index) => `- text: row ${index}`), '- button "Last" [e1]');
  const f = fixture();
  f.reply("tab_snapshot", served(rows, 1000));
  const result = await f.sdk.acquire("alpha", async browser => {
    const page = browser.page(tab);
    return [await page.snapshot({ scope: { role: "main", name: "Results" }, contains: "x", diff: true }), await page.snapshot()];
  });
  const whole = rows.map(row => row.text).join("\n");
  expect(result).toEqual([whole, whole]);
  const calls = f.tools().map(call => call.args), pages = calls.length / 2;
  expect(pages).toBeGreaterThan(2);
  expect(calls[0]).toEqual({ tabId: tab, scope: { role: "main", name: "Results" }, contains: "x", diff: true, collapse: false, maxChars: 80_000 });
  expect(calls[pages]).toEqual({ tabId: tab, collapse: false, maxChars: 80_000 });
  for (const call of [...calls.slice(1, pages), ...calls.slice(pages + 1)]) expect(call).toEqual({ tabId: tab, offset: expect.any(Number), viewId: "v1" });
});

test("snapshot joins a line that a window cut inside the line without a false line break", async () => {
  const long = "x".repeat(2500), rows = lines("- text: first", `- text: ${long}`, "- text: last");
  const f = fixture();
  f.reply("tab_snapshot", served(rows, 1000));
  const joined = await f.sdk.acquire("alpha", browser => browser.page(tab).snapshot());
  expect(joined).toBe(`- text: first\n- text: ${long}\n- text: last`);
  // The service cut inside that line: a window of 1000 characters from the start of the line ends in the line, and its next offset skips no line break.
  const middle = windowRows(rows, "- text: first\n".length, 1000);
  expect(middle.text).toBe(`- text: ${long}`.slice(0, 1000));
  expect(middle.nextOffset).toBe("- text: first\n".length + 1000);
  expect(f.tools().length).toBeGreaterThan(3);
});

test("snapshot keeps the note about lines without a ref once, on top, and joins the windows without it", async () => {
  const plain = Array.from({ length: 700 }, (_, index) => `- button "B${index}"`).join("\n");
  const { yaml, refs } = annotate(plain);
  const rows = buildView(parseAria(yaml), undefined, {}, helpers).rows, serve = served(rows, 1000, refs.size), sent: string[] = [];
  expect(refs.size).toBe(500);
  const f = fixture();
  f.reply("tab_snapshot", args => { const reply = serve(args); sent.push((reply.payload as { snapshot: string }).snapshot); return reply; });
  const joined = await f.sdk.acquire("alpha", browser => browser.page(tab).snapshot());
  // The service sent the note in more than one window. The joined text has it once.
  expect(sent.filter(window => window.startsWith(`${NO_REF_NOTE}\n`)).length).toBeGreaterThan(1);
  expect(joined.split(NO_REF_NOTE)).toHaveLength(2);
  expect(joined).toBe(`${NO_REF_NOTE}\n${rows.map(row => row.text).join("\n")}`);
});

test("snapshot fails when the windows do not join", async () => {
  const f = fixture(), pages = [text("- text: a", { truncated: true, nextOffset: 30 }), text("- text: b")];
  f.reply("tab_snapshot", args => pages[args.offset === undefined ? 0 : 1]);
  await expect(f.sdk.acquire("alpha", browser => browser.page(tab).snapshot())).rejects.toThrow("do not join");
});

test("snapshot fails when a window has no way to the next one, and does not loop", async () => {
  for (const next of [{ nextOffset: 0 }, { viewId: undefined }]) {
    const f = fixture();
    f.reply("tab_snapshot", () => text("- text: a", { truncated: true, nextOffset: 20, ...next }));
    await expect(f.sdk.acquire("alpha", browser => browser.page(tab).snapshot())).rejects.toThrow("no valid next window");
    expect(f.tools().length).toBeLessThanOrEqual(2);
  }
});

test("expectElement and expectText call tab_wait, and fail with a clear message when found is false", async () => {
  const f = fixture();
  let reply: Record<string, unknown> = { found: true, waitedMs: 5 };
  f.reply("tab_wait", () => ({ kind: "json", payload: reply }));
  await f.sdk.acquire("alpha", async browser => {
    const page = browser.page(tab);
    await page.expectElement("button", "Save");
    await page.expectElement("button", "Save", { timeoutMs: 2000 });
    await page.expectText("Saved");
    reply = { found: false, waitedMs: 1003, reason: "timeout" };
    await expect(page.expectElement("button", "Late")).rejects.toThrow('Expected button "Late" on the page. It did not appear in 1003 ms.');
  }).catch(() => {});
  const waits = f.tools().filter(call => call.name === "tab_wait").map(call => call.args);
  expect(waits.slice(0, 3)).toEqual([
    { tabId: tab, target: { role: "button", name: "Save" } },
    { tabId: tab, target: { role: "button", name: "Save" }, timeout: 2000 },
    { tabId: tab, contains: "Saved" },
  ]);
});

test("expect* fails for a timeout, a pause, and a release, and cancels the work after it", async () => {
  for (const [reason, message] of [["timeout", "It did not appear in 1000 ms."], ["paused", "A person paused the profile."], ["releasing", "Control of the profile is ending."]]) {
    const f = fixture();
    f.reply("tab_wait", () => ({ kind: "json", payload: { found: false, waitedMs: 1000, reason } }));
    const error = await f.sdk.acquire("alpha", async browser => {
      const page = browser.page(tab), wait = page.expectText("Ready", { timeoutMs: 1000 }), click = page.click("button", "Save");
      await Promise.allSettled([wait, click]);
    }).then(didNotFail, cause => cause as Error);
    expect(error.message).toBe(`Expected text "Ready" on the page. ${message}`);
    expect(f.tools().map(call => call.name)).toEqual(["tab_wait"]);
  }
  // A timeout that the service refuses, such as a time limit over 60 seconds, is a call error.
  const f = fixture();
  await expect(f.sdk.acquire("alpha", browser => browser.page(tab).expectText("Ready", { timeoutMs: 600_000 }))).rejects.toThrow("timeout must be");
  expect(f.tools()).toHaveLength(0);
});

test("evaluate returns the result, and is refused without the scripts switch of the profile", async () => {
  const f = fixture();
  f.reply("tab_evaluate", () => ({ kind: "json", payload: { ok: true, result: { title: "Example" } } }));
  expect(await f.sdk.acquire("alpha", async browser => {
    const page = browser.page(tab);
    await page.evaluate("1+1");
    return page.evaluate("document.title", { timeoutMs: 5000 });
  })).toEqual({ title: "Example" });
  expect(f.tools().map(call => call.args)).toEqual([{ tabId: tab, expression: "1+1" }, { tabId: tab, expression: "document.title", timeoutMs: 5000 }]);
  // Another profile allows scripts, so the connection lists tab_evaluate. The profile of the job does not.
  const refused = await f.sdk.acquire("beta", browser => browser.page(tab).evaluate("1+1")).then(didNotFail, cause => cause as Error);
  expect(refused.message).toContain('stelz profile config beta --allow-scripts');
  expect(f.tools()).toHaveLength(2);
  // No profile allows scripts, so the connection has no tab_evaluate. The message still names the setting.
  const none = fixture([{ id: "alpha", port: 9401 }]);
  const unlisted = await none.sdk.acquire("alpha", browser => browser.page(tab).evaluate("1+1")).then(didNotFail, cause => cause as Error);
  expect(unlisted.message).toContain("--allow-scripts");
  expect(unlisted.message).not.toContain("Unknown tool");
  expect(none.tools()).toHaveLength(0);
});

test("open reuses a tab with the exact URL, then the blank tab, and otherwise creates a tab", async () => {
  const url = "https://example.test/reports";
  const cases: Array<[Array<{ tabId: string; url: string }>, string[]]> = [
    [[{ tabId: other, url: "about:blank" }, { tabId: tab, url }], ["tab_list"]],
    [[{ tabId: other, url: "https://example.test/" }, { tabId: tab, url: "about:blank" }], ["tab_list", "tab_navigate"]],
    [[{ tabId: other, url: "https://example.test/" }], ["tab_list", "tab_create"]],
  ];
  for (const [tabs, names] of cases) {
    const f = fixture();
    f.reply("tab_list", () => ({ kind: "json", payload: { running: true, tabs } }));
    f.reply("tab_create", () => ({ kind: "json", payload: { tabId: tab, url } }));
    const page = await f.sdk.acquire("alpha", browser => browser.open(url));
    expect(f.tools().map(call => call.name)).toEqual(names);
    expect(page.tabId).toBe(tab);
    const last = f.tools().at(-1)!;
    if (names.includes("tab_navigate")) expect(last.args).toEqual({ tabId: tab, url });
    if (names.includes("tab_create")) expect(last.args).toEqual({ url });
  }
});

test("tabs lists the tabs of the browser and rejects a malformed reply", async () => {
  const f = fixture();
  f.reply("tab_list", () => ({ kind: "json", payload: { running: true, tabs: [{ tabId: tab, url: "about:blank", title: "", targetId: tab }, { tabId: other, url: "https://example.test/" }] } }));
  expect(await f.sdk.acquire("alpha", browser => browser.tabs())).toEqual([{ tabId: tab, url: "about:blank", title: "" }, { tabId: other, url: "https://example.test/" }]);
  f.reply("tab_list", () => ({ kind: "json", payload: { tabs: [{ url: "about:blank" }] } }));
  await expect(f.sdk.acquire("alpha", browser => browser.tabs())).rejects.toThrow("invalid tab");
});

test("pause and resume keep control, and release ends it", async () => {
  const f = fixture();
  await f.sdk.acquire("alpha", async browser => { await browser.pause(); await browser.resume(); });
  expect(f.actions()).toEqual(["acquire", "pause", "resume", "release"]);
  expect(f.s.owners.size).toBe(0);
});

test("a job that fails while paused still releases control", async () => {
  const f = fixture();
  const failure = await f.sdk.acquire("alpha", async browser => { await browser.pause(); throw Error("Sign-in failed"); }).then(didNotFail, cause => cause as Error);
  expect(failure.message).toBe("Sign-in failed");
  expect(f.actions()).toEqual(["acquire", "pause", "release"]);
});

test("a failed release does not hide the error of the job", async () => {
  const f = fixture();
  f.s.failRelease(true);
  const error = await f.sdk.acquire("alpha", async () => { throw Error("job failed"); }).then(didNotFail, cause => cause as AggregateError);
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.errors.map(String).join("\n")).toContain("job failed");
  expect(error.errors.map(String).join("\n")).toContain("Controller cleanup is unconfirmed");
});

test("one acquire for each profile controls several profiles in one script", async () => {
  const f = fixture();
  const seen = await f.sdk.acquire("alpha", async first => {
    await first.page(tab).click("button", "One");
    return f.sdk.acquire("beta", async second => {
      await second.page(other).click("button", "Two");
      return [...f.s.owners.keys()].sort();
    });
  });
  expect(seen).toEqual(["alpha", "beta"]);
  expect(f.s.owners.size).toBe(0);
  expect(f.state.handles).toHaveLength(2);
  expect(f.state.handles[0]).not.toBe(f.state.handles[1]);
  expect(f.s.sent.filter(request => request.action === "tool").map(request => request.body.profileId)).toEqual(["alpha", "beta"]);
});

test("a failed job saves a snapshot and a screenshot only when artifactsDir is set", async () => {
  const image = Buffer.from("png bytes").toString("base64");
  const f = fixture();
  f.reply("tab_snapshot", () => text('- heading "Failed page"'));
  f.reply("tab_screenshot", () => ({ kind: "image", payload: { type: "image", data: image, mimeType: "image/png" } }));
  const job = async (browser: Browser) => { await browser.page(tab).click("button", "Save"); throw Error("job failed"); };
  await expect(f.sdk.acquire("alpha", job)).rejects.toThrow("job failed");
  expect(f.tools().map(call => call.name)).toEqual(["tab_click"]);

  const artifacts = join(temporary("stelz-sdk-artifacts-"), "failures");
  await expect(f.sdk.acquire("alpha", job, { artifactsDir: artifacts })).rejects.toThrow("job failed");
  const [folder, ...rest] = readdirSync(artifacts);
  expect(rest).toEqual([]);
  expect(readFileSync(join(artifacts, folder!, "snapshot.txt"), "utf8")).toBe('- heading "Failed page"');
  expect(readFileSync(join(artifacts, folder!, "page.png"), "utf8")).toBe("png bytes");
  // The screenshot is an explicit call. The snapshot has none.
  expect(f.tools().slice(1).map(call => call.name)).toEqual(["tab_click", "tab_snapshot", "tab_screenshot"]);
  expect(f.actions().at(-1)).toBe("release");

  const clean = join(temporary("stelz-sdk-artifacts-"), "none");
  await f.sdk.acquire("alpha", async browser => { await browser.page(tab).click("button", "Save"); }, { artifactsDir: clean });
  await expect(f.sdk.acquire("alpha", async () => { throw Error("before any page"); }, { artifactsDir: clean })).rejects.toThrow("before any page");
  expect(existsSync(clean)).toBe(false);
});
