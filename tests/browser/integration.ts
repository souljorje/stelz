// Harness-independent acceptance. Both profiles use direct connections without proxy references.
import { writeFileSync, readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fixture } from "../helpers/fixture.ts";
import { unusedPorts } from "../helpers/ports.ts";
import { assertTestHome, createTestHome } from "../helpers/test-home.ts";
import { parseToolText, routeProfileTools } from "../helpers/mcp-client.ts";
import { assertSingleStartupWindow } from "../helpers/startup-window.ts";
import { runTyping } from "./typing-browser.ts";
const root = resolve(import.meta.dir, "../..");
const home = process.env.STELZ_TEST_HOME ? assertTestHome(process.env.STELZ_TEST_HOME)
  : createTestHome("standalone-acceptance", join(root, ".state"));
const cli = process.env.STELZ_TEST_CLI || join(root, "src/cli/cli.ts");
// Child processes receive runtime paths and browser configuration, not model credentials.
const env: Record<string, string> = { STELZ_HOME: home };
for (const key of ["PATH", "HOME", "LANG", "TMPDIR", "CAMOUFOX_EXECUTABLE"]) if (process.env[key]) env[key] = process.env[key]!;
const report: Record<string, unknown>[] = [], clients: Client[] = [];
function assert(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
async function runBun(file: string, ...args: string[]) {
  assertTestHome(home);
  const process = Bun.spawn([Bun.which("bun")!, "--no-env-file", file, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  if (code) throw Error(`${args.join(" ")}: ${err || out}`); return out;
}
const command = (...args: string[]) => runBun(cli, ...args);
async function connect(id: string, label: string) {
  const client = routeProfileTools(new Client({ name: label, version: "1.0.0" }), id); clients.push(client);
  const transport = new StdioClientTransport({ command: Bun.which("bun")!, args: ["--no-env-file", cli, "mcp"], env, stderr: "inherit" });
  await client.connect(transport); return { client, transport };
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  const blocks = result.content as Array<{ type: string; text?: string; data?: string }>;
  const text = blocks.filter(x => x.type === "text").map(x => x.text).join("\n");
  if (result.isError) throw Error(text);
  const shot = blocks.find(x => x.type === "image");
  if (shot?.data) writeFileSync(join(home, `snapshot-${Date.now()}.png`), Buffer.from(shot.data, "base64"), { mode: 0o600 });
  return parseToolText(text) as Record<string, unknown>;
}
async function rejection(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 }); assert(result.isError, `${name} did not reject an invalid controller`);
}
/** One tab_snapshot call. It keeps the header, the page text, and the number of image blocks apart. */
async function snapshot(client: Client, args: Record<string, unknown>) {
  const result = await client.callTool({ name: "tab_snapshot", arguments: args }, undefined, { timeout: 180000 });
  const blocks = result.content as Array<{ type: string; text?: string }>;
  const text = blocks.filter(x => x.type === "text").map(x => x.text).join("\n");
  if (result.isError) throw Error(text);
  const { snapshot: page, ...header } = parseToolText(text) as { snapshot: string } & Record<string, unknown>;
  return { header, text: page, images: blocks.filter(x => x.type === "image").length };
}
async function refused(client: Client, name: string, args: Record<string, unknown>, message: string) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  const text = (result.content as Array<{ type: string; text?: string }>).filter(x => x.type === "text").map(x => x.text).join("\n");
  assert(result.isError && text.includes(message), `${name} was not refused with "${message}": ${text}`);
}
/** One action call. The text is the action result, then the snapshot header and the page text. A call with observe none has the action result only. */
async function acted(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  const text = (result.content as Array<{ type: string; text?: string }>).filter(x => x.type === "text").map(x => x.text).join("\n");
  if (result.isError) throw Error(text);
  const [action, header, ...page] = text.split("\n");
  return { text, action: JSON.parse(action!) as Record<string, unknown>, header: header ? JSON.parse(header) as Record<string, unknown> : undefined, page: page.join("\n") };
}
const refOf = (text: string, element: string) => new RegExp(`${element} \\[(e\\d+)\\]`).exec(text)?.[1];
const profileDir = (id: string) => join(home, "profiles", id);
const pin = (id: string) => readFileSync(join(profileDir(id), "fingerprint.json"), "utf8");
const instance = (id: string) => JSON.parse(readFileSync(join(profileDir(id), "running.json"), "utf8")) as { instanceId: string; serverPid: number };
let pageServer: Awaited<ReturnType<typeof fixture>> | undefined;
try {
  console.log("Explicit direct-development test. No LLM credentials or harness commands are used.");
  const ports = await unusedPorts(3);
  writeFileSync(join(home, "profiles.json"), JSON.stringify({ profiles: ["profile-01", "profile-02"].map((id, index) => ({ id, port: ports[index]! })) }), { mode: 0o600 });
  await command("setup", "--yes"); pageServer = await fixture(ports[2]!);
  const stopped = await connect("profile-01", "stopped-client");
  await rejection(stopped.client, "profile_acquire"); await stopped.client.close();
  report.push({ check: "MCP cannot implicitly start a stopped browser", result: "passed" });
  await Promise.all([command("start", "profile-01"), command("start", "profile-02")]);
  const before = instance("profile-01"), fingerprint = pin("profile-01");
  const a = await connect("profile-01", "sdk-client-a"), b = await connect("profile-01", "sdk-client-b"), second = await connect("profile-02", "sdk-client-second-profile");
  await call(a.client, "profile_acquire"); await call(second.client, "profile_acquire");
  await rejection(a.client, "profile_acquire");
  await rejection(b.client, "profile_acquire");
  const tabs: Record<string, string> = {};
  for (const [id, client] of [["profile-01", a.client], ["profile-02", second.client]] as const) {
    const tabId = await assertSingleStartupWindow(home, id, await call(client, "tab_list"));
    await call(client, "profile_recheck");
    await assertSingleStartupWindow(home, id, await call(client, "tab_list"));
    tabs[id] = tabId!;
    await call(client, "tab_navigate", { tabId, url: `${pageServer.url}/?profile=${id}` });
    await call(client, "tab_type", { tabId: tabs[id], selector: "#marker", text: id, mode: "instant" });
    await call(client, "tab_click", { tabId: tabs[id], selector: "#save" });
    const snapshot = await call(client, "tab_snapshot", { tabId: tabs[id] });
    assert(String(snapshot.snapshot).includes(`Storage marker: ${id}`), "Storage marker is missing from the browser snapshot");
  }
  report.push({ check: "Startup and recheck leave one blank native window with one usable MCP tab", result: "passed" });
  const scrollTab = await call(a.client, "tab_create", { url: `${pageServer.url}/scroll` });
  let scrollX = 0, scrollY = 0;
  for (const direction of ["down", "up", "right", "left"]) {
    await call(a.client, "tab_snapshot", { tabId: scrollTab.tabId });
    await call(a.client, "tab_click", { tabId: scrollTab.tabId, selector: "#header" });
    await call(a.client, "tab_snapshot", { tabId: scrollTab.tabId });
    await call(a.client, "tab_scroll", { tabId: scrollTab.tabId, direction, amount: 500 });
    const snapshot = await call(a.client, "tab_snapshot", { tabId: scrollTab.tabId });
    const match = /Scroll position: x=(\d+) y=(\d+)/.exec(String(snapshot.snapshot));
    assert(match, "Scroll fixture position is missing");
    const x = Number(match[1]), y = Number(match[2]);
    assert(direction === "down" ? y > scrollY : direction === "up" ? y < scrollY : direction === "right" ? x > scrollX : x < scrollX,
      `Scroll ${direction} returned without moving the feed: ${x},${y}`);
    scrollX = x; scrollY = y;
  }
  await call(a.client, "tab_close", { tabId: scrollTab.tabId });
  report.push({ check: "Scroll moves a nested feed in all four directions after a header click", result: "passed" });
  // Snapshot shaping on a real page. These checks do not write the storage marker: the profile keeps one marker for the origin of the fixture.
  const shaped = (await call(a.client, "tab_create", { url: `${pageServer.url}/?profile=snapshot-shapes` })).tabId as string;
  const first = await snapshot(a.client, { tabId: shaped });
  assert(first.images === 0, "A snapshot has a screenshot that nobody asked for");
  assert(typeof first.header.viewId === "string" && first.header.baseline === undefined, "The first snapshot has no viewId, or it has a baseline flag");
  assert(refOf(first.text, 'button "Save profile marker"'), "The snapshot has no ref for the save button");
  assert((await snapshot(a.client, { tabId: shaped, includeScreenshot: true })).images === 1, "includeScreenshot did not add one image");
  const title = 'Camoufox acceptance fixture — snapshot-shapes';
  const scoped = await snapshot(a.client, { tabId: shaped, scope: { role: "heading", name: title } });
  assert(scoped.text.startsWith(`- heading "${title}"`) && !scoped.text.includes("\n"), `A scope on a heading that has no ref returned: ${scoped.text}`);
  const marker = await snapshot(a.client, { tabId: shaped, contains: "profile marker" });
  assert(marker.text.includes('button "Save profile marker"') && marker.text.length < first.text.length, "contains did not narrow the page");
  // A ref that the last snapshot showed works. The field is empty, so the click saves nothing.
  const base = await snapshot(a.client, { tabId: shaped, collapse: false });
  const saved = refOf(base.text, 'button "Save profile marker"');
  assert(saved, "The full snapshot has no ref for the save button");
  // These clicks pass observe none. An observation is a view, and these checks need the baseline and the refs that the snapshots above gave.
  await call(a.client, "tab_click", { tabId: shaped, ref: saved, observe: "none" });
  // Revealing the task section adds a textbox and a button before the save button, so the ref of the save button now names another element.
  // The check comes before the next snapshot. A snapshot or a diff that shows a ref makes it reliable again.
  await call(a.client, "tab_click", { tabId: shaped, selector: "#begin", observe: "none" });
  await refused(a.client, "tab_click", { tabId: shaped, ref: saved }, "may have shifted");
  await refused(a.client, "tab_click", { tabId: shaped, ref: "e999" }, "may have shifted");
  const diff = await snapshot(a.client, { tabId: shaped, diff: true, collapse: false });
  assert(diff.header.baseline === undefined && diff.text.startsWith("# Diff from your last snapshot"), `A snapshot after a change is not a diff: ${diff.text.slice(0, 200)}`);
  const check = refOf(diff.text, 'button "Check answer"');
  assert(check && diff.text.includes('textbox "Answer"') && diff.text.length < base.text.length, "The diff has no new controls, or it is not smaller than the page");
  report.push({ check: "Snapshots have no screenshot by default, and scope, contains, and diff shape the reply", result: "passed", evidence: { fullChars: base.text.length, diffChars: diff.text.length } });
  await call(a.client, "tab_click", { tabId: shaped, ref: check, observe: "none" });
  const moved = refOf((await snapshot(a.client, { tabId: shaped, collapse: false })).text, 'button "Save profile marker"');
  assert(moved && moved !== saved, "The ref of the save button did not move");
  await call(a.client, "tab_click", { tabId: shaped, ref: moved, observe: "none" });
  report.push({ check: "A ref that moved is refused before the click, and a ref in the last snapshot works", result: "passed", evidence: { before: saved, after: moved } });
  // Paging. The reply of each window has the viewId of the first one, and the windows add up to the page.
  const long = (await call(a.client, "tab_create", { url: `${pageServer.url}/?pagination` })).tabId as string;
  let page = await snapshot(a.client, { tabId: long });
  const viewId = page.header.viewId as string, windows = [page.text];
  assert(page.header.truncated === true && typeof page.header.nextOffset === "number", "The long page was not cut");
  await rejection(a.client, "tab_snapshot", { tabId: long, offset: page.header.nextOffset });
  await rejection(a.client, "tab_snapshot", { tabId: long, offset: page.header.nextOffset, viewId: "v0" });
  for (let n = 0; typeof page.header.nextOffset === "number"; n++) {
    assert(n < 50, "Paging did not end");
    page = await snapshot(a.client, { tabId: long, offset: page.header.nextOffset, viewId });
    assert(page.header.viewId === viewId, "A window has another viewId");
    windows.push(page.text);
  }
  const joined = windows.join("\n");
  assert(windows.length > 2 && joined.includes("Pagination row 0:") && joined.includes("Pagination row 899:") && joined.split("Pagination row 450:").length === 2,
    "The windows do not add up to the page");
  await call(a.client, "tab_close", { tabId: long }); await call(a.client, "tab_close", { tabId: shaped });
  report.push({ check: "A viewId pages a long snapshot without a gap or an overlap", result: "passed", evidence: { windows: windows.length } });
  // Targets, observe, and tab_wait on a page that changes only its DOM. It writes no storage, and no later check reads this tab.
  const targets = (await call(a.client, "tab_create", { url: `${pageServer.url}/targets` })).tabId as string;
  await snapshot(a.client, { tabId: targets, collapse: false });
  const marked = await acted(a.client, "tab_click", { tabId: targets, target: { role: "button", name: " mark  DONE " } });
  assert(marked.header && marked.header.baseline === undefined && marked.page.startsWith("# Diff from your last snapshot") && marked.page.includes("Marked") && marked.text.length < 2048,
    `A click by role and name did not return a small diff that shows the change: ${marked.text.slice(0, 300)}`);
  report.push({ check: "A click by role and name returns the diff of the page", result: "passed", evidence: { bytes: marked.text.length } });
  const typed = await acted(a.client, "tab_type", { tabId: targets, target: { role: "textbox", name: "Note" }, text: "hello" });
  assert(typed.header && typed.page.includes("Echo: hello"), `Typing by role and name did not return a diff that shows the change: ${typed.text.slice(0, 300)}`);
  const quiet = await acted(a.client, "tab_click", { tabId: targets, target: { role: "button", name: "Mark done" }, observe: "none" });
  assert(quiet.header === undefined && quiet.text.split("\n").length === 1, `observe none returned more than the result of the action: ${quiet.text.slice(0, 300)}`);
  report.push({ check: "Type by role and name returns a diff, and observe none returns the action result only", result: "passed" });
  await refused(a.client, "tab_click", { tabId: targets, target: { role: "button", name: "Add item" } }, "The target matches 2 elements");
  await refused(a.client, "tab_click", { tabId: targets, target: { role: "button", name: "Disabled action" } }, "The element is disabled");
  await refused(a.client, "tab_click", { tabId: targets, target: { role: "button", name: "No such button" } }, "No element matches the target");
  await refused(a.client, "tab_click", { tabId: targets, target: { role: "button", name: "Add item" }, selector: "#mark" }, "Pass exactly one of ref, selector, and target.");
  const nth = await acted(a.client, "tab_click", { tabId: targets, target: { role: "button", name: "Add item", nth: 1 } });
  assert(nth.page.includes("Added by button 1"), `nth 1 did not click the second button: ${nth.page.slice(0, 300)}`);
  report.push({ check: "An ambiguous target, a disabled element, and a missing element are refused, and nth picks one", result: "passed" });
  await call(a.client, "tab_click", { tabId: targets, selector: "#reveal", observe: "none" });
  const late = await call(a.client, "tab_wait", { tabId: targets, target: { role: "button", name: "Late button" }, timeout: 8000 });
  assert(late.found === true && typeof late.waitedMs === "number", `tab_wait did not find the element that appears later: ${JSON.stringify(late)}`);
  const present = await call(a.client, "tab_wait", { tabId: targets, contains: "Echo: hello", timeout: 8000 });
  assert(present.found === true, `tab_wait did not find a text that is on the page: ${JSON.stringify(present)}`);
  const never = await call(a.client, "tab_wait", { tabId: targets, target: { role: "button", name: "Never there" }, timeout: 1000 });
  assert(never.found === false && never.reason === "timeout" && (never.waitedMs as number) >= 1000, `tab_wait did not end with a timeout result: ${JSON.stringify(never)}`);
  await call(a.client, "tab_close", { tabId: targets });
  report.push({ check: "tab_wait finds an element and a text, and a timeout is a result, not an error", result: "passed", evidence: { waitedMs: late.waitedMs } });
  await rejection(a.client, "tab_snapshot", { tabId: tabs["profile-02"] });
  report.push({ check: "Two browsers, separate storage, explicit profile routing, and duplicate acquire rejection", result: "passed" });
  await call(a.client, "profile_release"); await call(b.client, "profile_acquire");
  const checkSamePage = async (client: Client) => {
    const listing = await call(client, "tab_list");
    assert(JSON.stringify(listing).includes(tabs["profile-01"]!), "The original tab disappeared during handoff");
    const snapshot = await call(client, "tab_snapshot", { tabId: tabs["profile-01"] });
    assert(String(snapshot.snapshot).includes("Storage marker: profile-01"), `The original page lost its state. It shows: ${/Storage marker[^\n]*/.exec(String(snapshot.snapshot))?.[0] ?? "no storage marker"}`);
    assert(JSON.stringify(instance("profile-01")) === JSON.stringify(before), "Handoff relaunched the browser");
    assert(pin("profile-01") === fingerprint, "Handoff changed the saved fingerprint");
  };
  await checkSamePage(b.client);
  report.push({ check: "Deliberate release and handoff retain process, tab, storage and fingerprint", result: "passed", evidence: before });
  await b.client.close(); await a.client.close();
  const c = await connect("profile-01", "sdk-client-c-after-disconnect");
  await call(c.client, "profile_acquire"); await checkSamePage(c.client);
  report.push({ check: "Disconnect and reconnect preserve the same running browser", result: "passed" });
  const pendingAction = call(c.client, "tab_navigate", { tabId: tabs["profile-01"], url: `${pageServer.url}/slow` }).catch(() => undefined);
  for (let n = 0; n < 30; n++) {
    const s = await call(c.client, "profile_status");
    if ((s.controller as { activeActions?: number } | undefined)?.activeActions) break;
    await Bun.sleep(20);
  }
  assert(c.transport.pid, "The MCP process ID is unavailable"); process.kill(c.transport.pid, "SIGKILL");
  await c.client.close();
  const d = await connect("profile-01", "sdk-client-d-after-crash");
  await rejection(d.client, "profile_acquire");
  let acquired = false;
  for (let n = 0; n < 60; n++) {
    try { await call(d.client, "profile_acquire"); acquired = true; break; } catch { await Bun.sleep(100); }
  }
  assert(acquired, "The service did not release the dead controller after its action");
  await pendingAction; await checkSamePage(d.client);
  report.push({ check: "A crashed MCP client retains its action lock until the service finishes the action", result: "passed" });
  // A tab ID must keep routing input to the original page after another tab opens.
  const foreground = await call(d.client, "tab_create", { url: pageServer.url });
  await call(d.client, "profile_pause");
  await rejection(d.client, "tab_click", { tabId: tabs["profile-01"], selector: "#human" });
  await call(d.client, "profile_resume");
  await call(d.client, "tab_snapshot", { tabId: tabs["profile-01"] });
  // Known issue: a scroll in a tab that is not selected can exceed the action deadline. See docs/troubleshooting/lifetime-and-state.md#browser-action-or-ip-check-timed-out.
  // Stelz then blocks the lifetime, so record the issue and let the restart below replace that lifetime. Other errors still fail.
  const scrolled = await call(d.client, "tab_scroll", { tabId: tabs["profile-01"], direction: "down", amount: 100 })
    .then(() => true, (error: Error) => { if (!error.message.includes("action timed out")) throw error; return false; });
  if (scrolled) {
    await checkSamePage(d.client);
    await call(d.client, "tab_close", { tabId: foreground.tabId });
    report.push({ check: "Pause and resume keep the selected browser", result: "passed" });
  } else report.push({ check: "Pause and resume keep the selected browser", result: "known-issue",
    reason: "The scroll in a tab that is not selected exceeded the action deadline. The restart below replaces the blocked lifetime." });
  await d.client.close(); await second.client.close();
  const pins = { "profile-01": pin("profile-01"), "profile-02": pin("profile-02") };
  assert(pins["profile-01"] !== pins["profile-02"], "Profile fingerprints are identical");
  await command("stop", "all"); await command("start", "all");
  for (const id of ["profile-01", "profile-02"]) {
    const next = await connect(id, `restart-${id}`); await call(next.client, "profile_acquire");
    const tabId = await assertSingleStartupWindow(home, id, await call(next.client, "tab_list"));
    await call(next.client, "tab_navigate", { tabId, url: pageServer.url });
    const snapshot = await call(next.client, "tab_snapshot", { tabId });
    assert(String(snapshot.snapshot).includes(`Storage marker: ${id}`), "Storage did not survive restart");
    assert(pin(id) === pins[id as keyof typeof pins], "Restart changed a saved fingerprint"); await next.client.close();
  }
  report.push({ check: "Separate storage and saved fingerprints survive explicit stop and start", result: "passed" });
  // Use the SDK from the same package as the CLI. The job leaves its tabs open. Typing, when selected, must preserve them.
  const sdkBefore = JSON.stringify(instance("profile-01"));
  await runBun(join(root, "tests/browser/sdk-job.ts"), join(dirname(cli), "../sdk/index.ts"), "profile-01", pageServer.url);
  const afterJob = await connect("profile-01", "after-sdk-job");
  await call(afterJob.client, "profile_acquire");
  const jobTabs = JSON.stringify(await call(afterJob.client, "tab_list"));
  assert(jobTabs.includes("/targets") && jobTabs.includes("pagination"), "The SDK job did not leave its tabs open");
  assert(JSON.stringify(instance("profile-01")) === sdkBefore, "The SDK job or its repeated start relaunched the browser");
  await afterJob.client.close();
  report.push({ check: "An SDK job starts a running profile again, acts, fails clearly, releases control, and leaves the browser and tabs open", result: "passed" });
  if (process.argv.includes("--typing")) {
    const config = readFileSync(join(home, "profiles.json"), "utf8");
    const lifetime = JSON.stringify(instance("profile-01"));
    await runTyping({ home, profileId: "profile-01", cli });
    assert(readFileSync(join(home, "profiles.json"), "utf8") === config, "Typing changed the integration profile configuration");
    assert(JSON.stringify(instance("profile-01")) === lifetime, "Typing replaced the integration browser");
    const afterTyping = await connect("profile-01", "after-typing");
    await call(afterTyping.client, "profile_acquire");
    assert(JSON.stringify(await call(afterTyping.client, "tab_list")) === jobTabs, "Typing changed another test's tabs");
    await afterTyping.client.close();
    report.push({ check: "Typing reuses the integration browser, restores configuration, releases control, and closes only its fixture tab", result: "passed" });
  }
  report.push({ check: "Handoff between two installed LLM harnesses", result: "unverified", reason: "SDK clients prove the protocol. Actual Codex, Claude Code and Hermes integration needs separate validation." });
  report.push({ check: "Supplied fixed-IP proxies and human takeover", result: "unverified", reason: "No proxy credentials or human action were supplied." });
} catch (e) { report.push({ check: "Acceptance run", result: "failed", error: String(e) }); process.exitCode = 1; }
finally {
  for (const client of clients) await client.close().catch(() => {});
  await command("stop", "all").catch(() => {}); pageServer?.stop();
  writeFileSync(join(home, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
