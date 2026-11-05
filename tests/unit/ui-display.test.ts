import { describe, expect, test } from "bun:test";
import { UI_ACTIONS } from "../../packages/stelz/src/api/contracts.ts";
import type { UiProfile, UiNetwork, UiPhase, UiSnapshot } from "../../packages/stelz/src/api/contracts.ts";
import { actionReason, boundedLog, capacityUsed, homeCommand, mcpCommand, networkDraft, networkUpdate, proxyDisplay, redact, shellQuote } from "../../apps/ui/src/model.ts";

const network: UiNetwork = { revision: "revision-1", mode: "direct", proxyEnv: null, expectedIPEnv: null, proxyDisplay: null, proxyConfigured: false, expectedIp: "203.0.113.1", proxyReadOnly: false, expectedIpReadOnly: false };
function profile(phase: UiPhase, changes: Partial<UiProfile> = {}): UiProfile {
  return { id: "profile-01", phase, port: 9340, mode: "direct", storage: "native", instanceId: null, exitIp: null, checkedAt: null, fixedIpVerified: false, windowControls: { available: false, reason: null }, controller: null, supervisorPid: null, serverPid: null, ownership: null, fingerprintSha256: null, engineSha256: null, error: null, controlError: null, configurationError: null, network, ...changes };
}
function context(row: UiProfile) {
  const snapshot: UiSnapshot = { home: "/tmp/stelz", version: "0.2.0", upstreamVersion: "1.18.1", initialized: true, setup: true, maxActive: 2, catalogRevision: "a".repeat(64), profiles: [row], updatedAt: new Date().toISOString() };
  return { snapshot, connected: true, pending: false };
}

describe("lifecycle guards", () => {
  test("ready is independent of controller ownership", () => {
    const row = profile("ready");
    expect(actionReason(row, "pause", context(row))).toBeNull();
    expect(actionReason(row, "release", context(row))).toContain("No controller");
    const held = { ...row, controller: { label: "MCP client", pid: 41, activeActions: 0, releasing: false } };
    expect(actionReason(held, "release", context(held))).toBeNull();
    expect(actionReason(held, "resume", context(held))).not.toBeNull();
  });
  test("transitions and uncertain process ownership disable every mutation", () => {
    for (const phase of ["starting", "stopping", "ownership_unknown", "unclean"] as const) {
      const row = profile(phase, { controller: { label: "MCP client", pid: 42, activeActions: 0, releasing: false } });
      for (const action of UI_ACTIONS) expect(actionReason(row, action, context(row))).not.toBeNull();
    }
  });
  test("configuration and capacity block start", () => {
    const row = profile("stopped", { configurationError: "Proxy is missing" });
    expect(actionReason(row, "start", context(row))).toContain("configuration");
    const clean = profile("stopped");
    const full = context(clean);
    full.snapshot.profiles.push(profile("ready"), profile("paused"));
    expect(capacityUsed(full.snapshot.profiles)).toBe(2);
    expect(actionReason(clean, "start", full)).toContain("slots");
  });
  test("disconnected and pending states disable every mutation", () => {
    const row = profile("ready");
    for (const action of UI_ACTIONS) {
      expect(actionReason(row, action, { ...context(row), connected: false })).not.toBeNull();
      expect(actionReason(row, action, { ...context(row), pending: true })).not.toBeNull();
    }
  });
  test("recheck does not grant resume to verification_failed", () => {
    const row = profile("verification_failed");
    expect(actionReason(row, "recheck", context(row))).toBeNull();
    expect(actionReason(row, "resume", context(row))).not.toBeNull();
  });
  test("direct connections need no IP check unless an expected IP is configured", () => {
    const row = profile("ready", { network: { ...network, expectedIp: "" } });
    expect(actionReason(row, "recheck", context(row))).toContain("not enabled");
    expect(actionReason(row, "pause", context(row))).toBeNull();
  });
});

describe("network updates", () => {
  test("blank proxy preserves credentials, and an explicit blank IP clears the requirement", () => {
    const baseline = networkDraft(network);
    expect(networkUpdate({ ...baseline, mode: "proxy", expectedIp: "" }, baseline, network)).toEqual({ revision: "revision-1", mode: "proxy", expectedIp: "" });
  });
  test("a newer observation cannot advance a dirty draft's revision", () => {
    const baseline = networkDraft(network);
    const update = networkUpdate({ ...baseline, proxyUrl: "http://user:secret@proxy.example:80", mode: "proxy" }, baseline, { ...network, revision: "revision-2" });
    expect(update.revision).toBe("revision-1");
    expect(update.proxyUrl).toBe("http://user:secret@proxy.example:80");
  });
  test("read-only references never receive override values", () => {
    const baseline = networkDraft(network);
    expect(networkUpdate({ ...baseline, mode: "proxy", proxyUrl: "http://new:secret@proxy.example", expectedIp: "" }, baseline, { ...network, proxyReadOnly: true, expectedIpReadOnly: true })).toEqual({ revision: "revision-1", mode: "proxy" });
  });
});

describe("display boundaries", () => {
  test("proxy display exposes only the scheme and host", () => {
    expect(proxyDisplay("http://user:password@proxy.example:8080/private?token=secret#secret")).toBe("http://proxy.example:8080");
    expect(proxyDisplay("user:password@unparseable")).toBe("Configured proxy");
  });
  test("logs redact URL credentials, bearer headers, and named secrets", () => {
    const result = redact("Proxy http://user:password@proxy.example\nAuthorization: Bearer private-token\nACCESS_KEY=private-key\napiToken=another-private-key");
    for (const secret of ["user:password", "private-token", "private-key", "another-private-key"]) expect(result).not.toContain(secret);
    expect(boundedLog(Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n")).split("\n")).toHaveLength(300);
    expect(boundedLog("a".repeat(60_000)).length).toBeLessThanOrEqual(48_000);
  });
  test("commands quote both the service home and the profile", () => {
    const home = "/tmp/operator's browser home";
    expect(homeCommand("doctor", home)).toBe("STELZ_HOME='/tmp/operator'\"'\"'s browser home' stelz doctor");
    expect(mcpCommand("profile-01", home)).toBe(`${homeCommand("mcp", home)} --profile 'profile-01'`);
    expect(shellQuote("$(touch /tmp/never-executed) 'value'")).toBe("'$(touch /tmp/never-executed) '\"'\"'value'\"'\"''");
  });
});
