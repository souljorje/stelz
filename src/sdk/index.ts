import { HOME_DIR, settings } from "../profiles/config.ts";
import { loadContracts } from "../mcp/contracts.ts";
import { serviceTransport } from "../mcp/service-binding.ts";
import { createLink, createSdk, type AcquireOptions, type Browser, type Link, type ProfileStatus, type StartOptions } from "./client.ts";

// The script SDK of Stelz. Run it with Bun, on the machine of the browser service. See docs/sdk.md.
// STELZ_HOME selects the service directory when the module loads: `STELZ_HOME=... bun job.ts`.
export type { AcquireOptions, Browser, Direction, Page, ProfileStatus, SnapshotOptions, StartOptions, Tab, TargetOptions, TypeOptions, TimeoutOptions } from "./client.ts";
export { LocationError } from "../browser/location.ts";

async function connect(label: string): Promise<Link> {
  settings(); // Fails with "Run stelz setup first." when the service directory has no catalog.
  return createLink({ defs: (await loadContracts()).TOOL_DEFS, transport: serviceTransport, home: HOME_DIR, label });
}
const sdk = createSdk(connect);

/**
 * Start the browser of a profile and return its status. This is `profile_start`.
 * A browser that already runs stays as it is. A location failure throws a `LocationError` with its `location` details.
 */
export function start(profileId: string, options: StartOptions = {}): Promise<ProfileStatus> {
  return sdk.start(profileId, options);
}

/**
 * Take control of one running profile, run `work`, and release control when `work` ends or fails.
 * It never starts a browser: a stopped profile fails, and the message names `start()`.
 * The browser and its tabs stay open. Call `acquire` once for each profile.
 */
export function acquire<T>(profileId: string, work: (browser: Browser) => Promise<T>, options: AcquireOptions = {}): Promise<T> {
  return sdk.acquire(profileId, work, options);
}
