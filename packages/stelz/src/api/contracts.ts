import type { TypingMode } from "../browser/typing.ts";
export type { TypingMode } from "../browser/typing.ts";

export const UI_ACTIONS = ["start", "stop", "pause", "resume", "release", "recheck"] as const;
export type UiAction = (typeof UI_ACTIONS)[number];
export type UiPhase = "starting" | "ready" | "paused" | "verification_failed" | "blocked" | "stopping" | "stopped" | "orphaned" | "ownership_unknown" | "unclean";

export type UiNetwork = {
  revision: string;
  proxyEnv: string | null;
  expectedIPEnv: string | null;
  proxyDisplay: string | null;
  proxyConfigured: boolean;
  expectedIp: string;
  proxyReadOnly: boolean;
  expectedIpReadOnly: boolean;
};

export type UiTyping = {
  revision: string;
  mode: TypingMode | null;
  defaultMode: TypingMode;
};

export type UiProfile = {
  id: string;
  name: string;
  port: number;
  storage: "native" | "checkpoint";
  typingMode: TypingMode;
  typing: UiTyping;
  phase: UiPhase;
  instanceId: string | null;
  exitIp: string | null;
  checkedAt: string | null;
  fixedIpVerified: boolean;
  windowControls: { available: boolean; reason: string | null };
  controller: { label: string; pid: number; activeActions: number; releasing: boolean } | null;
  supervisorPid: number | null;
  serverPid: number | null;
  ownership: { supervisor: string; server: string } | null;
  fingerprintSha256: string | null;
  engineSha256: string | null;
  error: string | null;
  controlError: string | null;
  configurationError: string | null;
  network: UiNetwork;
  pendingAction?: UiAction | "save" | "typing" | "rename" | "delete" | "show";
};

export type UiSnapshot = {
  home: string;
  version: string;
  upstreamVersion: string;
  initialized: boolean;
  setup: boolean;
  catalogRevision: string;
  profiles: UiProfile[];
  updatedAt: string;
};

export type UiProfileDetail = {
  profile: UiProfile;
  directory: string;
  device: { version: number | null; properties: { name: string; value: string }[] };
  logs: { server: string; supervisor: string };
  mcpCommand: string;
};

export type UiDiagnostics = {
  home: string;
  initialized: boolean;
  setup: boolean;
  node: boolean;
  browserExecutable: boolean;
  profiles: {
    id: string;
    phase: UiPhase;
    configuration: string;
    accessKeyPresent: boolean;
    supervisorPid: number | null;
    serverPid: number | null;
    ownership: { supervisor: string; server: string } | null;
  }[];
};

export type { NetworkUpdate as UiNetworkUpdate, ProfileCreate as UiProfileCreate } from "../profiles/profile-configuration-types.ts";
export type { TypingUpdate as UiTypingUpdate } from "../profiles/profile-configuration-types.ts";
export type { ProfileRename as UiProfileRename } from "../profiles/profile-configuration-types.ts";
import type { TypingUpdate } from "../profiles/profile-configuration-types.ts";
import type { ProfileRename as UiProfileRename } from "../profiles/profile-configuration-types.ts";
import type { NetworkUpdate as UiNetworkUpdate, ProfileCreate as UiProfileCreate } from "../profiles/profile-configuration-types.ts";

export type UiModel = {
  snapshot(): Promise<UiSnapshot>;
  detail(id: string): Promise<UiProfileDetail>;
  diagnostics(): Promise<UiDiagnostics>;
  updateNetwork(id: string, update: UiNetworkUpdate): Promise<UiProfile>;
  updateTyping(id: string, update: TypingUpdate): Promise<UiProfile>;
  renameProfile(id: string, update: UiProfileRename): Promise<UiProfile>;
  createProfile(input: UiProfileCreate): Promise<UiProfile>;
  deleteProfile(id: string, revision: string): Promise<void>;
};

// Shared by the browser extension and the local UI. Profile colors are not status colors.
const colors = ["#495cc9", "#8550b5", "#257d8d", "#a65d2b", "#a34978", "#596d36"];

export function profileAppearance(id: string) {
  let hash = 2166136261;
  for (const character of id) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  const suffix = /(?:^|-)(\d+)$/.exec(id)?.[1];
  const badge = suffix ? suffix.slice(-3) : id.split("-").map(part => part[0]).join("").slice(0, 3).toUpperCase();
  return { color: colors[hash % colors.length]!, badge, titlePrefix: "[" + id + "] " };
}

export type ProfileWindow = {
  id: number; title: string; focused: boolean; state: string;
  tabs: { id: number; title: string; url: string; active: boolean }[];
};
export type ProfileWindows = {
  profileId: string; instanceId: string | null; available: boolean; reason: string | null;
  updatedAt: string | null; windows: ProfileWindow[];
};
export type ShowProfileWindow = { instanceId: string; windowId?: number; tabId?: number };
