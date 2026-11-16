// Real Camoufox acceptance. Uses two isolated profiles and local fixture pages.
import assert from "node:assert/strict";
import { assertTestHome, createTestHome } from "../helpers/test-home.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { profileAppearance, type ProfileWindows } from "../../src/api/contracts.ts";
import { parseToolText, routeProfileTools } from "../helpers/mcp-client.ts";

const root = resolve(import.meta.dir, "../..");
const args = process.argv.slice(2), shared = args[0] === "--reuse";
if (shared ? args.length !== 4 : args.length > 0 && !(args.length === 1 && args[0] === "--inspect"))
  throw Error("Use test:windows [--inspect], or --reuse CLI PROFILE_1 PROFILE_2 in an owned test home.");
const home = shared ? assertTestHome(process.env.STELZ_HOME || "") : createTestHome("profile-windows");
process.env.STELZ_HOME = home;
const { createWindowModel } = await import("../../src/api/window-model.ts");
const windows = createWindowModel();
const cli = (shared ? args[1] : process.env.STELZ_TEST_CLI) || join(root, "src/cli/cli.ts"), bun = Bun.which("bun")!;
const env: Record<string, string> = { STELZ_HOME: home };
for (const key of ["PATH", "HOME", "LANG", "TMPDIR", "CAMOUFOX_EXECUTABLE"]) if (process.env[key]) env[key] = process.env[key]!;
const ids = shared ? args.slice(2) : ["window-check-01", "window-check-02"];
const clients: Client[] = [];
let ui: { stop(): void } | undefined;
const report: Record<string, unknown> = { home, shared, checks: [] };
const foregroundLimits: string[] = [];
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const title = new URL(request.url).pathname === "/beta" ? "Beta fixture" : "Alpha fixture";
  return new Response('<!doctype html><title>' + title + '</title><h1>' + title + '</h1>', { headers: { "Content-Type": "text/html; charset=utf-8" } });
} });
async function command(...args: string[]) {
  const child = Bun.spawn([bun, "--no-env-file", cli, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code) throw Error(args.join(" ") + ": " + (err || out));
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 90_000 });
  const text = (result.content as { type: string; text?: string }[]).filter(item => item.type === "text").map(item => item.text).join("\n");
  if (result.isError) throw Error(text);
  return parseToolText(text);
}
async function connect(id: string) {
  const client = routeProfileTools(new Client({ name: "window-acceptance", version: "1.0.0" }), id); clients.push(client);
  await client.connect(new StdioClientTransport({ command: bun, args: ["--no-env-file", cli, "mcp"], env }));
  await call(client, "profile_acquire");
  return client;
}
async function waitFor(id: string, predicate: (value: ProfileWindows) => boolean) {
  const deadline = Date.now() + 20_000;
  let value: ProfileWindows;
  do {
    value = await windows.list(id);
    if (value.available && predicate(value)) return value;
    await Bun.sleep(150);
  } while (Date.now() < deadline);
  throw Error("Window inventory did not arrive for " + id + ": " + JSON.stringify(value!));
}
function freePort() {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = server.port!; server.stop(true); return port;
}
try {
  console.log("Profile window acceptance: " + home);
  if (!shared) {
    writeFileSync(join(home, "profiles.json"), JSON.stringify({ profiles: ids.map(id => ({
      id, port: freePort(), storage: "native",
    })) }), { mode: 0o600 });
    await command("setup", "--yes");
  }
  assert.notEqual(profileAppearance(ids[0]!).color, profileAppearance(ids[1]!).color);
  for (const id of ids) {
    if (!shared) await command("start", id);
    const client = await connect(id);
    const initialStatus = await call(client, "profile_status"), initialTabs = await call(client, "tab_list");
    const ownedTabs: string[] = [];
    try {
      const first = await call(client, "tab_create", { url: fixture.url + "alpha" });
      ownedTabs.push(first.tabId);
      await call(client, "tab_snapshot", { tabId: first.tabId });
      ownedTabs.push((await call(client, "tab_create", { url: fixture.url + "beta" })).tabId);
      const before = await call(client, "profile_status");
      const servicePort = JSON.parse(readFileSync(join(home, "profiles.json"), "utf8")).profiles.find((row: { id: string }) => row.id === id).port;
      for (const [path, method] of [["windows", "GET"], ["window-bridge", "POST"], ["network-bridge", "POST"], ["window-show", "POST"]]) {
        const unauthenticated = await fetch(`http://127.0.0.1:${servicePort}/local-profile/${path}`, { method,
          ...(method === "POST" ? { headers: { "Content-Type": "application/json" }, body: "{}" } : {}) });
        assert.equal(unauthenticated.status, 401, "Window endpoints require the profile service key");
      }
      const inventory = await waitFor(id, value => value.windows.some(window => window.tabs.some(tab => tab.title === "Alpha fixture"))
        && value.windows.some(window => window.tabs.some(tab => tab.title === "Beta fixture")));
      report.lastInventory = inventory;
      assert.equal(inventory.reason, null);
      assert(inventory.windows.every(window => window.title.startsWith("[" + id + "]")), "Every native window must carry its profile prefix");
      const selected = inventory.windows.find(window => window.tabs.some(tab => tab.title === "Alpha fixture"))!;
      const page = selected.tabs.find(tab => tab.title === "Alpha fixture")!;
      let shown = false;
      try {
        await windows.show(id, { instanceId: inventory.instanceId!, windowId: selected.id, tabId: page.id });
        assert((await windows.list(id)).windows.some(window => window.id === selected.id && window.focused));
        shown = true;
      } catch (error) {
        if (!/foreground/.test(String(error))) throw error;
        foregroundLimits.push(id + ": " + String(error));
      }
      await call(client, "tab_navigate", { tabId: first.tabId, url: fixture.url + "beta" });
      const snapshot = await call(client, "tab_snapshot", { tabId: first.tabId });
      assert.match(JSON.stringify(snapshot), /Beta fixture/);
      const changed = await waitFor(id, value => value.windows.some(window => window.id === selected.id && window.title.includes("Beta fixture")));
      assert(changed.windows.every(window => window.title.startsWith("[" + id + "]")));
      assert(changed.windows.flatMap(window => window.tabs).every(tab => !tab.title.startsWith("[" + id + "]")), "Website titles must remain unchanged");
      await assert.rejects(windows.show(id, { instanceId: "stale-instance", windowId: selected.id }), /Refresh/);
      const after = await call(client, "profile_status");
      assert.equal(after.instanceId, before.instanceId);
      assert.deepEqual(after.controller, before.controller);
      assert.equal(readFileSync(join(home, "profiles", id, "window-addon/manifest.json"), "utf8").includes('"theme"'), true);
      (report.checks as unknown[]).push({ id, storage: "native", windows: changed.windows.length,
        profilePrefix: true, websiteTitlesPreserved: true, showWindow: shown, controllerPreserved: true, staleInstanceRejected: true });
      await call(client, "profile_release"); await client.close();
      const released = await windows.list(id);
      assert(released.available && released.windows.length === changed.windows.length, "Release and disconnect must keep the windows");
    } finally {
      if (shared) {
        // Disconnect first, including on a failed assertion, before acquiring a fresh handle for cleanup.
        await client.close();
        const cleanup = await connect(id);
        try {
          for (const tabId of ownedTabs) await call(cleanup, "tab_close", { tabId });
          assert.deepEqual(await call(cleanup, "tab_list"), initialTabs, "Window checks changed another test's tabs");
          assert.equal((await call(cleanup, "profile_status")).instanceId, initialStatus.instanceId, "Window checks replaced the browser");
          await call(cleanup, "profile_release");
        } finally { await cleanup.close(); }
      }
    }
  }
  report.result = foregroundLimits.length ? "incomplete" : "passed";
  if (foregroundLimits.length) { report.foregroundLimits = foregroundLimits; process.exitCode = 1; }
  if (process.argv.includes("--inspect")) {
    const { createUiServer } = await import("../../src/api/ui-server.ts");
    const preview = createUiServer({ port: 0 }); ui = preview;
    console.log("Review the running profiles for 45 seconds: " + preview.launchUrl);
    await Bun.sleep(45_000);
  }
} catch (error) { report.result = "failed"; report.error = String(error); process.exitCode = 1; }
finally {
  for (const client of clients) await client.close().catch(() => {});
  ui?.stop(); if (!shared) await command("stop", "all").catch(() => {}); fixture.stop(true);
  writeFileSync(join(home, shared ? "windows-report.json" : "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
