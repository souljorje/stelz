import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, UPSTREAM } from "../profiles/config.ts";

// The installed plugin must match the current supervisor's launch fields.
export function assertRuntimePlugin(root = ROOT, upstream = UPSTREAM): void {
  try {
    const current = join(root, "dist/plugin.js"), installed = join(upstream, "plugins/local-profile/index.js");
    if (![current, installed].every(file => lstatSync(file).isFile()) ||
        !readFileSync(current).equals(readFileSync(installed))) throw Error();
  } catch {
    throw Error("The installed browser plugin does not match this package. Stop all profiles and run stelz setup before starting a new browser.");
  }
}
