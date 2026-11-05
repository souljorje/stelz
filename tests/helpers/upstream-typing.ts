import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

type Response = { code: number; payload: Record<string, unknown> };
type RouteResponse = { status(code: number): RouteResponse; json(body: Record<string, unknown>): void };
type Handler = (request: { params: { tabId: string }; body: Record<string, unknown> }, response: RouteResponse) => Promise<void>;

// Execute the installed type route and mutex, without starting the upstream server.
// Virtual timers exercise its real 30-second handler budget without waiting 30 seconds.
export function upstreamTyping(fill: (text: string) => Promise<void>) {
  const root = dirname(createRequire(import.meta.url).resolve("@askjo/camofox-browser/package.json"));
  const source = readFileSync(join(root, "server.js"), "utf8");
  const lockStart = source.indexOf("class TabLock {");
  const lockEnd = source.indexOf("function requestTimeoutMs(", lockStart);
  const routeStart = source.indexOf("app.post('/tabs/:tabId/type',");
  const routeEnd = source.indexOf("\n/**", routeStart);
  if ([lockStart, lockEnd, routeStart, routeEnd].some(index => index < 0)) throw Error("The upstream typing fixture no longer matches.");
  const timers = new Map<number, { at: number; run: () => void }>();
  const events: string[] = [];
  let now = 0, nextTimer = 0, refreshes = 0;
  const tabState = { refs: new Map(), toolCalls: 0, page: {
    locator: () => ({}), isClosed: () => false, url: () => "https://example.test/",
    keyboard: { press: async (key: string) => { events.push(key); } },
  } };
  const scope = {
    HANDLER_TIMEOUT_MS: 30_000, TAB_LOCK_TIMEOUT_MS: 35_000,
    setTimeout: (run: () => void, ms: number) => { const id = ++nextTimer; timers.set(id, { at: now + ms, run }); return id; },
    clearTimeout: (id: number) => { timers.delete(id); },
    refreshTabLockQueueDepth: () => {}, tabLockTimeoutsTotal: { inc() {} },
    isTimeoutError: (error: Error) => /timed out|timeout/i.test(error.message),
    sessions: new Map([["profile-01", {}]]), normalizeUserId: String, findTab: () => ({ tabState }),
    selectorValidationError: () => null, invalidSelectorError: Error, StaleRefsError: Error,
    tabNotFoundResponse: () => { throw Error("Unexpected missing tab"); },
    refToLocator: () => ({}), fillLocator: async (_locator: unknown, text: string) => fill(text),
    refreshTabRefs: async () => { refreshes++; return new Map(); }, safePageUrl: () => "https://example.test/",
    log: () => {}, pluginEvents: { emit() {} }, typeEventPayload: (value: unknown) => value,
    handleRouteError: (error: Error & { code?: string; statusCode?: number }, _request: unknown, response: RouteResponse) =>
      response.status(error.statusCode ?? 500).json({ error: error.message, code: error.code }),
  };
  const handler = new Function("scope", `const { ${Object.keys(scope).join(",")} } = scope;
    let handler;
    const app = { post(_path, callback) { handler = callback; } };
    ${source.slice(lockStart, lockEnd)}
    ${source.slice(routeStart, routeEnd)}
    return handler;`)(scope) as Handler;
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  return {
    events, refreshes: () => refreshes,
    async advance(ms: number) {
      now += ms;
      for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.run(); }
      await flush();
    },
    async call(body: Record<string, unknown> = {}): Promise<Response> {
      let code = 200, payload: Response["payload"] | undefined;
      const response: RouteResponse = { status(value) { code = value; return response; }, json(value) { payload = value; } };
      await handler({ params: { tabId: "test-tab" }, body: { userId: "profile-01", selector: "#message", text: "hello", ...body } }, response);
      if (!payload) throw Error("The upstream typing handler did not respond.");
      return { code, payload };
    },
  };
}
