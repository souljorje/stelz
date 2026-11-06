import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

type Options = Record<string, unknown>;
type Browser = object;
type Context = { browser(): Browser | null; close(): Promise<void>; on(event: "close", listener: () => void): unknown };
type Launcher = {
  launchPersistentContext(directory: string, options: Options): Promise<Context>;
};
type Storage = { directory: string };
const contexts = new WeakMap<Browser, { context: Context; options: Options; claimed: boolean; closed: boolean }>();

function runtimeStorage(): Storage {
  return { directory: process.env.STELZ_PROFILE_DIR || "" };
}

export async function launchProfileBrowser(
  firefox: Launcher, options: Options, contextOptions: Options, storage = runtimeStorage(),
): Promise<Browser> {
  if (!isAbsolute(storage.directory)) throw Error("An absolute profile directory is required");
  const marker = join(storage.directory, "native-profile.json");
  const directory = join(storage.directory, "browser-data");
  if (existsSync(marker) && !existsSync(directory)) throw Error("Native browser data is missing; restore the original browser-data directory before starting this profile");
  if ("storageState" in contextOptions) throw Error("Native profiles must not restore a storage checkpoint on launch");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Context options (permissions, locale, timezone, viewport) must apply at launch,
  // not to a new incognito context after the native profile has already opened.
  const effective = { ...options, ...contextOptions };
  const context = await firefox.launchPersistentContext(directory, effective);
  try {
    const browser = context.browser();
    if (!browser) throw Error("Persistent context has no browser; refusing an ephemeral substitute");
    const record = { context, options: effective, claimed: false, closed: false };
    context.on("close", () => { record.closed = true; });
    contexts.set(browser, record);
    if (!existsSync(marker)) writeFileSync(marker, JSON.stringify({ version: 1 }), { flag: "wx", mode: 0o600 });
    return browser;
  } catch (error) { await context.close().catch(() => {}); throw error; }
}

export async function claimProfileContext(browser: Browser, options: Options): Promise<Context> {
  const record = contexts.get(browser);
  if (!record) throw Error("Original persistent context is unavailable");
  if (record.claimed || record.closed) throw Error("Persistent context was already claimed or closed; explicit restart required");
  for (const [key, value] of Object.entries(options)) {
    if (key === "storageState" || !isDeepStrictEqual(record.options[key], value)) {
      // Do not include values: a mismatching option can contain proxy credentials.
      throw Error(`Persistent context launch/session options disagree: ${key}`);
    }
  }
  record.claimed = true;
  return record.context;
}
