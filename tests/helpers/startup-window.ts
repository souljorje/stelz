import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProfileWindows } from "../../src/browser/profile-appearance.ts";
import { assertTestHome } from "./test-home.ts";

/** Inspect native windows as well as MCP tabs, so unregistered diagnostic pages cannot hide. */
export async function assertSingleStartupWindow(home: string, id: string, listing?: Record<string, unknown>) {
  assertTestHome(home);
  const catalog = JSON.parse(readFileSync(join(home, "profiles.json"), "utf8")) as { profiles: { id: string; port: number }[] };
  const profile = catalog.profiles.find(profile => profile.id === id)!;
  const key = readFileSync(join(home, "profiles", id, "access-key"), "utf8").trim();
  let value: ProfileWindows | undefined;
  const deadline = Date.now() + 15_000;
  do {
    const response = await fetch(`http://127.0.0.1:${profile.port}/local-profile/windows`, {
      headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(3000),
    });
    assert.equal(response.status, 200);
    value = await response.json() as ProfileWindows;
    if (value.available) break;
    await Bun.sleep(100);
  } while (Date.now() < deadline);
  assert(value?.available, "The startup window inventory is unavailable.");
  assert.equal(value.windows.length, 1, "Startup opened an extra native window.");
  const tabs = value.windows.flatMap(window => window.tabs);
  assert.equal(tabs.length, 1, "Startup opened an extra native tab.");
  assert.equal(tabs[0]!.url, "about:blank", "Startup navigated the blank page.");
  if (listing) {
    assert(Array.isArray(listing.tabs) && listing.tabs.length === 1, "MCP must expose exactly the original blank tab.");
    const tab = listing.tabs[0] as { tabId: string; url: string };
    assert.equal(tab.url, "about:blank"); assert.equal(typeof tab.tabId, "string");
    return tab.tabId;
  }
}
