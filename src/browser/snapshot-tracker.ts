import { parseAria, type AriaHelpers, type AriaNode } from "./aria.ts";
import { buildView, filterKey, windowView, DEFAULT_MAX_CHARS, type Page, type Row, type ViewOptions } from "./snapshot-view.ts";

// What each controller has seen of each tab: its baseline for diffs, its latest view for paging, and the refs that it can rely on.
// The browser service keeps one tracker for one browser lifetime. A person or another controller can change a page between two calls,
// so each controller starts empty, and so does a controller that resumes after a pause.

export type SnapshotRequest = ViewOptions & { maxChars?: number };
export type View = {
  url: string;
  refsCount: number;
  /** The page text of this reply, in the format of docs/mcp.md. */
  text: string;
  truncated: boolean;
  nextOffset?: number;
  viewId: string;
  /** True when the caller asked for a diff and got the full view. */
  baseline?: true;
};

type CachedView = { id: string; url: string; refsCount: number; rows: Row[]; identities: Map<string, string> };
type TabRecord = {
  /** The last full page that this controller received, and the part of the page that its view covered. */
  baseline?: { nodes: AriaNode[]; filter: string };
  view?: CachedView;
  /** The refs that this controller can rely on, with the identity that each one had when the controller last saw it. */
  trusted: Map<string, string>;
};

const shiftedRef = (ref: string) => Error(`ref ${ref} may have shifted. Read tab_snapshot again, or target the element by role and name.`);

export function createSnapshotTracker(helpers: AriaHelpers) {
  const controllers = new Map<string, Map<string, TabRecord>>();
  let counter = 0;
  const find = (controllerId: string, tabId: string) => controllers.get(controllerId)?.get(tabId);
  function record(controllerId: string, tabId: string) {
    let tabs = controllers.get(controllerId);
    if (!tabs) controllers.set(controllerId, tabs = new Map());
    let found = tabs.get(tabId);
    if (!found) tabs.set(tabId, found = { trusted: new Map() });
    return found;
  }
  const finish = (page: Page, { id, url, refsCount }: CachedView, baseline?: boolean): View => ({ url, refsCount,
    text: page.text, truncated: page.truncated, ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }),
    viewId: id, ...(baseline ? { baseline: true as const } : {}) });

  return {
    /**
     * Shape one fresh snapshot for a controller. `yaml` is the full annotated page and `refs` maps each ref of the tab to its identity key.
     * A scope that matches nothing, or more than one node, throws before any state changes.
     */
    read(controllerId: string, tabId: string, input: { yaml: string; url: string; refsCount: number; refs: ReadonlyMap<string, string>; request: SnapshotRequest }): View {
      const { yaml, url, refsCount, refs, request } = input;
      const nodes = parseAria(yaml), found = record(controllerId, tabId), filter = filterKey(request);
      // A diff compares against what the controller saw. A baseline read through a narrower scope or contains does not cover another read.
      const covered = found.baseline && (found.baseline.filter === "" || found.baseline.filter === filter);
      const built = buildView(nodes, covered ? found.baseline!.nodes : undefined, request, helpers);
      const page = windowView(built.rows, 0, request.maxChars ?? DEFAULT_MAX_CHARS, refsCount, helpers);
      const id = `v${++counter}`;
      found.baseline = { nodes, filter };
      // A ref is reliable if this reply showed it, or if it still has the identity that the controller saw. Any other ref is removed.
      const shown = new Set(page.rows.flatMap(row => row.ref ? [row.ref] : []));
      const trusted = new Map<string, string>();
      for (const [ref, key] of refs) if (shown.has(ref) || found.trusted.get(ref) === key) trusted.set(ref, key);
      found.trusted = trusted;
      found.view = { id, url, refsCount, rows: built.rows, identities: new Map(built.rows.flatMap(row => row.ref && refs.has(row.ref) ? [[row.ref, refs.get(row.ref)!] as const] : [])) };
      return finish(page, found.view, built.baseline);
    },

    /** Read another window of the cached view of this controller. It takes no new snapshot. The baseline does not change. */
    page(controllerId: string, tabId: string, viewId: string, offset: number, maxChars: number | undefined, refs: ReadonlyMap<string, string>): View {
      const found = find(controllerId, tabId), view = found?.view;
      if (!found || !view || view.id !== viewId) throw Error("The viewId is unknown or replaced. Read a new tab_snapshot.");
      const page = windowView(view.rows, offset, maxChars ?? DEFAULT_MAX_CHARS, view.refsCount, helpers);
      // A ref on this window was reliable when the view was made. It is reliable now only if it still names the same element.
      for (const row of page.rows) {
        if (!row.ref) continue;
        const was = view.identities.get(row.ref), now = refs.get(row.ref);
        if (was !== undefined && was === now) found.trusted.set(row.ref, now);
        else found.trusted.delete(row.ref);
      }
      return finish(page, view);
    },

    /** Refuse a ref that this controller cannot rely on, or that now names another element. `refs` is undefined when the tab is gone. */
    check(controllerId: string, tabId: string, ref: string, refs: ReadonlyMap<string, string> | undefined) {
      const key = find(controllerId, tabId)?.trusted.get(ref);
      if (key === undefined || refs?.get(ref) !== key) throw shiftedRef(ref);
    },

    dropTab(controllerId: string, tabId: string) { controllers.get(controllerId)?.delete(tabId); },
    release(controllerId: string) { controllers.delete(controllerId); },
    reset() { controllers.clear(); },
  };
}
