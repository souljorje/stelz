import { readFileSync } from "node:fs";
import { join } from "node:path";

type Catalog = { profiles: Array<{ id: string; allowScripts?: unknown }> };
// Read the saved catalog on each call, so a change applies to a running browser at once. Only `true` allows scripts.
const catalog = (home: string) => JSON.parse(readFileSync(join(home, "profiles.json"), "utf8")) as Catalog;

/** True when a saved profile allows scripts. A connection reads this once, to decide whether to list the scripts tools. */
export const anyProfileAllowsScripts = (home: string) => catalog(home).profiles.some(profile => profile.allowScripts === true);

/** Refuse a scripts tool on a profile without the switch. Only a person can turn the switch on, in the CLI or the UI. */
export function assertScriptsAllowed(home: string | undefined, id: string, tool: string) {
  const profile = home ? catalog(home).profiles.find(item => item.id === id) : undefined;
  if (!profile && home) throw Error("The selected profile is no longer configured.");
  if (profile?.allowScripts !== true)
    throw Error(`${tool} is refused. Scripts are off for profile ${id}. A person can turn them on with "stelz profile config ${id} --allow-scripts" or with the Allow scripts setting in the UI. MCP cannot change this setting.`);
}
