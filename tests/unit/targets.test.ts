import { expect, test } from "bun:test";
import { parseAria } from "../../src/browser/aria.ts";
import { SelectorError } from "../../src/browser/snapshot-view.ts";
import { findCondition, resolveTarget, type Target } from "../../src/browser/targets.ts";
import { annotate, helpers, shop } from "../helpers/aria-fixtures.ts";

const resolve = (yaml: string, target: Target) => resolveTarget(parseAria(yaml), target, helpers);
const page = annotate(shop());
const refOf = (role: string, name: string) => [...page.refs].find(([, entry]) => entry.role === role && entry.name === name)![0];
const message = (yaml: string, target: Target) => {
  try { resolve(yaml, target); } catch (error) { expect(error).toBeInstanceOf(SelectorError); return (error as Error).message; }
  throw Error("The target resolved.");
};
// Two buttons with the same name, and one with a longer name.
const twins = annotate(['- button "Add"', '- button "Add to cart"', '- list:', '  - listitem:', '    - button "Add"'].join("\n"));

test("a target with an exact role and name gives the ref of that element", () => {
  expect(resolve(page.yaml, { role: "button", name: "Add Lamp 3" })).toBe(refOf("button", "Add Lamp 3"));
  expect(resolve(page.yaml, { role: "searchbox", name: "Search" })).toBe(refOf("searchbox", "Search"));
  expect(resolve(page.yaml, { role: "link", name: "Lamp 12" })).toBe(refOf("link", "Lamp 12"));
  // A role that a snapshot prints with an attribute still matches: the attribute is not part of the name.
  expect(resolve(annotate('- link "Home" [e9]\n- button "Save" [expanded]').yaml, { role: "button", name: "Save" })).toBeTruthy();
});

test("the role and the name compare after normalization, and a longer name is not a match", () => {
  const want = refOf("button", "Add Lamp 3");
  expect(resolve(page.yaml, { role: "BUTTON", name: "  add   LAMP\n3 " })).toBe(want);
  expect(resolve(page.yaml, { role: " Button ", name: "ADD LAMP 3" })).toBe(want);
  // Equality, not a substring: "Add Lamp 1" is a prefix of "Add Lamp 12".
  expect(resolve(page.yaml, { role: "button", name: "Add Lamp 1" })).toBe(refOf("button", "Add Lamp 1"));
  expect(() => resolve(page.yaml, { role: "button", name: "Add Lamp" })).toThrow("No element matches the target");
  // A role must be exact: a link is not a button.
  expect(() => resolve(page.yaml, { role: "button", name: "Lamp 3" })).toThrow("No element matches the target");
  // A name with escaped quotes matches its decoded form.
  expect(resolve(annotate('- button "Say \\"hi\\" now"').yaml, { role: "button", name: 'Say "hi" now' })).toBe("e1");
});

test("an ambiguous match needs nth, and nth counts from 0 in page order", () => {
  expect(message(twins.yaml, { role: "button", name: "Add" })).toBe('The target matches 2 elements: role "button" and name "Add". Pass nth (0 to 1).');
  expect(resolve(twins.yaml, { role: "button", name: "Add", nth: 0 })).toBe("e1");
  expect(resolve(twins.yaml, { role: "button", name: "Add", nth: 1 })).toBe("e4");
  expect(message(twins.yaml, { role: "button", name: "Add", nth: 2 })).toBe('The target matches 2 elements: role "button" and name "Add". nth must be 0 to 1.');
  // A single match accepts nth 0 and refuses nth 1.
  expect(resolve(twins.yaml, { role: "button", name: "Add to cart", nth: 0 })).toBe("e2");
  expect(message(twins.yaml, { role: "button", name: "Add to cart", nth: 1 })).toContain("matches 1 element:");
});

test("a disabled element is refused, and so is an element that has no ref", () => {
  expect(message(page.yaml, { role: "button", name: "Subscribe" })).toBe('The element is disabled: button "Subscribe". Wait until the page enables it, or choose another element.');
  // The ref limit of a page: the buttons after the limit have no ref.
  const limited = annotate(shop(), 5);
  expect(limited.refs.size).toBe(5);
  expect(message(limited.yaml, { role: "button", name: "Add Lamp 12" })).toBe(
    'The element has no ref, because it is past the 500-ref limit of this page: button "Add Lamp 12". Read it with tab_snapshot and scope or contains, or use a selector.');
  // A role that takes no input never has a ref.
  expect(message(page.yaml, { role: "heading", name: "Results" })).toBe('The element has no ref, because only elements that take input have refs: heading "Results". Use a selector.');
  // A name that Camofox skips for refs has none either, and the message does not blame the limit.
  expect(message(annotate('- textbox "Date picker"').yaml, { role: "textbox", name: "Date picker" })).toContain("only elements that take input");
});

test("no match names the elements with the same role, the closest names first, at most five", () => {
  const text = message(page.yaml, { role: "button", name: "Add lamp" });
  expect(text.startsWith('No element matches the target: role "button" and name "Add lamp". Elements with this role: ')).toBe(true);
  const listed = [...text.matchAll(/button "([^"]*)"/g)].map(match => match[1]);
  expect(listed).toHaveLength(5);
  expect(listed.every(name => name!.startsWith("Add Lamp"))).toBe(true);
  // The closest comes first, also when it is late in the page.
  expect(message(page.yaml, { role: "button", name: "subscribe now" })).toContain('Elements with this role: button "Subscribe", ');
  expect(message(page.yaml, { role: "textbox", name: "Phone" })).toBe('No element matches the target: role "textbox" and name "Phone". Elements with this role: textbox "Email".');
  expect(message(page.yaml, { role: "table", name: "Prices" })).toBe('No element matches the target: role "table" and name "Prices". The page has no element with the role "table".');
  // A long name is cut, and a quote in a name is escaped.
  const long = annotate(`- button "${"x".repeat(100)}"\n- button "Say \\"hi\\""`);
  const cut = message(long.yaml, { role: "button", name: "y" });
  expect(cut).toContain(`button ${JSON.stringify(`${"x".repeat(57)}...`)}`);
  expect(cut).toContain('button "Say \\"hi\\""');
});

test("a wait condition is met by a target or by a text, and it gives the line without its ref", () => {
  const nodes = parseAria(twins.yaml), find = (condition: Parameters<typeof findCondition>[1]) => findCondition(nodes, condition, helpers);
  expect(find({ target: { role: "button", name: "Add to cart" } })).toBe('- button "Add to cart"');
  expect(find({ target: { role: "BUTTON", name: " add " } })).toBe('- button "Add"');
  // Several matches meet a target without nth. With nth, the target needs that many matches.
  expect(find({ target: { role: "button", name: "Add" } })).toBe('- button "Add"');
  expect(find({ target: { role: "button", name: "Add", nth: 1 } })).toBe('- button "Add"');
  expect(find({ target: { role: "button", name: "Add", nth: 2 } })).toBeUndefined();
  expect(find({ target: { role: "link", name: "Add" } })).toBeUndefined();
  // Text: any line, not case-sensitive, and the ref marker is not text.
  expect(find({ contains: "ADD TO" })).toBe('- button "Add to cart"');
  expect(find({ contains: "[e1]" })).toBeUndefined();
  expect(find({ contains: "listitem" })).toBe("- listitem:");
  expect(find({ contains: "checkout" })).toBeUndefined();
  expect(findCondition(parseAria(`- text: ${"y".repeat(500)}`), { contains: "y" }, helpers)).toHaveLength(200);
});
