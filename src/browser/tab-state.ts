// Stelz reads the tab state of Camofox in process: `sessions` → session → `tabGroups` → tab → `refs` and `lastSnapshot`.
// This is an internal structure, not a documented interface. Check its shape on every read and fail closed.
// See docs/development/camofox-integration.md#internal-tab-state.

export const TAB_STATE_CHANGED = "Stelz cannot read the page state of Camofox, because its internal tab state has changed. Update Stelz.";

/** The identity of one ref: the locator that resolves it. Two refs with the same key resolve to the same element. */
export function identityKey(entry: unknown): string {
  const { role, name, nth, frameName, frameUrl } = (entry ?? {}) as Record<string, unknown>;
  const text = (value: unknown) => value === undefined || value === null || typeof value === "string";
  if (typeof role !== "string" || typeof name !== "string" || !Number.isInteger(nth) || !text(frameName) || !text(frameUrl)) throw Error(TAB_STATE_CHANGED);
  return JSON.stringify([role, name, nth, frameName ?? null, frameUrl ?? null]);
}

export type TabRead = {
  /** The identity key of each ref. */
  refs: Map<string, string>;
  /** The full annotated snapshot of the last snapshot route. It is not a string when no snapshot is current. */
  lastSnapshot: unknown;
};

/** Read one tab. It returns undefined when the session or the tab does not exist. It throws when the structure is not what Stelz expects. */
export function readTab(sessions: unknown, userId: string, tabId: string): TabRead | undefined {
  if (!(sessions instanceof Map)) throw Error(TAB_STATE_CHANGED);
  const session = sessions.get(userId) as { tabGroups?: unknown } | undefined;
  if (session === undefined) return undefined;
  if (!session || typeof session !== "object" || !(session.tabGroups instanceof Map)) throw Error(TAB_STATE_CHANGED);
  for (const group of session.tabGroups.values()) {
    if (!(group instanceof Map)) throw Error(TAB_STATE_CHANGED);
    const tab = group.get(tabId) as { refs?: unknown; lastSnapshot?: unknown } | undefined;
    if (tab === undefined) continue;
    if (!tab || typeof tab !== "object" || !(tab.refs instanceof Map)) throw Error(TAB_STATE_CHANGED);
    const refs = new Map<string, string>();
    for (const [ref, entry] of tab.refs) {
      if (typeof ref !== "string") throw Error(TAB_STATE_CHANGED);
      refs.set(ref, identityKey(entry));
    }
    return { refs, lastSnapshot: tab.lastSnapshot };
  }
  return undefined;
}
