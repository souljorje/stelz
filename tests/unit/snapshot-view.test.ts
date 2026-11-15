import { expect, test } from "bun:test";
import { parseAria } from "../../src/browser/aria.ts";
import { buildView, edits, filterKey, windowRows, windowView, type ViewOptions } from "../../src/browser/snapshot-view.ts";
import { annotate, google, helpers, shop, withFrame } from "../helpers/aria-fixtures.ts";

const nodes = (plain: string) => parseAria(annotate(plain).yaml);
const view = (plain: string, options: ViewOptions = {}, before?: string) => buildView(nodes(plain), before === undefined ? undefined : nodes(before), options, helpers);
const lines = (plain: string, options: ViewOptions = {}, before?: string) => view(plain, options, before).rows.map(row => row.text);
const NOTE = "# Diff from your last snapshot. + is a new or changed line, - is a removed line. Note that refs on unchanged lines may have shifted; target by role and name.";

test("a scope reads the subtree of a container that has no ref, from column 0", () => {
  expect(lines(shop({ items: 2 }), { scope: { role: "list", name: "Results" }, collapse: false })).toEqual([
    '- list "Results":',
    "  - listitem [e6]:", '    - link "Lamp 1" [e7]:', "      - /url: /p/1", "    - text: $21", '    - button "Add Lamp 1" [e8]',
    "  - listitem [e9]:", '    - link "Lamp 2" [e10]:', "      - /url: /p/2", "    - text: $22", '    - button "Add Lamp 2" [e11]',
  ]);
  // Any node can be a scope: a landmark with no name, and a leaf.
  expect(lines(shop(), { scope: { role: "contentinfo" } })).toEqual(["- contentinfo:", "  - text: © Shop"]);
  expect(lines(shop(), { scope: { role: "searchbox" } })).toEqual(['- searchbox "Search" [e5]']);
});

test("a scope matches the role and the name after the Camofox normalization", () => {
  expect(lines(shop(), { scope: { role: "Navigation", name: "  MAIN " } })[0]).toBe('- navigation "Main":');
  expect(() => view(shop(), { scope: { role: "navigation", name: "Mai" } })).toThrow("No element matches");
});

test("an ambiguous scope fails with the count, and nth picks one match", () => {
  const plain = shop({ items: 2 });
  expect(() => view(plain, { scope: { role: "list" } })).toThrow("The scope matches 2 elements");
  expect(() => view(plain, { scope: { role: "listitem" } })).toThrow("matches 4 elements");
  expect(lines(plain, { scope: { role: "list", nth: 0 } })[0]).toBe("- list:");
  expect(lines(plain, { scope: { role: "list", nth: 1 } })[0]).toBe('- list "Results":');
  expect(() => view(plain, { scope: { role: "list", nth: 2 } })).toThrow("nth must be 0 to 1");
  expect(() => view(plain, { scope: { role: "table" } })).toThrow('No element matches the scope: role "table"');
  expect(() => view(plain, { scope: { role: "list", name: "Other" } })).toThrow('and name "Other"');
});

test("contains keeps the matching lines and their ancestors, not case-sensitive", () => {
  expect(lines(shop(), { contains: "lamp 7" })).toEqual([
    "- main:", '  - list "Results":', "    - listitem [e24]:", '      - link "Lamp 7" [e25]:', '      - button "Add Lamp 7" [e26]']);
  expect(lines(shop(), { contains: "LAMP 7" })).toEqual(lines(shop(), { contains: "lamp 7" }));
  // The ref marker is not text. A line has no match for its own ref.
  expect(view(shop(), { contains: "[e5]" }).rows).toEqual([]);
  expect(view(shop(), { contains: "no such text" }).rows).toEqual([]);
  // The lines of the matches keep their refs, so the caller can act on them.
  expect(view(shop(), { contains: "lamp 7" }).rows.flatMap(row => row.ref ?? [])).toEqual(["e24", "e25", "e26"]);
});

test("contains works inside a scope, and the ancestors stop at the scope", () => {
  expect(lines(shop(), { scope: { role: "navigation" }, contains: "deals" })).toEqual([
    '- navigation "Main":', "  - list:", "    - listitem [e3]:", '      - link "Deals" [e4]:', "        - /url: /deals"]);
});

test("a diff after one element is inserted at the top shows that line with its ref and its parent, without refs elsewhere", () => {
  const built = view(shop({ top: ['  - button "Menu"'] }), { diff: true }, shop());
  expect(built.rows.map(row => row.text)).toEqual([NOTE, " - banner:", '+  - button "Menu" [e1]']);
  expect(built.rows.map(row => row.ref)).toEqual([undefined, undefined, "e1"]);
  expect(built.baseline).toBe(false);
  // A line that is not interactive has no ref to show.
  expect(lines(shop({ top: ['  - heading "Sale"'] }), { diff: true }, shop())).toEqual([NOTE, " - banner:", '+  - heading "Sale"']);
});

test("a diff shows a changed line as a removal and an addition, and a removed line without a ref", () => {
  expect(lines(shop({ change: { 5: 30 } }), { diff: true }, shop())).toEqual([NOTE, "     - listitem:", "-      - text: $25", "+      - text: $35"]);
  const removed = shop().replace('      - button "Add Lamp 3"\n', "");
  expect(lines(removed, { diff: true }, shop())).toEqual([NOTE, "     - listitem:", '-      - button "Add Lamp 3"']);
  // The removed button had a ref in the baseline. The diff does not print it.
  expect(lines(removed, { diff: true }, shop()).join("\n")).not.toMatch(/\[e\d+\]/);
  // An added line with a ref keeps its current ref.
  const renamed = shop().replace('"Add Lamp 3"', '"Buy Lamp 3"');
  expect(view(renamed, { diff: true }, shop()).rows.filter(row => row.ref).map(row => row.text)).toEqual(['+      - button "Buy Lamp 3" [e14]']);
});

test("separate hunks in one parent show the parent line once, and hunks in other parents show their own", () => {
  const changed = shop({ change: { 2: 40, 3: 50 } });
  expect(lines(changed, { diff: true }, shop())).toEqual([NOTE,
    "     - listitem:", "-      - text: $22", "+      - text: $42",
    "     - listitem:", "-      - text: $23", "+      - text: $53"]);
  const both = shop({ change: { 2: 40 }, top: ['  - heading "Sale"'] });
  expect(lines(both, { diff: true }, shop())).toEqual([NOTE, " - banner:", '+  - heading "Sale"', "     - listitem:", "-      - text: $22", "+      - text: $42"]);
  const sameParent = shop({ top: ['  - heading "Sale"', '  - heading "New"'] }).replace('  - searchbox "Search"', '  - searchbox "Find"');
  expect(lines(sameParent, { diff: true }, shop()).filter(row => row === " - banner:")).toHaveLength(1);
});

test("scope and contains apply to both pages before the diff", () => {
  const changed = shop({ change: { 5: 30 }, top: ['  - heading "Sale"'] });
  // The change at the top is outside the scope.
  expect(lines(changed, { diff: true, scope: { role: "list", name: "Results" } }, shop())).toEqual([NOTE, "   - listitem:", "-    - text: $25", "+    - text: $35"]);
  // The new price is not in the old page, so the diff is as large as the matching view. The reply is that view.
  expect(view(changed, { diff: true, contains: "$35" }, shop())).toMatchObject({ baseline: true });
  expect(lines(changed, { diff: true, contains: "$35" }, shop())).toEqual(["- main:", '  - list "Results":', "    - listitem [e18]:", "      - text: $35"]);
  expect(lines(shop(), { diff: true, contains: "Lamp 2" }, shop())).toEqual(["# No change since your last snapshot."]);
});

test("no change gives one note", () => {
  const built = view(shop(), { diff: true }, shop());
  expect(built.rows).toEqual([{ text: "# No change since your last snapshot." }]);
  expect(built.baseline).toBe(false);
});

test("without a baseline, or when the diff is not smaller than the full view, the reply is the full view with baseline", () => {
  const first = view(shop(), { diff: true });
  expect(first.baseline).toBe(true);
  expect(first.rows.length).toBeGreaterThan(20);
  expect(first.rows.some(row => row.text.startsWith("+"))).toBe(false);
  // A new page: every line changed.
  const next = view(shop({ items: 3, top: ['  - heading "Other"'] }).replaceAll("Lamp", "Chair").replaceAll("Shop", "Store"), { diff: true }, shop());
  expect(next.baseline).toBe(true);
  expect(next.rows.map(row => row.text).join("\n")).toContain('link "Chair 1"');
  expect(view('- button "A"\n- button "C"', { diff: true }, '- button "A"\n- button "B"').baseline).toBe(true);
  // A view without diff is never a baseline reply, and a diff request that gives a diff is not one either.
  expect(view(shop(), {}, shop()).baseline).toBe(false);
  expect(view(shop({ change: { 5: 30 } }), { diff: true }, shop()).baseline).toBe(false);
});

test("a scope that does not match the baseline gives the full view", () => {
  const before = shop().replace('  - list "Results":', '  - list "Old":');
  const built = view(shop(), { diff: true, scope: { role: "list", name: "Results" } }, before);
  expect(built.baseline).toBe(true);
  expect(built.rows[0]!.text).toBe('- list "Results":');
});

test("the size rule compares with the view before collapse, so a diff can show a change inside a collapsed run", () => {
  const changed = shop({ change: { 9: 30 } });
  const built = view(changed, { diff: true, scope: { role: "list", name: "Results" } }, shop());
  expect(built.baseline).toBe(false);
  expect(built.rows.map(row => row.text)).toEqual([NOTE, "   - listitem:", "-    - text: $29", "+    - text: $39"]);
});

test("collapse replaces a run of similar items with the first item and one line", () => {
  const rows = lines(shop());
  expect(rows).toContain("    - … 11 more like this");
  expect(rows).toContain('      - link "Lamp 1" [e7]:');
  expect(rows.some(row => row.includes("Lamp 2"))).toBe(false);
  // The line shows no ref range, and the collapsed items show no refs.
  expect(rows.join("\n")).not.toMatch(/more like this.*\[e\d+\]/);
  expect(view(shop()).rows.flatMap(row => row.ref ?? [])).not.toContain("e9");
  // The nav list has two items, which is not a run. A form after the run is not collapsed.
  expect(rows).toContain('        - link "Deals" [e4]:');
  expect(rows.at(-3)).toBe('    - button "Subscribe" [e43] [disabled]');
});

test("a run of two items stays, a run of three collapses, and the count is the items after the first", () => {
  expect(lines(shop({ items: 2 })).some(row => row.includes("more like this"))).toBe(false);
  expect(lines(shop({ items: 3 })).filter(row => row.includes("more like this"))).toEqual(["    - … 2 more like this"]);
  expect(lines(shop({ items: 40 })).filter(row => row.includes("more like this"))).toEqual(["    - … 39 more like this"]);
});

test("collapse false and contains keep every line, and a leaf run never collapses", () => {
  expect(lines(shop(), { collapse: false }).some(row => row.includes("more like this"))).toBe(false);
  expect(lines(shop(), { collapse: false })).toHaveLength(shop().split("\n").length);
  expect(lines(shop(), { contains: "Add Lamp" }).filter(row => row.includes("Add Lamp"))).toHaveLength(12);
  const links = Array.from({ length: 8 }, (_, i) => `- link "Page ${i}"`).join("\n");
  expect(lines(links)).toHaveLength(8);
  const texts = Array.from({ length: 8 }, (_, i) => `- listitem: item ${i}`).join("\n");
  expect(lines(texts)).toHaveLength(8);
});

test("items with different shapes do not collapse together", () => {
  const plain = ["- list:", ...[1, 2, 3].flatMap(n => [`  - listitem:`, `    - link "A${n}":`, `      - /url: /a${n}`]),
    "  - listitem:", '    - text: one', '    - text: two', "  - listitem:", '    - text: three', '    - text: four', "  - listitem:", '    - text: five', '    - text: six'].join("\n");
  const rows = lines(plain);
  expect(rows.filter(row => row.includes("more like this"))).toEqual(["  - … 2 more like this", "  - … 2 more like this"]);
  expect(rows).toContain('    - link "A1" [e2]:');
});

test("collapse works inside a scope and inside an item", () => {
  const rows = lines(shop({ items: 5 }), { scope: { role: "main" } });
  expect(rows[0]).toBe("- main:");
  expect(rows).toContain("    - … 4 more like this");
});

test("the Google results format and an iframe section shape like any page", () => {
  const nodes = parseAria(google);
  const reading = buildView(nodes, undefined, { scope: { role: "navigation", name: "pagination" } }, helpers).rows.map(row => row.text);
  expect(reading).toEqual(['- navigation "pagination":', '  - link "Next" [e8]']);
  const contains = buildView(nodes, undefined, { contains: "shop.test" }, helpers).rows.map(row => row.text);
  expect(contains).toEqual(['- link "Lamps - Shop" [e4]:', "  - /url: https://shop.test/lamps", "  - cite: shop.test"]);
  const frame = lines(withFrame, { scope: { role: "iframe", name: "payment" } });
  expect(frame).toEqual(['- iframe "payment":', '  - textbox "Card number" [e2]', '  - button "Submit card" [e3]']);
  expect(lines(withFrame, { contains: "card" })).toEqual(['- iframe "payment":', '  - textbox "Card number" [e2]', '  - button "Submit card" [e3]']);
});

const page = (count: number) => Array.from({ length: count }, (_, i) => ({ text: `- row ${String(i).padStart(3, "0")}` }));

test("a window ends at a line break, and the pages add up to the view", () => {
  const rows = page(400), all = rows.map(row => row.text).join("\n");
  const first = windowRows(rows, 0, 1000);
  expect(first.text.length).toBeLessThanOrEqual(1000);
  expect(first.truncated).toBe(true);
  expect(first.nextOffset).toBe(first.text.length + 1);
  expect(all[first.nextOffset!]).toBe("-");
  let offset = 0, joined: string[] = [], pages = 0;
  for (;;) {
    const next = windowRows(rows, offset, 1000);
    joined.push(next.text);
    expect(next.truncated).toBe(true);
    pages++;
    if (next.nextOffset === undefined) break;
    expect(next.nextOffset).toBeGreaterThan(offset);
    offset = next.nextOffset;
  }
  expect(joined.join("\n")).toBe(all);
  expect(pages).toBeGreaterThan(3);
});

test("a view that fits has one window with no nextOffset, and the first window of an empty view is empty", () => {
  expect(windowRows(page(3), 0, 1000)).toMatchObject({ text: "- row 000\n- row 001\n- row 002", truncated: false });
  expect(windowRows(page(3), 0, 1000).nextOffset).toBeUndefined();
  expect(windowRows([], 0, 1000)).toEqual({ text: "", truncated: false, rows: [] });
});

test("the rows of a window are the rows that it shows completely", () => {
  const rows = page(200);
  const second = windowRows(rows, windowRows(rows, 0, 1000).nextOffset!, 1000);
  expect(second.rows.map(row => row.text).join("\n")).toBe(second.text);
  // An offset in the middle of a line leaves that line out of the rows.
  const middle = windowRows(rows, 3, 40);
  expect(middle.text.startsWith("ow 000")).toBe(true);
  expect(middle.rows.map(row => row.text)).not.toContain("- row 000");
});

test("an offset past the end of the view fails, and a line longer than the window is cut inside the line", () => {
  expect(() => windowRows(page(3), 100, 1000)).toThrow("past the end");
  const long = [{ text: "x".repeat(2500) }];
  const first = windowRows(long, 0, 1000);
  expect(first).toMatchObject({ truncated: true, nextOffset: 1000 });
  expect(first.text).toHaveLength(1000);
  expect(windowRows(long, 2000, 1000)).toMatchObject({ truncated: true, text: "x".repeat(500) });
});

test("a window with interactive lines that have no ref gets one note, and only past the limit of Camofox", () => {
  const plain = Array.from({ length: 520 }, (_, i) => `- button "B${i}"`).join("\n");
  const { yaml, refs } = annotate(plain);
  expect(refs.size).toBe(500);
  const built = buildView(parseAria(yaml), undefined, {}, helpers);
  const whole = windowRows(built.rows, 0, 80_000);
  const text = windowView(built.rows, 0, 80_000, refs.size, helpers).text;
  expect(text.split("\n")[0]).toBe("# Interactive lines without a ref are past the 500-ref limit of this page.");
  expect(text.match(/past the 500-ref limit/g)).toHaveLength(1);
  expect(text.slice(text.indexOf("\n") + 1)).toBe(whole.text);
  // The same page without the limit reached has no note. A window before the limit has none either.
  expect(windowView(built.rows, 0, 80_000, 499, helpers).text).toBe(whole.text);
  expect(windowView(built.rows, 0, 1000, 500, helpers).text).not.toContain("# ");
  // The note counts in maxChars. A page that fits exactly without the note is cut, and the cut gives a nextOffset.
  const tight = windowView(built.rows, 0, whole.text.length, refs.size, helpers);
  expect(tight.text.length).toBeLessThanOrEqual(whole.text.length);
  expect(tight.text.startsWith("# Interactive lines")).toBe(true);
  expect(tight).toMatchObject({ truncated: true });
  expect(tight.nextOffset).toBeLessThan(whole.text.length);
  // A removed line is not a line of this page. A diff that only removes the last button has no note.
  const removed = windowView(buildView(nodes(plain.split("\n").slice(0, 519).join("\n")), parseAria(yaml), { diff: true }, helpers).rows, 0, 1000, 500, helpers);
  expect(removed.rows.every(row => !row.node)).toBe(true);
  expect(removed.text).toContain('-- button "B519"');
  expect(removed.text).not.toContain("500-ref limit");
});

test("the Myers edit script turns one list into the other, and gives up past its limit", () => {
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let round = 0; round < 200; round++) {
    const a = Array.from({ length: Math.floor(random() * 30) }, () => String(Math.floor(random() * 6)));
    const b = Array.from({ length: Math.floor(random() * 30) }, () => String(Math.floor(random() * 6)));
    const script = edits(a, b)!;
    const result = [...a];
    // Apply from the end, so earlier indexes stay valid.
    for (const edit of [...script].reverse()) if (edit.kind === "-") result.splice(edit.a, 1);
    for (const edit of script) if (edit.kind === "+") result.splice(edit.b, 0, b[edit.b]!);
    expect(result, `${a} -> ${b}`).toEqual(b);
  }
  expect(edits(["a", "b"], ["a", "b"])).toEqual([]);
  expect(edits(Array.from({ length: 50 }, (_, i) => `a${i}`), Array.from({ length: 50 }, (_, i) => `b${i}`), 20)).toBeUndefined();
});

test("two requests read the same part of the page only when scope and contains agree", () => {
  expect(filterKey({})).toBe("");
  expect(filterKey({ scope: { role: "List" } })).toBe(filterKey({ scope: { role: "list" } }));
  expect(filterKey({ contains: "Foo" })).toBe(filterKey({ contains: "foo" }));
  expect(filterKey({ scope: { role: "list" } })).not.toBe(filterKey({ scope: { role: "list", nth: 1 } }));
  expect(filterKey({ scope: { role: "list" } })).not.toBe(filterKey({}));
});
