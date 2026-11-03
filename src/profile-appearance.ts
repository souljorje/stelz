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
