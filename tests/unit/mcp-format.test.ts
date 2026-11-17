import { expect, test } from "bun:test";
import { formatResult } from "../../src/mcp/mcp.ts";
import { parseToolText } from "../helpers/mcp-client.ts";
import { createSnapshotTracker } from "../../src/browser/snapshot-tracker.ts";
import { identityKey } from "../../src/browser/tab-state.ts";
import { annotate, helpers, shop } from "../helpers/aria-fixtures.ts";

const yaml = '- heading "Title" [e1]\n  - link "Next \\"page\\"" [e2]:\n    - /url: https://example.test/next\n- button "Save" [e3]';
const snapshot = { url: "https://example.test/", snapshot: yaml, refsCount: 3, truncated: false, viewId: "v7", screenshot: { data: "aW1hZ2U=", mimeType: "image/png" } };
const header = (payload: object) => JSON.parse((formatResult({ kind: "snapshot", payload: { ...snapshot, ...payload } })[0] as { text: string }).text.split("\n")[0]!);

test("a snapshot is one header line and the page text as it is, then an image block", () => {
  const content = formatResult({ kind: "snapshot", payload: snapshot });
  expect(content).toEqual([{ type: "text", text: `{"url":"https://example.test/","refsCount":3,"truncated":false,"viewId":"v7"}\n${yaml}` },
    { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]);
  const text = (content[0] as { text: string }).text;
  // The page text is not JSON-escaped. Quotes and line breaks stay as they are.
  expect(text.split("\n")).toHaveLength(yaml.split("\n").length + 1);
  expect(text).toContain('link "Next \\"page\\""');
  for (const dropped of ["structure", "totalChars", "hasMore", "screenshot", "snapshot"]) expect(text.split("\n")[0]).not.toContain(dropped);
  expect(parseToolText(text)).toMatchObject({ url: "https://example.test/", refsCount: 3, truncated: false, viewId: "v7", snapshot: yaml });
});

test("the snapshot header carries nextOffset only when more text remains", () => {
  expect(header({ truncated: true, nextOffset: 4000 })).toEqual({ url: "https://example.test/", refsCount: 3, truncated: true, nextOffset: 4000, viewId: "v7" });
  expect(header({ nextOffset: 0 })).toHaveProperty("nextOffset", 0);
  expect(header({ nextOffset: null })).not.toHaveProperty("nextOffset");
  expect(header({})).not.toHaveProperty("nextOffset");
});

test("the snapshot header carries baseline only when it is true, after viewId", () => {
  expect(Object.keys(header({ baseline: true, nextOffset: 10 }))).toEqual(["url", "refsCount", "truncated", "nextOffset", "viewId", "baseline"]);
  expect(header({ baseline: true })).toHaveProperty("baseline", true);
  for (const baseline of [false, undefined, "yes", 1]) expect(header({ baseline })).not.toHaveProperty("baseline");
});

test("the structure of the page follows the page text as compact JSON, and only when the payload has it", () => {
  const structure = { forms: [{ id: "form-0", fields: [] }], tables: [{ id: "table-0", rows: 3 }] };
  const [text] = formatResult({ kind: "snapshot", payload: { ...snapshot, structure } }) as Array<{ text: string }>;
  expect(text!.text).toBe(`{"url":"https://example.test/","refsCount":3,"truncated":false,"viewId":"v7"}\n${yaml}\n# structure\n${JSON.stringify(structure)}`);
  expect(text!.text.split("\n").at(-1)).not.toContain(" ");
  for (const none of [undefined, null]) expect((formatResult({ kind: "snapshot", payload: { ...snapshot, structure: none } })[0] as { text: string }).text).not.toContain("# structure");
});

test("a snapshot without a screenshot has no image block, and an empty page keeps its header", () => {
  const { screenshot: _screenshot, ...bare } = snapshot;
  expect(formatResult({ kind: "snapshot", payload: bare })).toHaveLength(1);
  expect(formatResult({ kind: "snapshot", payload: { ...bare, snapshot: "" } })).toEqual([{ type: "text", text: '{"url":"https://example.test/","refsCount":3,"truncated":false,"viewId":"v7"}\n' }]);
  expect(formatResult({ kind: "snapshot", payload: { ...snapshot, screenshot: { data: "aW1h" } } })[1]).toEqual({ type: "image", data: "aW1h", mimeType: "image/png" });
  expect(formatResult({ kind: "snapshot", payload: { ...snapshot, screenshot: {} } })).toHaveLength(1);
});

test("JSON results are compact and one block, with no structured content", () => {
  const payload = { tabs: [{ tabId: "a", url: "https://example.test/" }], nested: { ok: true, list: [1, 2] } };
  const content = formatResult({ kind: "json", payload });
  expect(content).toEqual([{ type: "text", text: JSON.stringify(payload) }]);
  expect((content[0] as { text: string }).text).not.toContain("\n");
  expect(formatResult({ kind: "json", payload: [] })).toEqual([{ type: "text", text: "[]" }]);
  // A malformed snapshot payload falls back to compact JSON instead of failing.
  expect(formatResult({ kind: "snapshot", payload: { error: "none" } })).toEqual([{ type: "text", text: '{"error":"none"}' }]);
  expect(formatResult({ kind: "snapshot", payload: null })).toEqual([{ type: "text", text: "null" }]);
});

const diff = '# Diff from your last snapshot. + is a new or changed line, - is a removed line. Note that refs on unchanged lines may have shifted; target by role and name.\n-      - text: $25\n+      - text: $35';
const observed = { url: "https://example.test/", refsCount: 3, truncated: false, viewId: "v8", snapshot: diff };

test("an action with an observation is its compact result, then the snapshot header, then the page text", () => {
  const content = formatResult({ kind: "json", payload: { ok: true, url: "https://example.test/" }, observation: { kind: "snapshot", payload: observed } });
  expect(content).toEqual([{ type: "text", text: `{"ok":true,"url":"https://example.test/"}\n{"url":"https://example.test/","refsCount":3,"truncated":false,"viewId":"v8"}\n${diff}` }]);
  const lines = (content[0] as { text: string }).text.split("\n");
  expect(lines).toHaveLength(2 + diff.split("\n").length);
  expect(JSON.parse(lines[0]!)).toEqual({ ok: true, url: "https://example.test/" });
  expect(JSON.parse(lines[1]!)).toEqual({ url: "https://example.test/", refsCount: 3, truncated: false, viewId: "v8" });
  // The page text is not JSON-escaped, as in a snapshot reply.
  expect(lines.slice(2).join("\n")).toBe(diff);
  // A full view says so in the header, and the header has the same fields as tab_snapshot.
  const full = formatResult({ kind: "json", payload: { ok: true }, observation: { kind: "snapshot", payload: { ...observed, baseline: true, truncated: true, nextOffset: 90 } } });
  expect(JSON.parse((full[0] as { text: string }).text.split("\n")[1]!)).toEqual({ url: "https://example.test/", refsCount: 3, truncated: true, nextOffset: 90, viewId: "v8", baseline: true });
  // The first line is the whole action result, also when the action returned a list.
  expect((formatResult({ kind: "json", payload: [1], observation: { kind: "snapshot", payload: observed } })[0] as { text: string }).text.split("\n")[0]).toBe("[1]");
});

test("a failed read after a successful action is a note under the action result, and not an error", () => {
  const note = "The action completed. Read tab_snapshot to see the page.";
  const content = formatResult({ kind: "json", payload: { ok: true }, observation: { error: note } });
  expect(content).toEqual([{ type: "text", text: `{"ok":true}\n# ${note}` }]);
  // The reader of the first line gets the action result, as when there is no observation.
  expect(parseToolText((content[0] as { text: string }).text)).toMatchObject({ ok: true });
});

test("a result without an observation keeps its format, and images stay image blocks", () => {
  expect(formatResult({ kind: "json", payload: { ok: true }, observation: undefined })).toEqual([{ type: "text", text: '{"ok":true}' }]);
  // Images stay image blocks, and an image is never followed by an observation.
  const image = { type: "image" as const, data: "aW1h", mimeType: "image/png" };
  expect(formatResult({ kind: "image", payload: image })).toEqual([image]);
  expect(formatResult({ kind: "image", payload: image, observation: { error: "x" } })).toEqual([image]);
});

test("the text of a click with observe diff after a one-element change is at most 2 KB, whatever the size of the page", () => {
  for (const items of [12, 80, 300]) {
    const tracker = createSnapshotTracker(helpers);
    const read = (change: Record<number, number>, request: object) => {
      const page = annotate(shop({ items, change }));
      const refs = new Map([...page.refs].map(([ref, entry]) => [ref, identityKey(entry)]));
      return tracker.read("a", "tab", { yaml: page.yaml, url: "https://shop.test/", refsCount: page.refs.size, refs, request });
    };
    read({}, {});
    const sizes = [26, 27, 28].map(price => {
      const view = read({ 5: price }, { diff: true });
      expect(view.baseline).toBeUndefined();
      const { text, ...header } = view;
      const [content] = formatResult({ kind: "json", payload: { ok: true }, observation: { kind: "snapshot", payload: { ...header, snapshot: text } } }) as Array<{ text: string }>;
      // The fixture adds the number of the item to the price.
      expect(content!.text).toContain(`+      - text: $${price + 5}`);
      return Buffer.byteLength(content!.text);
    });
    expect(Math.max(...sizes), `${items} items`).toBeLessThanOrEqual(2048);
  }
});
