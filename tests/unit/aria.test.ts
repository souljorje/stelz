import { expect, test } from "bun:test";
import { parseAria } from "../../src/browser/aria.ts";
import { annotate, google, helpers, shop, withFrame } from "../helpers/aria-fixtures.ts";

const pick = (yaml: string, role: string, name?: string) => parseAria(yaml).find(node => node.role === role && (name === undefined || node.name === name))!;

test("a line has its role, name, attributes, ref, and a text without the ref marker", () => {
  const { yaml } = annotate(shop());
  const button = pick(yaml, "button", "Subscribe");
  expect(button).toMatchObject({ role: "button", name: "Subscribe", ref: "e43", attributes: ["disabled"], text: '    - button "Subscribe" [disabled]' });
  expect(button.raw).toBe('    - button "Subscribe" [e43] [disabled]');
  expect(pick(yaml, "heading", "Shop")).toMatchObject({ attributes: ["level=1"] });
  expect(pick(yaml, "heading", "Shop").ref).toBeUndefined();
  // A line with children ends with a colon. The marker sits before it.
  expect(parseAria(yaml)[4]).toMatchObject({ role: "listitem", ref: "e1", text: "      - listitem:" });
});

test("parent and subtree follow the indentation", () => {
  const nodes = parseAria(annotate(shop()).yaml);
  const list = nodes.find(node => node.role === "list" && node.name === "Results")!;
  expect(list).toMatchObject({ indent: 2 });
  expect(nodes.find(node => node.role === "main")!.index).toBe(list.parent);
  expect(nodes[list.parent]!.role).toBe("main");
  expect(nodes.slice(list.index + 1, list.end).every(node => node.indent > list.indent)).toBe(true);
  // A container has no ref, and it still has a subtree.
  expect(list.ref).toBeUndefined();
  expect(list.end - list.index).toBeGreaterThan(40);
  expect(nodes.filter(node => node.parent === -1).map(node => node.role)).toEqual(["banner", "main", "contentinfo"]);
  expect(nodes.at(-1)!.end).toBe(nodes.length);
});

test("text lines, properties, and inline values are lines of their own", () => {
  const nodes = parseAria(annotate(shop()).yaml);
  expect(nodes.find(node => node.text.includes("/url: /p/1"))).toMatchObject({ role: "/url" });
  expect(nodes.find(node => node.text.includes("© Shop"))).toMatchObject({ role: "text", name: "" });
  expect(parseAria('- textbox "Name": John Smith')[0]).toMatchObject({ role: "textbox", name: "Name" });
});

test("a name keeps its escaped quotes, and a ref marker inside a cut name is removed from the text", () => {
  const plain = '- button "Say \\"hi\\""\n- link "A: B"';
  const { yaml, refs } = annotate(plain);
  // Camofox cuts the name at the first quote and puts the marker there.
  expect(yaml.split("\n")[0]).toBe('- button "Say \\" [e1]hi\\""');
  expect(refs.get("e1")).toEqual({ role: "button", name: "Say \\", nth: 0 });
  const [button] = parseAria(yaml);
  expect(button).toMatchObject({ role: "button", name: 'Say "hi"', ref: "e1", text: plain.split("\n")[0] });
});

test("a key that Playwright quotes as a whole still parses, and has no ref", () => {
  const nodes = parseAria(`- 'button "Total: 5" [disabled]'\n- 'link "It''s"':\n  - /url: /x`);
  expect(nodes[0]).toMatchObject({ role: "button", name: "Total: 5", attributes: ["disabled"] });
  expect(nodes[0]!.ref).toBeUndefined();
  expect(nodes[1]).toMatchObject({ role: "link", name: "It's", end: 3 });
});

test("the Google results format parses with refs on its links, buttons, and the search box", () => {
  const nodes = parseAria(google);
  expect(nodes.filter(node => node.ref).map(node => [node.ref, node.role, node.name])).toEqual([
    ["e1", "searchbox", "Search"], ["e2", "link", "Images"], ["e3", "link", "News"], ["e4", "link", "Lamps - Shop"],
    ["e5", "link", "Lamp history"], ["e6", "link", 'He said "hi" today'], ["e7", "button", "Why is a lamp bright?"], ["e8", "link", "Next"]]);
  const result = nodes.find(node => node.ref === "e4")!;
  expect(result.end - result.index).toBe(4);
  expect(nodes[result.index + 1]).toMatchObject({ role: "/url", text: "  - /url: https://shop.test/lamps" });
  expect(nodes.find(node => node.role === "navigation" && node.name === "pagination")!.end).toBe(nodes.length);
});

test("a Google result with escaped quotes in its title keeps its ref, and its text has no marker", () => {
  const quoted = parseAria(google).find(node => node.ref === "e6")!;
  expect(quoted).toMatchObject({ role: "link", name: 'He said "hi" today', ref: "e6", text: '- link "He said \\"hi\\" today":', raw: '- link "He said \\"hi\\" today" [e6]:' });
  expect(quoted.end - quoted.index).toBe(3);
  // A marker after a whole escaped name, with an inline value, parses too.
  expect(parseAria('- link "A \\"b\\" c" [e2]: x').map(node => [node.ref, node.name])).toEqual([["e2", 'A "b" c']]);
  // A line with escaped quotes and no marker has no ref.
  expect(parseAria('- link "A \\"b\\" c"')[0]!.ref).toBeUndefined();
});

test("an iframe section is a node with the frame label, and its elements keep their refs", () => {
  const { yaml, refs } = annotate(withFrame);
  expect(refs.size).toBe(3);
  const nodes = parseAria(yaml);
  const frame = nodes.find(node => node.role === "iframe")!;
  expect(frame).toMatchObject({ name: "payment", parent: -1 });
  expect(nodes.slice(frame.index + 1, frame.end).map(node => [nodes[node.parent]!.role, node.role, node.ref])).toEqual([["iframe", "textbox", "e2"], ["iframe", "button", "e3"]]);
});

test("blank lines are dropped and an empty page has no nodes", () => {
  expect(parseAria("")).toEqual([]);
  expect(parseAria('- button "A"\n\n- button "B"\n')).toHaveLength(2);
});

test("interactive tells which nodes Camofox gives a ref", () => {
  const nodes = parseAria('- button "Save"\n- heading "Title"\n- textbox "Date picker"\n- link');
  expect(nodes.map(node => helpers.interactive(node))).toEqual([true, false, false, true]);
  expect(helpers.normalize("  Add   TO\ncart ")).toBe("add to cart");
});
