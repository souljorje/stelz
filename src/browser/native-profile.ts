import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

type Options = Record<string, unknown>;
type Browser = object;
type NavigationRequest = { isNavigationRequest(): boolean };
type Page = {
  url(): string;
  isClosed(): boolean;
  on(event: "close" | "framenavigated", listener: () => void): unknown;
  on(event: "request", listener: (request: NavigationRequest) => void): unknown;
  off(event: "close" | "framenavigated", listener: () => void): unknown;
  off(event: "request", listener: (request: NavigationRequest) => void): unknown;
};
type Context = {
  browser(): Browser | null;
  close(): Promise<void>;
  on(event: "close", listener: () => void): unknown;
  pages(): Page[];
  newPage(): Promise<Page>;
};
type Launcher = {
  launchPersistentContext(directory: string, options: Options): Promise<Context>;
};
type Storage = { directory: string };
type ProfileContext = {
  context: Context; options: Options; claimed: boolean; closed: boolean; takeInitialPage(): Page | undefined;
  startupProtected: boolean; releaseStartup?: () => void;
};
const contexts = new WeakMap<Browser, ProfileContext>();

function trackInitialPage(context: Context): () => Page | undefined {
  const pages = context.pages();
  // Capture only the sole launch page. Never select a later user tab.
  const first = pages.length === 1 ? pages[0] : undefined;
  let initial = first && !first.isClosed() && first.url() === "about:blank" ? first : undefined;
  const navigating = (request: NavigationRequest) => { if (request.isNavigationRequest()) take(); };
  const take = () => {
    const page = initial;
    initial = undefined;
    page?.off("framenavigated", take);
    page?.off("close", take);
    page?.off("request", navigating);
    return page;
  };
  initial?.on("framenavigated", take);
  initial?.on("close", take);
  initial?.on("request", navigating);
  return take;
}

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
    const record: ProfileContext = { context, options: effective, claimed: false, closed: false,
      takeInitialPage: trackInitialPage(context), startupProtected: false };
    context.on("close", () => { record.closed = true; record.takeInitialPage(); record.releaseStartup?.(); });
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

function originalContext(context: Context): ProfileContext {
  const browser = context.browser();
  const record = browser && contexts.get(browser);
  if (!record || record.context !== context) throw Error("Original persistent context is unavailable");
  if (!record.claimed || record.closed) throw Error("Persistent context is not claimed or is closed; explicit restart required");
  return record;
}

/** Hold canonical upstream leases from session publication until its first tab is registered. */
export function protectProfileStartup<Session extends { context: Context }, Lease>(session: Session, api: {
  acquirePageLease(session: Session): Lease;
  setLeasedPage(lease: Lease, page: Page): unknown;
  releasePageLease(session: Session, lease: Lease): void;
}): () => void {
  const record = originalContext(session.context);
  if (record.startupProtected) throw Error("Profile startup was already protected; explicit restart required");
  record.startupProtected = true;
  const leases: Lease[] = [];
  const release = () => {
    for (const lease of leases.splice(0)) api.releasePageLease(session, lease);
    record.releaseStartup = undefined;
  };
  record.releaseStartup = release;
  try {
    const pages = session.context.pages();
    // An empty context still needs a lease until canonical page creation finishes.
    for (const page of pages.length ? pages : [undefined]) {
      const lease = api.acquirePageLease(session);
      leases.push(lease);
      if (page) api.setLeasedPage(lease, page);
    }
  } catch (error) { release(); throw error; }
  return release;
}

export async function createProfilePage(context: Context): Promise<Page> {
  const record = originalContext(context);
  const initial = record.takeInitialPage();
  if (initial && !initial.isClosed() && initial.url() === "about:blank" && context.pages().includes(initial)) return initial;
  return context.newPage();
}
