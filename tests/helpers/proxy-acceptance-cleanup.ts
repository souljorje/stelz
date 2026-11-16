import { lstatSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PROXY_PROFILE_IDS } from "./proxy-acceptance-helpers.ts";
import { assertTestHome } from "./test-home.ts";

export async function cleanupProxyAcceptance(directory: string, owned: Set<string>, stop: (id: string) => Promise<void>) {
  const home = assertTestHome(directory), failures: string[] = [];
  for (const id of [...owned]) {
    try {
      if (!PROXY_PROFILE_IDS.some(profile => profile === id)) throw Error("Unexpected proxy acceptance profile.");
      await stop(id); owned.delete(id);
    } catch (error) { failures.push(`Stop ${id}: ${String(error)}`); }
  }
  // Do not traverse directory links, including links to a shared runtime or another home.
  function remove(parts: string[], recursive = false) {
    try {
      let parent = home;
      for (const part of parts.slice(0, -1)) {
        parent = join(parent, part);
        const stat = lstatSync(parent, { throwIfNoEntry: false });
        if (!stat) return;
        if (!stat.isDirectory()) throw Error("Refusing a linked or non-directory parent.");
      }
      rmSync(join(home, ...parts), { recursive, force: true });
    } catch (error) { failures.push(`Remove ${parts.join("/")}: ${String(error)}`); }
  }
  // All owned stops must finish before deleting any profile files.
  remove(["secrets.env"]);
  for (const id of PROXY_PROFILE_IDS) {
    if (owned.size === 0) remove(["profiles", id], true);
    else remove(["profiles", id, "window-addon", "background.js"]);
  }
  if (owned.size) failures.push("Profile data retained after a stop failure. Credential cleanup cannot be guaranteed while a browser may still run.");
  if (failures.length) throw Error(failures.join("\n"));
}
