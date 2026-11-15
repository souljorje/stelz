import { expect, test } from "bun:test";
import { formatResult } from "../../src/mcp/mcp.ts";
import { parseToolText } from "../helpers/mcp-client.ts";

const yaml = '- heading "Title" [e1]\n  - link "Next \\"page\\"" [e2]:\n    - /url: https://example.test/next\n- button "Save" [e3]';
const snapshot = { url: "https://example.test/", snapshot: yaml, structure: { forms: [] }, refsCount: 3, truncated: false, totalChars: 99, hasMore: false,
  nextOffset: null, screenshot: { data: "aW1hZ2U=", mimeType: "image/png" } };

test("a snapshot is one header line and the page text as it is, then an image block", () => {
  const content = formatResult({ kind: "snapshot", payload: snapshot });
  expect(content).toEqual([{ type: "text", text: `{"url":"https://example.test/","refsCount":3,"truncated":false}\n${yaml}` },
    { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]);
  const text = (content[0] as { text: string }).text;
  // The page text is not JSON-escaped. Quotes and line breaks stay as they are.
  expect(text.split("\n")).toHaveLength(yaml.split("\n").length + 1);
  expect(text).toContain('link "Next \\"page\\""');
  for (const dropped of ["structure", "totalChars", "hasMore", "screenshot"]) expect(text.split("\n")[0]).not.toContain(dropped);
  expect(parseToolText(text)).toMatchObject({ url: "https://example.test/", refsCount: 3, truncated: false, snapshot: yaml });
});

test("the snapshot header carries nextOffset only when more text remains", () => {
  const header = (payload: object) => JSON.parse((formatResult({ kind: "snapshot", payload: { ...snapshot, ...payload } })[0] as { text: string }).text.split("\n")[0]!);
  expect(header({ truncated: true, hasMore: true, nextOffset: 4000 })).toEqual({ url: "https://example.test/", refsCount: 3, truncated: true, nextOffset: 4000 });
  expect(header({ nextOffset: 0 })).toHaveProperty("nextOffset", 0);
  expect(header({ nextOffset: null })).not.toHaveProperty("nextOffset");
});

test("a snapshot without a screenshot has no image block, and an empty page keeps its header", () => {
  const { screenshot: _screenshot, ...bare } = snapshot;
  expect(formatResult({ kind: "snapshot", payload: bare })).toHaveLength(1);
  expect(formatResult({ kind: "snapshot", payload: { ...bare, snapshot: "" } })).toEqual([{ type: "text", text: '{"url":"https://example.test/","refsCount":3,"truncated":false}\n' }]);
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
