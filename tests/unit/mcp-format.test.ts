import { expect, test } from "bun:test";
import { formatResult } from "../../src/mcp/mcp.ts";
import { parseToolText } from "../helpers/mcp-client.ts";

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

test("images stay image blocks", () => {
  const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
  expect(formatResult({ kind: "image", payload: image })).toEqual([image]);
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
