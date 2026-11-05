import { afterEach, expect, test } from "bun:test";
import { ApiError, bootstrapSession, takeSessionToken } from "../../apps/ui/src/api.ts";

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

function browser(hash: string, events: string[]) {
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    location: { hash, pathname: "/", search: "" },
    history: { replaceState: (_state: unknown, _unused: string, url: string) => events.push(`replace:${url}`) },
    setTimeout, clearTimeout,
    get localStorage() { throw Error("Session tokens must not use storage"); },
    get sessionStorage() { throw Error("Session tokens must not use storage"); },
  } });
}

test("the fragment is removed synchronously before the session request", async () => {
  const events: string[] = [];
  browser("#token=one-use-token", events);
  globalThis.fetch = (async (path, init) => {
    events.push(`request:${path}`);
    expect(init?.credentials).toBe("same-origin");
    expect(init?.body).toBe(JSON.stringify({ token: "one-use-token" }));
    return Response.json({ authenticated: true });
  }) as typeof fetch;
  const ready = bootstrapSession();
  expect(events).toEqual(["replace:/", "request:/api/session"]);
  await ready;
});

test("a used launch token falls back to the existing cookie without retrying POST", async () => {
  const events: string[] = [];
  browser("#token=already-used", events);
  globalThis.fetch = (async (path) => {
    events.push(`request:${path}`);
    return path === "/api/session" ? Response.json({ error: "Open a launch URL" }, { status: 401 }) : Response.json({ initialized: true });
  }) as typeof fetch;
  await bootstrapSession();
  expect(events).toEqual(["replace:/", "request:/api/session", "request:/api/state"]);
});

test("missing cookies after a used launch token still report 401", async () => {
  browser("#token=already-used", []);
  globalThis.fetch = (async () => Response.json({ error: "Open a launch URL" }, { status: 401 })) as unknown as typeof fetch;
  try { await bootstrapSession(); throw Error("Expected authentication to fail"); }
  catch (error) { expect(error).toBeInstanceOf(ApiError); expect((error as ApiError).status).toBe(401); }
});

test("no fragment uses the existing cookie and makes no bootstrap request", async () => {
  browser("", []);
  let requested = false;
  globalThis.fetch = (async () => { requested = true; return Response.json({}); }) as unknown as typeof fetch;
  await bootstrapSession();
  expect(requested).toBe(false);
  const urls: (string | URL | null | undefined)[] = [];
  expect(takeSessionToken({ hash: "#token=abc", pathname: "/console", search: "?view=local" }, { replaceState: (_state, _unused, url) => urls.push(url) })).toBe("abc");
  expect(urls).toEqual(["/console?view=local"]);
});
