import type { UiAction, UiProfile, UiNetwork, UiNetworkUpdate, UiPhase, UiSnapshot } from "../../src/api/contracts.ts";

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
export const profileCommand = (command: string, id: string, home: string): string => `${homeCommand(command, home)} ${shellQuote(id)}`;
export const mcpCommand = (_id: string, home: string): string => homeCommand("mcp", home);

export function profileAttention(profile: UiProfile): string | null {
  if (profile.configurationError) return redact(profile.configurationError);
  if (profile.location?.status === "blocked") return profile.location.message;
  if (profile.error) return redact(profile.error);
  if (profile.controlError) return redact(profile.controlError);
  switch (profile.phase) {
    case "paused": return "Paused for manual work. Resume only after authentication is complete in the same browser.";
    case "verification_failed": return "Correct the network, then recheck the IP. Resume explicitly if the browser remains paused.";
    case "blocked": return "Browser actions are blocked. Inspect the logs, then stop and start this profile explicitly.";
    case "orphaned": return "The supervisor exited. Inspect ownership with doctor, then stop the remaining service.";
    case "ownership_unknown": return "Process ownership is unknown. Run doctor and inspect the processes before further action.";
    case "unclean": return "Inspect the recorded processes with doctor. Run recover only after those processes exit.";
    default: return null;
  }
}

export type ActionContext = { snapshot: UiSnapshot; connected: boolean; pending: boolean };

export function deleteReason(profile: UiProfile, context: ActionContext): string | null {
  if (!context.connected) return "Refresh the connection before making changes.";
  if (context.pending || profile.pendingAction) return "Wait for the current service action to finish.";
  return profile.phase === "stopped" ? null : "Stop this profile cleanly before deleting it.";
}

export function actionReason(profile: UiProfile, action: UiAction, context: ActionContext): string | null {
  if (!context.connected) return "Refresh the connection before making changes.";
  if (context.pending || profile.pendingAction) return "Wait for the current service action to finish.";
  if (profile.phase === "starting" || profile.phase === "stopping") return `Wait until the browser finishes ${profile.phase}.`;
  if (profile.phase === "ownership_unknown") return "Run doctor and inspect process ownership first.";
  if (profile.phase === "unclean") return "Run doctor, then recover after the recorded processes exit.";
  switch (action) {
    case "start":
      if (profile.phase !== "stopped") return "Stop this profile before starting it.";
      if (!context.snapshot.initialized || !context.snapshot.setup) return "Run stelz setup first.";
      if (profile.configurationError) return "Correct the configuration before starting.";
      if (profile.location?.status === "blocked") return profile.location.message;
      if (profile.location?.status === "checking") return "Wait for the location check to finish.";
      return null;
    case "pause": return profile.phase === "ready" ? null : "Pause is available when the browser is ready.";
    case "resume": return profile.phase === "paused" ? null : "Resume is available when the browser is paused.";
    case "recheck":
      if (profile.phase === "stopped" && hasProxy(profile.network)) return profile.location?.status === "checking" ? "Wait for the location check to finish." : null;
      if (!hasProxy(profile.network) && !profile.network.expectedIp) return "IP verification is not enabled for this profile.";
      return ["ready", "paused", "verification_failed"].includes(profile.phase) ? null : "Start the browser before checking its IP.";
    case "release":
      if (!profile.controller) return "No controller holds this profile.";
      return profile.controller.releasing ? "The controller is already releasing." : null;
    case "stop": return ["ready", "paused", "verification_failed", "blocked", "orphaned"].includes(profile.phase) ? null : "There is no running browser to stop.";
  }
}

export const hasProxy = (network: UiNetwork) => !!(network.proxyEnv || network.proxyDisplay);
export function locationLabel(profile: UiProfile) {
  const location = profile.location;
  if (!location) return hasProxy(profile.network) ? "Not checked" : "Not applicable";
  // The browser check confirms applied settings. The evidence rows describe how credible the location is.
  if (location.phase === "browser_verification" && location.status === "ready") return "Settings applied in browser";
  return { not_applicable: "Not applicable", not_checked: "Not checked", checking: "Checking", ready: "Ready to start", blocked: "Start blocked" }[location.status];
}
export function locationEvidenceRows(location: UiProfile["location"]) {
  const evidence = location?.evidence;
  if (!evidence) return [];
  const { comparison } = evidence;
  const detail = [comparison.timezone, comparison.accuracyRadiusKm === undefined ? undefined : `${comparison.accuracyRadiusKm} km`].filter(Boolean).join(", ");
  const verdict = { corroborated: "Agrees", uncorroborated: "Too broad to confirm", conflicting: "Disagrees" }[comparison.result];
  return [
    { label: "Location source", value: `${evidence.source}, built ${evidence.builtAt.slice(0, 10)}${evidence.stale ? " (more than 30 days old)" : ""}` },
    { label: comparison.source, value: detail ? `${verdict} (${detail})` : verdict },
  ];
}

export type NetworkDraft = { revision: string; proxyUrl: string; expectedIp: string };
export const networkDraft = (network: UiNetwork): NetworkDraft => ({
  revision: network.revision, proxyUrl: network.proxyDisplay ?? "", expectedIp: network.expectedIp,
});
export const networkDirty = (draft: NetworkDraft, baseline: NetworkDraft) => draft.proxyUrl.trim() !== baseline.proxyUrl || draft.expectedIp.trim() !== baseline.expectedIp;

export function networkUpdate(draft: NetworkDraft, baseline: NetworkDraft, network: UiNetwork): UiNetworkUpdate {
  return {
    revision: draft.revision,
    ...((!network.proxyReadOnly || !draft.proxyUrl.trim()) && draft.proxyUrl.trim() !== baseline.proxyUrl ? { proxyUrl: draft.proxyUrl.trim() ? draft.proxyUrl : null } : {}),
    ...(!network.expectedIpReadOnly && draft.expectedIp.trim() !== baseline.expectedIp ? { expectedIp: draft.expectedIp.trim() } : {}),
  };
}

export function dateTime(value: string | null): string {
  if (!value) return "Not checked";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Unknown time" : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
