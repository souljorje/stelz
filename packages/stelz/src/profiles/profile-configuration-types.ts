import type { TypingMode } from "../browser/typing.ts";

export type NetworkUpdate = {
  revision: string;
  proxyUrl?: string | null;
  expectedIp?: string;
};

export type ProfileCreate = {
  revision: string;
  id: string;
  proxyUrl?: string;
  expectedIp?: string;
};
export type TypingUpdate = { revision: string; mode: TypingMode | null };
export type ProfileRename = { revision: string; name: string };
