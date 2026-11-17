import { expect, test } from "bun:test";
import { createSnapshotTracker, type SnapshotRequest } from "../../src/browser/snapshot-tracker.ts";
import { identityKey } from "../../src/browser/tab-state.ts";
import { parseAria } from "../../src/browser/aria.ts";
import { annotate, google, helpers, shop } from "../helpers/aria-fixtures.ts";

const tab = "79bed5c4-d5b8-4369-9d13-b159451ece91", url = "https://shop.test/";
const REFUSED = (ref: string) => `ref ${ref} may have shifted. Read tab_snapshot again, or target the element by role and name.`;

// One tab. `page` is what Camofox holds after a snapshot: the annotated page and the refs of the tab.
function session() {
  const tracker = createSnapshotTracker(helpers);
  let refs = new Map<string, string>();
  return {
    tracker,
    /** What the tab holds now. */
    get refs() { return refs; },
    load(plain: string) {
      const page = annotate(plain);
      refs = new Map([...page.refs].map(([ref, entry]) => [ref, identityKey(entry)]));
      return { yaml: page.yaml, refsCount: page.refs.size };
    },
    read(controller: string, plain: string, request: SnapshotRequest = {}) {
      const { yaml, refsCount } = this.load(plain);
      return tracker.read(controller, tab, { yaml, url, refsCount, refs, request });
    },
    allowed(controller: string, ref: string) { try { tracker.check(controller, tab, ref, refs); return true; } catch (error) { expect((error as Error).message).toBe(REFUSED(ref)); return false; } },
  };
}
const full = { collapse: false };
const lamp1 = ['    - listitem:', '      - link "Lamp 1":', "        - /url: /p/1", "      - text: $21", '      - button "Add Lamp 1"', ""].join("\n");

test("a ref that the last reply showed is accepted, and a ref that it did not show is refused", () => {
  const s = session();
  s.read("a", shop(), { collapse: true });
  // The first item shows. The collapsed items, and the refs of the form after them, were not all shown.
  expect(s.allowed("a", "e7")).toBe(true);
  expect(s.allowed("a", "e5")).toBe(true);
  expect(s.allowed("a", "e9")).toBe(false);
  expect(s.allowed("a", "e43")).toBe(true);
});

test("a ref that the controller never saw is refused, also when its number does not exist", () => {
  const s = session();
  expect(s.allowed("a", "e1")).toBe(false);
  s.read("a", shop(), { contains: "lamp 7" });
  expect(s.allowed("a", "e25")).toBe(true);
  expect(s.allowed("a", "e1")).toBe(false);
  expect(s.allowed("a", "e999")).toBe(false);
  expect(s.allowed("a", "banana")).toBe(false);
});

test("a ref whose element moved is refused, and a ref on a new line is accepted", () => {
  const s = session();
  s.read("a", shop(), full);
  expect(s.allowed("a", "e5")).toBe(true);
  // A button at the top moves every ref after it by one. The diff shows only the new line.
  const reply = s.read("a", shop({ top: ['  - button "Menu"'] }), { ...full, diff: true });
  expect(reply.text).toContain('+  - button "Menu" [e1]');
  expect(s.allowed("a", "e1")).toBe(true);
  // e5 was the search box. Now e5 is a link, and nothing showed it. e6 was a listitem and is the search box.
  expect(s.allowed("a", "e5")).toBe(false);
  expect(s.allowed("a", "e6")).toBe(false);
  expect(s.allowed("a", "e44")).toBe(false);
});

test("an unchanged ref stays reliable when a reply does not show its line", () => {
  const s = session();
  s.read("a", shop(), full);
  // A new link after the last ref changes no ref before it.
  const reply = s.read("a", shop().replace("- contentinfo:", '- contentinfo:\n  - link "Terms"'), { ...full, diff: true });
  expect(reply.text).toContain('+  - link "Terms" [e44]');
  expect(s.allowed("a", "e44")).toBe(true);
  for (const ref of ["e1", "e5", "e25", "e42"]) expect(s.allowed("a", ref), ref).toBe(true);
  // A scope that shows only the form leaves the other refs reliable.
  s.read("a", shop(), { scope: { role: "form" } });
  expect(s.allowed("a", "e5")).toBe(true);
  expect(s.allowed("a", "e42")).toBe(true);
});

test("an action that rebuilt the refs makes a shifted ref unsafe before the next snapshot", () => {
  const s = session();
  s.read("a", shop(), full);
  expect(s.allowed("a", "e10")).toBe(true);
  // A click removed Lamp 1. Camofox rebuilds the refs of the tab, and the controller has read nothing since.
  s.load(shop().replace(lamp1, ""));
  expect(s.allowed("a", "e10")).toBe(false);
  expect(s.allowed("a", "e5")).toBe(true);
  expect(s.allowed("a", "e2")).toBe(true);
});
test("a ref of a tab that is gone is refused", () => {
  const s = session();
  s.read("a", shop(), full);
  expect(() => s.tracker.check("a", tab, "e5", undefined)).toThrow(REFUSED("e5"));
});

test("a controller starts with no reliable refs and no baseline, and release, reset, and a closed tab clear them", () => {
  const s = session();
  s.read("a", shop(), full);
  expect(s.allowed("b", "e5")).toBe(false);
  // The first read of controller b is a baseline reply, although a has read the page.
  expect(s.read("b", shop(), { ...full, diff: true }).baseline).toBe(true);
  expect(s.allowed("b", "e5")).toBe(true);
  expect(s.allowed("a", "e5")).toBe(true);
  expect(s.read("b", shop(), { ...full, diff: true }).text).toBe("# No change since your last snapshot.");
  s.tracker.release("b");
  expect(s.allowed("b", "e5")).toBe(false);
  expect(s.read("b", shop(), { ...full, diff: true }).baseline).toBe(true);
  s.tracker.dropTab("a", tab);
  expect(s.allowed("a", "e5")).toBe(false);
  expect(s.read("a", shop(), { ...full, diff: true }).baseline).toBe(true);
  s.tracker.reset();
  expect(s.allowed("a", "e5")).toBe(false);
  expect(s.allowed("b", "e5")).toBe(false);
  expect(s.read("a", shop(), { ...full, diff: true }).baseline).toBe(true);
});

test("a diff compares with the last full page that the controller received, and each snapshot moves the baseline", () => {
  const s = session();
  expect(s.read("a", shop(), { ...full, diff: true }).baseline).toBe(true);
  const second = s.read("a", shop({ change: { 5: 30 } }), { ...full, diff: true });
  expect(second.baseline).toBeUndefined();
  expect(second.text).toContain("+      - text: $35");
  // The third reply compares with the second page, not the first.
  const third = s.read("a", shop({ change: { 5: 30 } }), { ...full, diff: true });
  expect(third.text).toBe("# No change since your last snapshot.");
  // A reply without diff also moves the baseline.
  s.read("a", shop({ change: { 6: 30 } }), full);
  expect(s.read("a", shop({ change: { 6: 30 } }), { ...full, diff: true }).text).toBe("# No change since your last snapshot.");
});

test("a baseline read through a narrower scope or contains does not cover a wider read", () => {
  const s = session();
  s.read("a", shop(), { scope: { role: "form" } });
  // The controller never saw the results. A diff of the whole page cannot call them unchanged.
  expect(s.read("a", shop(), { ...full, diff: true }).baseline).toBe(true);
  // A whole page covers any scope. The same scope covers itself.
  expect(s.read("a", shop({ change: { 5: 30 } }), { diff: true, scope: { role: "list", name: "Results" } }).baseline).toBeUndefined();
  s.read("a", shop(), { contains: "lamp 3" });
  expect(s.read("a", shop(), { contains: "lamp 3", diff: true }).text).toBe("# No change since your last snapshot.");
  expect(s.read("a", shop(), { contains: "lamp 4", diff: true }).baseline).toBe(true);
});

test("a scope that fails leaves the baseline and the reliable refs as they were", () => {
  const s = session();
  s.read("a", shop(), full);
  expect(() => s.read("a", shop({ change: { 5: 30 } }), { scope: { role: "table" } })).toThrow("No element matches");
  expect(s.allowed("a", "e5")).toBe(true);
  expect(s.read("a", shop(), { ...full, diff: true }).text).toBe("# No change since your last snapshot.");
});

test("each reply has a viewId, and a window pages the cached view without a new snapshot", () => {
  const s = session();
  const first = s.read("a", shop({ items: 60 }), { ...full, maxChars: 1000 });
  expect(first.viewId).toMatch(/^v\d+$/);
  expect(first.truncated).toBe(true);
  expect(first.nextOffset).toBeGreaterThan(900);
  const second = s.tracker.page("a", tab, first.viewId, first.nextOffset!, 1000, s.refs);
  expect(second.viewId).toBe(first.viewId);
  expect(second.truncated).toBe(true);
  expect(second.url).toBe(url);
  expect(second.refsCount).toBe(first.refsCount);
});

test("an unknown or replaced viewId fails, and a controller cannot page the view of another", () => {
  const s = session();
  const first = s.read("a", shop({ items: 60 }), { ...full, maxChars: 1000 });
  expect(() => s.tracker.page("a", tab, "v999", first.nextOffset!, 1000, s.refs)).toThrow("Read a new tab_snapshot.");
  expect(() => s.tracker.page("b", tab, first.viewId, first.nextOffset!, 1000, s.refs)).toThrow("Read a new tab_snapshot.");
  expect(() => s.tracker.page("a", "another-tab", first.viewId, first.nextOffset!, 1000, s.refs)).toThrow("Read a new tab_snapshot.");
  const replaced = s.read("a", shop({ items: 60 }), { ...full, maxChars: 1000 });
  expect(replaced.viewId).not.toBe(first.viewId);
  expect(() => s.tracker.page("a", tab, first.viewId, first.nextOffset!, 1000, s.refs)).toThrow("The viewId is unknown or replaced. Read a new tab_snapshot.");
  expect(s.tracker.page("a", tab, replaced.viewId, replaced.nextOffset!, 1000, s.refs).viewId).toBe(replaced.viewId);
  s.tracker.reset();
  expect(() => s.tracker.page("a", tab, replaced.viewId, replaced.nextOffset!, 1000, s.refs)).toThrow("Read a new tab_snapshot.");
  expect(() => s.tracker.page("a", tab, replaced.viewId, 10 ** 9, 1000, s.refs)).toThrow("Read a new tab_snapshot.");
});

test("paging does not move the baseline, and it shows refs only on the lines that it shows", () => {
  const s = session();
  const first = s.read("a", shop({ items: 60 }), { ...full, maxChars: 1000 });
  // The refs of the second window were not shown, so they are not reliable until that window is read.
  const late = Number(/\[e(\d+)\]/.exec(s.tracker.page("a", tab, first.viewId, first.nextOffset!, 1000, new Map()).text)![1]);
  expect(s.allowed("a", `e${late}`)).toBe(false);
  const second = s.tracker.page("a", tab, first.viewId, first.nextOffset!, 1000, s.refs);
  expect(second.text).toContain(`[e${late}]`);
  expect(s.allowed("a", `e${late}`)).toBe(true);
  // The baseline is still the page of the last snapshot.
  expect(s.read("a", shop({ items: 60 }), { ...full, diff: true }).text).toBe("# No change since your last snapshot.");
});

test("a ref on a window is not reliable if its element moved after the view", () => {
  const s = session();
  const first = s.read("a", shop({ items: 60 }), { ...full, maxChars: 1000 });
  // Every ref names another element now.
  const moved = new Map([...s.refs].map(([ref]) => [ref, identityKey({ role: "link", name: "Other", nth: 0 })]));
  const second = s.tracker.page("a", tab, first.viewId, first.nextOffset!, 1000, moved);
  const shown = [...second.text.matchAll(/\[(e\d+)\]/g)].map(match => match[1]!);
  expect(shown.length).toBeGreaterThan(3);
  for (const ref of shown) expect(s.allowed("a", ref), ref).toBe(false);
  // The refs of the first window were reliable, and the second window does not change them.
  expect(s.allowed("a", "e7")).toBe(true);
});

test("a diff after a one-element change on a large page is at most 2 KB", () => {
  const s = session();
  const big = shop({ items: 120 });
  const fullReply = s.read("a", big, { ...full, maxChars: 80_000 });
  expect(Buffer.byteLength(fullReply.text)).toBeGreaterThan(12_000);
  for (const [change, expected] of [
    [shop({ items: 120, change: { 40: 99 } }), "+      - text: $139"],
    [shop({ items: 120, top: ['  - button "Menu"'] }), '+  - button "Menu" [e1]'],
    [shop({ items: 120 }).replace('"Add Lamp 7"', '"Buy Lamp 7"'), '+      - button "Buy Lamp 7"'],
  ] as const) {
    s.read("a", big, { ...full, maxChars: 80_000 });
    const diff = s.read("a", change, { ...full, diff: true });
    expect(diff.baseline).toBeUndefined();
    expect(diff.text).toContain(expected);
    expect(Buffer.byteLength(diff.text), expected).toBeLessThanOrEqual(2048);
  }
  // The default collapse gives a small full view, and the diff is still the smaller reply.
  s.read("a", big);
  const collapsed = s.read("a", shop({ items: 120, change: { 40: 99 } }), { diff: true });
  expect(collapsed.text).toContain("+      - text: $139");
  expect(Buffer.byteLength(collapsed.text)).toBeLessThanOrEqual(2048);
});

test("a ref past the 500-ref limit of a page is refused", () => {
  const s = session();
  s.read("a", Array.from({ length: 520 }, (_, i) => `- button "B${i}"`).join("\n"), { ...full, maxChars: 80_000 });
  expect(s.allowed("a", "e500")).toBe(true);
  expect(s.allowed("a", "e501")).toBe(false);
});

test("a Google result with escaped quotes in its title has a reliable ref, and a shift does not show it as changed", () => {
  const tracker = createSnapshotTracker(helpers);
  // Camofox gives the refs of the results page the name of the line, with its backslashes.
  const refsOf = (yaml: string) => new Map(parseAria(yaml).flatMap(node => node.ref ? [[node.ref, identityKey({ role: node.role, name: node.name.replaceAll('"', '\\"'), nth: 0 })] as const] : []));
  const read = (yaml: string, request: SnapshotRequest = {}) =>
    tracker.read("a", tab, { yaml, url, refsCount: refsOf(yaml).size, refs: refsOf(yaml), request });
  read(google, { collapse: false });
  expect(() => tracker.check("a", tab, "e6", refsOf(google))).not.toThrow();
  // A link before the results moves every ref after it. The quoted title changes only its number.
  const shifted = google.replace("- navigation:", '- link "Ads" [e2]\n- navigation:').split("\n").map(line => line.replace(/\[e(\d+)\]/, (marker, n) => Number(n) >= 2 && !line.includes('"Ads"') ? `[e${Number(n) + 1}]` : marker)).join("\n");
  const reply = read(shifted, { diff: true, collapse: false });
  expect(reply.baseline).toBeUndefined();
  expect(reply.text.split("\n").filter(line => /^[+-]/.test(line))).toEqual(['+- link "Ads" [e2]']);
  // The shifted title is not shown, and its ref now names another element.
  expect(() => tracker.check("a", tab, "e6", refsOf(shifted))).toThrow("ref e6 may have shifted");
  expect(() => tracker.check("a", tab, "e7", refsOf(shifted))).toThrow("ref e7 may have shifted");
});
