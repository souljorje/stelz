import type { UiAction, UiIdentity, UiNetwork, UiNetworkUpdate, UiPhase, UiSnapshot } from "../src/ui-types";

export const phaseLabels: Record<UiPhase, string> = {
  starting: "Starting", ready: "Ready", paused: "Paused", verification_failed: "IP check failed",
  blocked: "Blocked", stopping: "Stopping", stopped: "Stopped", orphaned: "Orphaned",
  ownership_unknown: "Ownership unknown", unclean: "Unclean exit",
};

export const actionLabels: Record<UiAction, string> = {
  start: "Start", stop: "Stop", pause: "Pause", resume: "Resume", release: "Release", recheck: "Recheck IP",
};

export function redact(value: string): string {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\b([a-z][a-z\d+.-]{0,24}:\/\/)[^\s/<>]*@/gi, "$1[redacted]@")
    .replace(/((?:[?&]|\b)(?:[\w-]*(?:password|passwd|secret|token|access[_-]?key|api[_-]?key|proxy[_-]?url)[\w-]*)\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s&,;]+)/gi, "$1[redacted]")
    .replace(/\b(?:authorization|proxy-authorization)\s*:\s*[^\r\n]+/gi, "Authorization: [redacted]")
    .replace(/\bBearer\s+[\w.+/=-]+/gi, "Bearer [redacted]");
}

export function proxyDisplay(value: string | null): string {
  if (!value) return "Not configured";
  try {
    const url = new URL(value);
    return url.host ? `${url.protocol}//${url.host}` : "Configured proxy";
  } catch {
    return "Configured proxy";
  }
}

export function boundedLog(value: string): string {
  return redact(value).split("\n").slice(-300).join("\n").slice(-48_000);
}

export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`;
export const homeCommand = (command: string, home: string): string => `STELZ_HOME=${shellQuote(home)} stelz ${command}`;
export const identityCommand = (command: string, id: string, home: string): string => `${homeCommand(command, home)} ${shellQuote(id)}`;
export const mcpCommand = (id: string, home: string): string => `${homeCommand("mcp", home)} --identity ${shellQuote(id)}`;
export const capacityUsed = (identities: UiIdentity[]) => identities.filter(({ phase }) => phase !== "stopped" && phase !== "unclean").length;

export function identityAttention(identity: UiIdentity): string | null {
  if (identity.configurationError) return redact(identity.configurationError);
  if (identity.error) return redact(identity.error);
  if (identity.controlError) return redact(identity.controlError);
  switch (identity.phase) {
    case "paused": return "Paused for manual work. Resume only after authentication is complete in the same browser.";
    case "verification_failed": return "Correct the network, then recheck the IP. Resume explicitly if the browser remains paused.";
    case "blocked": return "Browser actions are blocked. Inspect the logs, then stop and start this identity explicitly.";
    case "orphaned": return "The supervisor exited. Inspect ownership with doctor, then stop the remaining service.";
    case "ownership_unknown": return "Process ownership is unknown. Run doctor and inspect the processes before further action.";
    case "unclean": return "Inspect the recorded processes with doctor. Run recover only after those processes exit.";
    default: return null;
  }
}

export function phaseExplanation(identity: UiIdentity): string {
  switch (identity.phase) {
    case "stopped": return "The browser is closed. Start it explicitly before connecting an MCP controller.";
    case "starting": return "The service is starting the browser and checking its network. Wait for the next state update.";
    case "ready": return identity.controller ? "The browser is ready. The named controller has exclusive access." : "The browser is ready for an MCP controller to acquire.";
    case "stopping": return "The service is stopping this browser. Wait for a clean stop before starting it again.";
    default: return identityAttention(identity) ?? "Inspect this identity before continuing.";
  }
}

export type ActionContext = { snapshot: UiSnapshot; connected: boolean; pending: boolean };

export function deleteReason(identity: UiIdentity, context: ActionContext): string | null {
  if (!context.connected) return "Refresh the connection before making changes.";
  if (context.pending || identity.pendingAction) return "Wait for the current service action to finish.";
  return identity.phase === "stopped" ? null : "Stop this identity cleanly before deleting it.";
}

export function actionReason(identity: UiIdentity, action: UiAction, context: ActionContext): string | null {
  if (!context.connected) return "Refresh the connection before making changes.";
  if (context.pending || identity.pendingAction) return "Wait for the current service action to finish.";
  if (identity.phase === "starting" || identity.phase === "stopping") return `Wait until the browser finishes ${identity.phase}.`;
  if (identity.phase === "ownership_unknown") return "Run doctor and inspect process ownership first.";
  if (identity.phase === "unclean") return "Run doctor, then recover after the recorded processes exit.";
  switch (action) {
    case "start":
      if (identity.phase !== "stopped") return "Stop this identity before starting it.";
      if (!context.snapshot.initialized) return "Run stelz init first.";
      if (!context.snapshot.setup) return "Run stelz setup first.";
      if (identity.configurationError) return "Correct the configuration before starting.";
      if (capacityUsed(context.snapshot.identities) >= context.snapshot.maxActive) return "All browser slots are occupied.";
      return null;
    case "pause": return identity.phase === "ready" ? null : "Pause is available when the browser is ready.";
    case "resume": return identity.phase === "paused" ? null : "Resume is available when the browser is paused.";
    case "recheck":
      if (identity.mode === "direct" && !identity.network.expectedIp) return "IP verification is not enabled for this identity.";
      return ["ready", "paused", "verification_failed"].includes(identity.phase) ? null : "Start the browser before checking its IP.";
    case "release":
      if (!identity.controller) return "No controller holds this identity.";
      return identity.controller.releasing ? "The controller is already releasing." : null;
    case "stop": return ["ready", "paused", "verification_failed", "blocked", "orphaned"].includes(identity.phase) ? null : "There is no running browser to stop.";
  }
}

export type NetworkDraft = { revision: string; mode: "direct" | "proxy"; proxyUrl: string; expectedIp: string };
export const networkDraft = (network: UiNetwork): NetworkDraft => ({
  revision: network.revision, mode: network.mode, proxyUrl: "", expectedIp: network.expectedIp,
});
export const networkDirty = (draft: NetworkDraft, baseline: NetworkDraft) => draft.mode !== baseline.mode || draft.proxyUrl !== "" || draft.expectedIp !== baseline.expectedIp;

export function networkUpdate(draft: NetworkDraft, baseline: NetworkDraft, network: UiNetwork): UiNetworkUpdate {
  return {
    revision: draft.revision,
    mode: draft.mode,
    ...(draft.mode === "proxy" && !network.proxyReadOnly && draft.proxyUrl.trim() ? { proxyUrl: draft.proxyUrl.trim() } : {}),
    ...(!network.expectedIpReadOnly && draft.expectedIp !== baseline.expectedIp ? { expectedIp: draft.expectedIp.trim() } : {}),
  };
}

export function dateTime(value: string | null): string {
  if (!value) return "Not checked";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Unknown time" : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
