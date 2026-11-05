import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TypingForm } from "../../apps/ui/src/TypingForm.tsx";
import { UI_ACTIONS } from "../../packages/stelz/src/api/contracts.ts";
import type { UiProfile, UiNetwork, UiPhase, UiSnapshot } from "../../packages/stelz/src/api/contracts.ts";
import { actionReason, boundedLog, homeCommand, mcpCommand, networkDraft, networkUpdate, proxyDisplay, redact, shellQuote } from "../../apps/ui/src/model.ts";

const network: UiNetwork = { revision: "revision-1", mode: "direct", proxyEnv: null, expectedIPEnv: null, proxyDisplay: null, proxyConfigured: false, expectedIp: "203.0.113.1", proxyReadOnly: false, expectedIpReadOnly: false };
function profile(phase: UiPhase, changes: Partial<UiProfile> = {}): UiProfile {
  return { id: "profile-01", phase, port: 9340, mode: "direct", storage: "native", typingMode: "auto", typing: { revision: "typing-revision-1", mode: null, defaultMode: "auto" }, instanceId: null, exitIp: null, checkedAt: null, fixedIpVerified: false, windowControls: { available: false, reason: null }, controller: null, supervisorPid: null, serverPid: null, ownership: null, fingerprintSha256: null, engineSha256: null, error: null, controlError: null, configurationError: null, network, ...changes };
}
function context(row: UiProfile) {
  const snapshot: UiSnapshot = { home: "/tmp/stelz", version: "0.2.0", upstreamVersion: "1.18.1", initialized: true, setup: true, catalogRevision: "a".repeat(64), profiles: [row], updatedAt: new Date().toISOString() };
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
  test("configuration blocks start but other running profiles do not", () => {
    const row = profile("stopped", { configurationError: "Proxy is missing" });
    expect(actionReason(row, "start", context(row))).toContain("configuration");
    const clean = profile("stopped");
    const full = context(clean);
    full.snapshot.profiles.push(...["ready", "paused", "orphaned", "blocked"].map((phase, index) =>
      profile(phase as UiPhase, { id: `other-${index}` })));
    expect(actionReason(clean, "start", full)).toBeNull();
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

describe("typing preferences", () => {
  const render = (row: UiProfile, connected = true, busy = false) => renderToStaticMarkup(createElement(TypingForm, {
    profile: row, connected, busy, onSave: async () => { throw Error("Rendering must not save preferences."); },
  }));
  test("inherited defaults remain distinct from an explicit Automatic selection", () => {
    const row = profile("ready");
    expect(render(row)).toContain('value="inherit" selected=""');
    expect(render(row)).toContain('<option value="auto">Automatic</option>');
    expect(render(row)).toContain("Service default (auto)");
    const inheritedInstant = { ...row, typingMode: "instant" as const, typing: { ...row.typing, defaultMode: "instant" as const } };
    expect(render(inheritedInstant)).toContain("Service default (instant)");
    expect(render(inheritedInstant)).toContain("Enter the complete text at once.");
    expect(render({ ...inheritedInstant, typingMode: "auto", typing: { ...inheritedInstant.typing, mode: "auto" } })).toContain('value="auto" selected=""');
  });
  test("offline, local pending, and another tab's pending operation disable typing", () => {
    const row = profile("ready");
    expect(render(row)).not.toMatch(/<select[^>]*disabled/);
    for (const html of [render(row, false), render(row, true, true), render({ ...row, pendingAction: "stop" }), render({ ...row, pendingAction: "typing" })])
      expect(html).toMatch(/<select[^>]*disabled/);
    expect(render({ ...row, pendingAction: "stop" })).toContain("Wait for the current service action to finish.");
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
