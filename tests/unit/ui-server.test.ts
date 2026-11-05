import { afterEach, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { createUiApp, createUiServer, createUiSessionState } from "../../packages/stelz/src/api/ui-server.ts";
import type { UiAction, UiProfile, UiModel, UiSnapshot } from "../../packages/stelz/src/api/contracts.ts";

function profile(id = "profile-02"): UiProfile {
  return {
    id, name: id, port: 9378, storage: "native", typingMode: "auto", phase: "stopped", instanceId: null,
    typing: { revision: "typing-revision-1", mode: null, defaultMode: "auto" },
    exitIp: null, checkedAt: null, fixedIpVerified: false, controller: null,
    windowControls: { available: false, reason: null },
    supervisorPid: null, serverPid: null, ownership: null, fingerprintSha256: null,
    engineSha256: null, error: null, controlError: null, configurationError: null,
    network: { revision: "revision-1", proxyEnv: null, expectedIPEnv: null,
      proxyDisplay: null, proxyConfigured: false, expectedIp: "", proxyReadOnly: false, expectedIpReadOnly: false },
  };
}

function fixture(lifecycle?: (action: UiAction, id: string) => Promise<unknown>, onShutdown?: () => void) {
  const profiles = [profile("profile-01"), profile()];
  let reads = 0;
  const calls: string[] = [];
  const snapshot: UiSnapshot = { home: "/isolated/stelz", version: "test", upstreamVersion: "test",
    initialized: true, setup: true, catalogRevision: "a".repeat(64), profiles, updatedAt: new Date().toISOString() };
  const model: UiModel = {
    async snapshot() { reads++; return structuredClone(snapshot); },
    async detail(id) {
      const found = profiles.find(profile => profile.id === id);
      if (!found) throw Object.assign(Error("Unknown profile."), { status: 404 });
      return { profile: structuredClone(found), directory: `${snapshot.home}/profiles/${id}`, device: { version: null, properties: [] },
        logs: { server: "", supervisor: "" }, mcpCommand: `stelz mcp --profile ${id}` };
    },
    async diagnostics() { return { home: snapshot.home, initialized: true, setup: true, node: true, browserExecutable: true, profiles: [] }; },
    async updateNetwork(id, update) {
      if (update.revision !== "revision-1") throw Object.assign(Error("Configuration changed. Reload before saving."), { status: 409 });
      calls.push(`save:${id}`);
      return profile(id);
    },
    async updateTyping(id, update) {
      if (update.revision !== "typing-revision-1" || update.mode !== null && !["auto", "keyboard", "instant"].includes(update.mode))
        throw Object.assign(Error("Typing input is invalid."), { status: 400 });
      calls.push(`typing:${id}`);
      const row = profile(id);
      return { ...row, typingMode: update.mode ?? row.typing.defaultMode, typing: { ...row.typing, mode: update.mode } };
    },
    async renameProfile(id, update) {
      if (update.revision !== snapshot.catalogRevision) throw Object.assign(Error("Profiles changed. Refresh before continuing."), { status: 409 });
      const row = profiles.find(profile => profile.id === id);
      if (!row) throw Object.assign(Error("Unknown profile."), { status: 404 });
      calls.push(`rename:${id}`);
      row.name = update.name;
      return structuredClone(row);
    },
    async createProfile(input) {
      calls.push(`create:${input.id}`);
      const row = profile(input.id);
      profiles.push(row);
      return row;
    },
    async deleteProfile(id) {
      calls.push(`delete:${id}`);
      profiles.splice(profiles.findIndex(row => row.id === id), 1);
    },
  };
  const sessionState = createUiSessionState();
  const ui = createUiServer({ port: 0, model, sessionState, assets: { "/": { body: "<!doctype html><title>stelz</title>", type: "text/html" },
    "/app.js": { body: "export {};", type: "text/javascript" } },
    lifecycle: lifecycle ?? (async (action, id) => {
      calls.push(`${action}:${id}`);
      profiles.find(profile => profile.id === id)!.phase = action === "start" ? "ready" : action === "stop" ? "stopped" : "paused";
    }),
    onShutdown,
  });
  cleanup.push(ui.stop);
  const token = new URLSearchParams(new URL(ui.launchUrl).hash.slice(1)).get("token")!;
  const request = (path: string, init?: RequestInit) => fetch(`${ui.url}${path}`, init);
  async function authenticate() {
    const response = await request("/api/session", { method: "POST", headers: { Origin: ui.url, "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
    expect(response.status).toBe(200);
    const setCookie = response.headers.get("set-cookie")!;
    return { Cookie: setCookie.split(";")[0]!, Origin: ui.url, "Content-Type": "application/json" };
  }
  return { ...ui, model, sessionState, request, authenticate, token, calls, get reads() { return reads; } };
}

const cleanup: (() => unknown)[] = [];
afterEach(() => { for (const stop of cleanup.splice(0)) stop(); });

test("profile creation and deletion require a same-origin session and bounded revision input", async () => {
  const f = fixture(), auth = await f.authenticate();
  const body = JSON.stringify({ id: "work", revision: "a".repeat(64) });
  expect((await f.request("/api/profiles", { method: "POST", headers: { "Content-Type": "application/json", Origin: f.url }, body })).status).toBe(401);
  expect((await f.request("/api/profiles", { method: "POST", headers: { ...auth, Origin: "https://elsewhere.test" }, body })).status).toBe(403);
  const created = await f.request("/api/profiles", { method: "POST", headers: auth, body });
  expect(created.status).toBe(201);
  expect((await created.json() as { profile: UiProfile }).profile).toMatchObject({ id: "work", phase: "stopped" });
  for (const body of ['{}', '{"revision":"invalid"}', JSON.stringify({ revision: "a".repeat(64), force: true })]) {
    expect((await f.request("/api/profiles/work", { method: "DELETE", headers: auth, body })).status).toBe(400);
  }
  expect((await f.request("/api/profiles/work", { method: "DELETE", headers: { ...auth, Origin: "https://elsewhere.test" }, body: JSON.stringify({ revision: "a".repeat(64) }) })).status).toBe(403);
  const deleted = await f.request("/api/profiles/work", { method: "DELETE", headers: auth, body: JSON.stringify({ revision: "a".repeat(64) }) });
  expect(await deleted.json()).toEqual({ deleted: true });
  expect(f.calls).toEqual(["create:work", "delete:work"]);
  expect((await f.request("/api/profiles/work", { headers: auth })).status).toBe(404);
});

test("typing preferences use an authenticated same-origin PUT and expose the saved mode", async () => {
  const f = fixture(), auth = await f.authenticate();
  const path = "/api/profiles/profile-02/typing", body = JSON.stringify({ revision: "typing-revision-1", mode: "keyboard" });
  expect((await f.request(path, { method: "PUT", headers: { Origin: f.url, "Content-Type": "application/json" }, body })).status).toBe(401);
  expect((await f.request(path, { method: "PUT", headers: { ...auth, Origin: "https://other.test" }, body })).status).toBe(403);
  expect((await f.request(path, { headers: auth })).status).toBe(405);
  expect((await f.request(path, { method: "PUT", headers: auth, body: JSON.stringify({ revision: "typing-revision-1", mode: "invalid" }) })).status).toBe(400);
  const response = await f.request(path, { method: "PUT", headers: auth, body });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ profile: { typingMode: "keyboard" } });
  const inherited = await f.request(path, { method: "PUT", headers: auth, body: JSON.stringify({ revision: "typing-revision-1", mode: null }) });
  expect(inherited.status).toBe(200);
  expect(await inherited.json()).toMatchObject({ profile: { typingMode: "auto", typing: { mode: null } } });
  expect(f.calls).toEqual(["typing:profile-02", "typing:profile-02"]);
});

test("profile rename requires an authenticated same-origin PATCH with a bounded JSON object", async () => {
  const f = fixture(), auth = await f.authenticate(), path = "/api/profiles/profile-02";
  const body = JSON.stringify({ revision: "a".repeat(64), name: "Work profile" });
  expect((await f.request(path, { method: "PATCH", headers: { Origin: f.url, "Content-Type": "application/json" }, body })).status).toBe(401);
  expect((await f.request(path, { method: "PATCH", headers: { ...auth, Origin: "https://other.test" }, body })).status).toBe(403);
  expect((await f.request(path, { method: "PATCH", headers: { Cookie: auth.Cookie, "Content-Type": "application/json" }, body })).status).toBe(403);
  expect((await f.request(path, { method: "PATCH", headers: { ...auth, Host: "attacker.test" }, body })).status).toBe(403);
  for (const method of ["POST", "PUT", "OPTIONS"]) {
    const response = await f.request(path, { method, headers: auth, body });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, PATCH, DELETE");
  }
  for (const body of ["[]", "null", "{", '"name"'])
    expect((await f.request(path, { method: "PATCH", headers: auth, body })).status).toBe(400);
  expect((await f.request(path, { method: "PATCH", headers: { ...auth, "Content-Type": "text/plain" }, body })).status).toBe(415);
  expect((await f.request(path, { method: "PATCH", headers: auth, body: JSON.stringify({ name: "a".repeat(20_000) }) })).status).toBe(413);
  expect((await f.request("/api/profiles/profile%2D02", { method: "PATCH", headers: auth, body })).status).toBe(404);
  expect((await f.request("/api/profiles/unknown", { method: "PATCH", headers: auth, body })).status).toBe(404);
  expect(f.calls).toEqual([]);
  const stale = await f.request(path, { method: "PATCH", headers: auth, body: JSON.stringify({ revision: "b".repeat(64), name: "Stale" }) });
  expect(stale.status).toBe(409);
  const response = await f.request(path, { method: "PATCH", headers: auth, body });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toMatchObject({ profile: { id: "profile-02", name: "Work profile", phase: "stopped" } });
  expect((await (await f.request(path, { headers: auth })).json()).profile.name).toBe("Work profile");
  expect(f.calls).toEqual(["rename:profile-02"]);
});

test("profile rename bounds streamed request bodies before model dispatch", async () => {
  const f = fixture(), auth = await f.authenticate();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(20_000).fill(32)); },
    cancel() { cancelled = true; },
  });
  const response = await f.app.fetch(new Request(`${f.url}/api/profiles/profile-02`, {
    method: "PATCH", headers: { ...auth, Host: new URL(f.url).host, "Content-Length": "1" }, body,
  }), { origin: f.url });
  expect(response.status).toBe(413);
  expect(cancelled).toBe(true);
  expect(f.calls).toEqual([]);
  expect(f.sessionState.activeMutations).toBe(0);
});

test("profile rename exposes pending state and excludes other writes and UI shutdown", async () => {
  const f = fixture(), auth = await f.authenticate(), path = "/api/profiles/profile-02";
  let finish!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const operation = new Promise<void>(resolve => { finish = resolve; });
  const rename = f.model.renameProfile;
  f.model.renameProfile = async (id, update) => { entered(); await operation; return rename(id, update); };
  const body = JSON.stringify({ revision: "a".repeat(64), name: "Current name" });
  const first = f.request(path, { method: "PATCH", headers: auth, body });
  await started;
  try {
    const snapshot = await (await f.request("/api/state", { headers: auth })).json();
    const detail = await (await f.request(path, { headers: auth })).json();
    expect(snapshot.profiles[1].pendingAction).toBe("rename");
    expect(detail.profile.pendingAction).toBe("rename");
    expect(f.sessionState.activeMutations).toBe(1);
    for (const [suffix, method, payload] of [
      ["", "PATCH", { revision: "a".repeat(64), name: "Duplicate" }],
      ["", "DELETE", { revision: "a".repeat(64) }],
      ["/network", "PUT", { revision: "revision-1" }],
      ["/typing", "PUT", { revision: "typing-revision-1", mode: "keyboard" }],
      ["/actions", "POST", { action: "start" }],
      ["/window", "POST", { instanceId: "existing" }],
    ] as const) {
      expect((await f.request(path + suffix, { method, headers: auth, body: JSON.stringify(payload) })).status).toBe(409);
    }
    expect((await f.request("/api/shutdown", { method: "POST", headers: auth, body: "{}" })).status).toBe(409);
    expect(f.sessionState.ended).toBe(false);
    expect(f.calls).toEqual([]);
  } finally { finish(); }
  expect((await first).status).toBe(200);
  expect(f.sessionState.activeMutations).toBe(0);
  const snapshot = await (await f.request("/api/state", { headers: auth })).json();
  expect(snapshot.profiles[1]).toMatchObject({ name: "Current name" });
  expect(snapshot.profiles[1].pendingAction).toBeUndefined();
  expect(f.calls).toEqual(["rename:profile-02"]);
});

test("rename errors remain sanitized and release the pending operation", async () => {
  const f = fixture(), auth = await f.authenticate(), path = "/api/profiles/profile-02", rename = f.model.renameProfile;
  f.model.renameProfile = async () => { throw Object.assign(Error("Save failed: http://rename-user:rename-password@proxy.test"), { status: 409 }); };
  const request = () => f.request(path, { method: "PATCH", headers: auth, body: JSON.stringify({ revision: "a".repeat(64), name: "Retry" }) });
  const response = await request();
  expect(response.status).toBe(409);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).not.toMatch(/rename-user|rename-password/);
  expect(f.sessionState.activeMutations).toBe(0);
  expect(f.sessionState.pending.size).toBe(0);
  f.model.renameProfile = rename;
  expect((await request()).status).toBe(200);
});

describe("local UI session boundary", () => {
  test("recreated Hono applications retain the existing session and consumed launch token", async () => {
    const f = fixture(), auth = await f.authenticate();
    const app = createUiApp({ model: f.model, sessionState: f.sessionState, assets: {} });
    const headers = { ...auth, Host: new URL(f.url).host };
    const response = await app.fetch(new Request(`${f.url}/api/state`, { headers }), { origin: f.url });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ home: "/isolated/stelz" });
    const reused = await app.fetch(new Request(`${f.url}/api/session`, {
      method: "POST", headers, body: JSON.stringify({ token: f.token }),
    }), { origin: f.url });
    expect(reused.status).toBe(401);
    expect(f.calls).toEqual([]);
  });

  test("serves offline assets with restrictive headers and requires a session for state", async () => {
    const f = fixture();
    expect(f.server.hostname).toBe("127.0.0.1");
    const page = await f.request("/");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(page.headers.get("content-security-policy")).not.toContain("unsafe-inline");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await page.text()).not.toContain(f.token);
    expect((await f.request("/api/state")).status).toBe(401);
    expect(f.reads).toBe(0);
    expect((await f.request("/src/config.ts")).status).toBe(404);
    expect((await f.request("/%2e%2e/profiles.json")).status).toBe(404);
    expect((await f.request("/app.js", { method: "POST" })).status).toBe(405);
  });

  test("exchanges the one-use launch token for an HttpOnly strict session", async () => {
    const f = fixture();
    const session = await f.request("/api/session", { method: "POST", headers: { Origin: f.url, "Content-Type": "application/json" }, body: JSON.stringify({ token: f.token }) });
    const cookie = session.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    const auth = { Cookie: cookie.split(";")[0]! };
    expect((await f.request("/api/state", { headers: auth })).status).toBe(200);
    expect((await f.request("/api/session", { method: "POST", headers: { Origin: f.url, "Content-Type": "application/json" }, body: JSON.stringify({ token: f.token }) })).status).toBe(401);
    expect((await f.request("/api/state", { headers: { Cookie: "stelz_ui_1=wrong" } })).status).toBe(401);
  });

  test("rejects cross-origin and DNS-rebinding requests before model access", async () => {
    const f = fixture(), auth = await f.authenticate();
    expect((await f.request("/api/state", { headers: { ...auth, Host: "attacker.example" } })).status).toBe(403);
    expect((await f.request("/api/state", { headers: { ...auth, Origin: "http://127.0.0.1:8000" } })).status).toBe(403);
    expect((await f.request("/api/profiles/profile-02/actions", { method: "POST", headers: { Cookie: auth.Cookie, "Content-Type": "application/json" }, body: '{"action":"start"}' })).status).toBe(403);
    expect(f.reads).toBe(0);
    expect(f.calls).toEqual([]);
  });

  test("bounds and validates request bodies before dispatch", async () => {
    const f = fixture(), auth = await f.authenticate(), path = "/api/profiles/profile-02/actions";
    for (const body of ["[]", "null", "{", '{"action":"acquire"}', '{"action":"start","command":"rm"}']) {
      expect((await f.request(path, { method: "POST", headers: auth, body })).status).toBe(400);
    }
    expect((await f.request(path, { method: "POST", headers: { ...auth, "Content-Type": "text/plain" }, body: '{"action":"start"}' })).status).toBe(415);
    expect((await f.request(path, { method: "POST", headers: auth, body: JSON.stringify({ action: "start", extra: "a".repeat(20_000) }) })).status).toBe(413);
    expect(f.calls).toEqual([]);
  });

  test("bounds streamed bodies even when content-length declares a smaller size", async () => {
    const f = fixture(), auth = await f.authenticate();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(20_000).fill(32)); },
      cancel() { cancelled = true; },
    });
    const response = await f.app.fetch(new Request(`${f.url}/api/profiles/profile-02/actions`, {
      method: "POST", headers: { ...auth, Host: new URL(f.url).host, "Content-Length": "1" }, body,
    }), { origin: f.url });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "The request is too large." });
    expect(cancelled).toBe(true);
    expect(f.calls).toEqual([]);
  });

  test("encoded paths cannot bypass exact API, profile, or bundled-asset matching", async () => {
    const f = fixture(), auth = await f.authenticate();
    for (const path of ["/api/profiles/%69dentity-02", "/api/profiles/profile%2D02", "/api/profiles/Profile-02", "/api%2Fstate", "/%61pp.js", "/app%2Ejs"]) {
      expect((await f.request(path, { headers: auth })).status).toBe(404);
    }
    const invalidSession = await f.request("/api/sess%69on", { method: "POST", headers: { Origin: f.url, "Content-Type": "application/json" }, body: JSON.stringify({ token: f.token }) });
    expect(invalidSession.status).toBe(401);
    expect(f.reads).toBe(0);
    expect(f.calls).toEqual([]);
  });

  test("Hono HEAD handling preserves existing API methods without reading or changing profiles", async () => {
    const f = fixture(), auth = await f.authenticate();
    for (const [path, status, allow] of [
      ["/", 200, null], ["/app.js", 200, null], ["/api/state", 404, null], ["/api/diagnostics", 404, null],
      ["/api/session", 405, "POST"], ["/api/profiles/profile-02", 405, "GET, PATCH, DELETE"],
      ["/api/profiles/profile-02/actions", 405, "POST"], ["/api/profiles/profile-02/network", 405, "PUT"],
    ] as const) {
      const response = await f.request(path, { method: "HEAD", headers: auth });
      expect(response.status).toBe(status);
      expect(response.headers.get("allow")).toBe(allow);
      expect(await response.text()).toBe("");
    }
    expect(f.reads).toBe(0);
    expect(f.calls).toEqual([]);
  });

  test("middleware keeps security headers and sanitized JSON on routing and application errors", async () => {
    const f = fixture(), auth = await f.authenticate();
    f.model.diagnostics = async () => { throw Error("Failed http://private-reader:private-password@proxy.example:8000"); };
    const responses = [
      await f.request("/api/state"),
      await f.request("/", { headers: { Host: "attacker.example" } }),
      await f.request("/api/missing", { headers: auth }),
      await f.request("/api/profiles/profile-02/actions", { headers: auth }),
      await f.request("/api/diagnostics", { headers: auth }),
    ];
    expect(responses.map(response => response.status)).toEqual([401, 403, 404, 405, 500]);
    for (const response of responses) {
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      const value = await response.text();
      expect(value).not.toContain("private-reader");
      expect(value).not.toContain("private-password");
    }
  });
});

describe("local UI lifecycle", () => {
  test("shutdown requires an authenticated same-origin POST with an empty body", async () => {
    const f = fixture(), auth = await f.authenticate();
    const path = "/api/shutdown", body = "{}";
    expect((await f.request(path, { method: "POST", headers: { Origin: f.url, "Content-Type": "application/json" }, body })).status).toBe(401);
    expect((await f.request(path, { method: "POST", headers: { ...auth, Origin: "https://attacker.example" }, body })).status).toBe(403);
    expect((await f.request(path, { method: "POST", headers: { Cookie: auth.Cookie, "Content-Type": "application/json" }, body })).status).toBe(403);
    const get = await f.request(path, { headers: auth });
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    expect((await f.request(path, { method: "POST", headers: auth, body: '{"force":true}' })).status).toBe(400);
    expect(f.sessionState.ended).toBe(false);
    expect((await f.request("/api/state", { headers: auth })).status).toBe(200);
    expect(f.calls).toEqual([]);
  });

  test("shutdown acknowledges, expires the cookie, revokes shared sessions, and closes the listener without browser actions", async () => {
    const f = fixture(), auth = await f.authenticate();
    const response = await f.request("/api/shutdown", { method: "POST", headers: auth, body: "{}" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stopped: true });
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(f.sessionState.ended).toBe(true);
    expect(f.sessionState.bootstrapToken).toBeNull();
    const app = createUiApp({ model: f.model, sessionState: f.sessionState, assets: {} });
    const headers = { ...auth, Host: new URL(f.url).host };
    for (const path of ["/api/state", "/api/session"]) {
      const request = new Request(`${f.url}${path}`, path === "/api/session"
        ? { method: "POST", headers, body: JSON.stringify({ token: f.token }) } : { headers });
      expect((await app.fetch(request, { origin: f.url })).status).toBe(401);
    }
    const deadline = Date.now() + 2000;
    let closed = false;
    while (Date.now() < deadline) {
      try { await f.request("/"); } catch { closed = true; break; }
      await Bun.sleep(10);
    }
    expect(closed).toBe(true);
    expect(f.calls).toEqual([]);
    expect(f.reads).toBe(0);
  });

  test("shutdown drains responses before closing keep-alive sockets and notifying the CLI", async () => {
    let notifications = 0;
    const f = fixture(undefined, () => { notifications++; }), auth = await f.authenticate();
    const idle = connect({ host: "127.0.0.1", port: Number(new URL(f.url).port) });
    cleanup.push(() => idle.destroy());
    let idleClosed = false, idleResponse = "";
    idle.once("close", () => { idleClosed = true; });
    const ready = new Promise<void>((resolve, reject) => {
      idle.on("data", chunk => {
        idleResponse += chunk.toString();
        if (idleResponse.endsWith("<!doctype html><title>stelz</title>")) resolve();
      });
      idle.once("error", reject);
    });
    idle.write(`GET / HTTP/1.1\r\nHost: ${new URL(f.url).host}\r\nConnection: keep-alive\r\n\r\n`);
    await ready;
    expect(idleResponse).toContain("HTTP/1.1 200");
    expect(idleClosed).toBe(false);

    let finish!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const responseDone = new Promise<void>(resolve => { finish = resolve; });
    const snapshot = f.model.snapshot;
    f.model.snapshot = async () => { entered(); await responseDone; return snapshot(); };
    const observation = f.request("/api/state", { headers: auth });
    void observation.catch(() => {});
    await started;
    try {
      const response = await f.request("/api/shutdown", { method: "POST", headers: auth, body: "{}" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ stopped: true });
      await Bun.sleep(40);
      expect(notifications).toBe(0);
      expect(f.server.pendingRequests).toBe(1);
    } finally { finish(); }
    const response = await observation;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ home: "/isolated/stelz" });

    const deadline = Date.now() + 2000;
    while ((!idleClosed || !notifications) && Date.now() < deadline) await Bun.sleep(10);
    expect(idleClosed).toBe(true);
    expect(notifications).toBe(1);
    expect(f.calls).toEqual([]);
    expect(f.reads).toBe(1);
    const fresh = connect({ host: "127.0.0.1", port: Number(new URL(f.url).port) });
    cleanup.push(() => fresh.destroy());
    const refused = await new Promise<boolean>(resolve => {
      fresh.once("error", error => resolve((error as NodeJS.ErrnoException).code === "ECONNREFUSED"));
      fresh.once("connect", () => resolve(false));
    });
    expect(refused).toBe(true);
  });

  for (const operation of ["start", "create"] as const) test(`shutdown refuses while a ${operation} operation is active`, async () => {
    let finish!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const operationDone = new Promise<void>(resolve => { finish = resolve; });
    const wait = async () => { entered(); await operationDone; };
    const f = fixture(wait), auth = await f.authenticate();
    if (operation === "create") f.model.createProfile = async input => { await wait(); return profile(input.id); };
    const first = f.request(operation === "start" ? "/api/profiles/profile-02/actions" : "/api/profiles", {
      method: "POST", headers: auth, body: JSON.stringify(operation === "start" ? { action: "start" } : { id: "new" }),
    });
    await started;
    try {
      const response = await f.request("/api/shutdown", { method: "POST", headers: auth, body: "{}" });
      expect(response.status).toBe(409);
      expect(f.sessionState.ended).toBe(false);
      expect(f.sessionState.activeMutations).toBe(1);
    } finally { finish(); }
    expect((await first).ok).toBe(true);
    expect(f.sessionState.activeMutations).toBe(0);
    expect((await f.request("/api/shutdown", { method: "POST", headers: auth, body: "{}" })).status).toBe(200);
  });

  test("observations and closing the UI never change controller or browser lifetime", async () => {
    const f = fixture(), auth = await f.authenticate();
    for (const path of ["/api/state", "/api/profiles/profile-02", "/api/diagnostics"]) {
      expect((await f.request(path, { headers: auth })).status).toBe(200);
    }
    f.stop();
    expect(f.calls).toEqual([]);
  });

  test("only dispatches explicit supported lifecycle actions for known profiles", async () => {
    const f = fixture(), auth = await f.authenticate();
    for (const action of ["start", "pause", "resume", "recheck", "release", "stop"]) {
      const response = await f.request("/api/profiles/profile-02/actions", { method: "POST", headers: auth, body: JSON.stringify({ action }) });
      expect(response.status).toBe(200);
      expect((await response.json()).profile.id).toBe("profile-02");
    }
    expect(f.calls).toEqual(["start", "pause", "resume", "recheck", "release", "stop"].map(action => `${action}:profile-02`));
    expect((await f.request("/api/profiles/unknown/actions", { method: "POST", headers: auth, body: '{"action":"start"}' })).status).toBe(404);
    expect(f.calls).toHaveLength(6);
  });

  test("reports an active operation and prevents duplicate dispatch", async () => {
    let finish!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const operation = new Promise<void>(resolve => { finish = resolve; });
    let calls = 0;
    const f = fixture(async () => { calls++; entered(); await operation; }), auth = await f.authenticate();
    const first = f.request("/api/profiles/profile-02/actions", { method: "POST", headers: auth, body: '{"action":"start"}' });
    await started;
    try {
      const state = await (await f.request("/api/state", { headers: auth })).json();
      expect(state.profiles[1].pendingAction).toBe("start");
      const duplicate = await f.request("/api/profiles/profile-02/actions", { method: "POST", headers: auth, body: '{"action":"start"}' });
      expect(duplicate.status).toBe(409);
      const typing = await f.request("/api/profiles/profile-02/typing", { method: "PUT", headers: auth,
        body: JSON.stringify({ revision: "typing-revision-1", mode: "keyboard" }) });
      expect(typing.status).toBe(409);
      expect(f.calls).not.toContain("typing:profile-02");
      const rename = await f.request("/api/profiles/profile-02", { method: "PATCH", headers: auth,
        body: JSON.stringify({ revision: "a".repeat(64), name: "Renamed" }) });
      expect(rename.status).toBe(409);
      expect(f.calls).not.toContain("rename:profile-02");
      expect(calls).toBe(1);
    } finally { finish(); }
    expect((await first).status).toBe(200);
    const state = await (await f.request("/api/state", { headers: auth })).json();
    expect(state.profiles[1].pendingAction).toBeUndefined();
  });

  test("preserves model conflicts and hides URL credentials in action errors", async () => {
    const f = fixture(async () => { throw Error("Proxy failed: http://username:password@proxy.example:8000"); }), auth = await f.authenticate();
    const conflict = await f.request("/api/profiles/profile-02/network", { method: "PUT", headers: auth, body: JSON.stringify({ revision: "old" }) });
    expect(conflict.status).toBe(409);
    const action = await f.request("/api/profiles/profile-02/actions", { method: "POST", headers: auth, body: '{"action":"start"}' });
    expect(action.status).toBe(409);
    const text = await action.text();
    expect(text).not.toContain("username");
    expect(text).not.toContain("password");
    expect(f.calls).toEqual([]);
  });
});
