export const UI_ACTIONS = ["start", "stop", "pause", "resume", "release", "recheck"] as const;
export type UiAction = (typeof UI_ACTIONS)[number];
export type UiPhase = "starting" | "ready" | "paused" | "verification_failed" | "blocked" | "stopping" | "stopped" | "orphaned" | "ownership_unknown" | "unclean";

export type UiNetwork = {
  revision: string;
  mode: "direct" | "proxy";
  proxyEnv: string | null;
  expectedIPEnv: string | null;
  proxyDisplay: string | null;
  proxyConfigured: boolean;
  expectedIp: string;
  proxyReadOnly: boolean;
  expectedIpReadOnly: boolean;
};

export type UiProfile = {
  id: string;
  port: number;
  mode: "direct" | "proxy";
  storage: "native" | "checkpoint";
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
  pendingAction?: UiAction | "save" | "delete" | "show";
};

export type UiSnapshot = {
  home: string;
  version: string;
  upstreamVersion: string;
  initialized: boolean;
  setup: boolean;
  maxActive: number;
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

export type { NetworkUpdate as UiNetworkUpdate, ProfileCreate as UiProfileCreate } from "./profile-configuration-types.ts";
import type { NetworkUpdate as UiNetworkUpdate, ProfileCreate as UiProfileCreate } from "./profile-configuration-types.ts";

export type UiModel = {
  snapshot(): Promise<UiSnapshot>;
  detail(id: string): Promise<UiProfileDetail>;
  diagnostics(): Promise<UiDiagnostics>;
  updateNetwork(id: string, update: UiNetworkUpdate): Promise<UiProfile>;
  createProfile(input: UiProfileCreate): Promise<UiProfile>;
  deleteProfile(id: string, revision: string): Promise<void>;
};
