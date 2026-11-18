// Annotated ARIA pages for the snapshot tests. They run under Bun and Node, and they annotate like Camofox: the upstream functions give the ref markers.
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { loadAriaHelpers } from "../../src/browser/aria.ts";

const upstreamDir = dirname(createRequire(import.meta.url).resolve("@askjo/camofox-browser/package.json"));
export const helpers = await loadAriaHelpers(upstreamDir);
const lib = (file: string) => import(pathToFileURL(join(upstreamDir, "lib", file)).href) as Promise<Record<string, any>>;
const { annotateAriaSnapshotRefs } = await lib("aria-annotate.js");
const { INTERACTIVE_ROLES } = await lib("interactive-roles.js");

type RefEntry = { role: string; name: string; nth: number };
const LIMIT = 500;

/** The refs that buildRefs of Camofox assigns to a plain YAML page, and the annotated YAML. */
export function annotate(plain: string, limit = LIMIT) {
  const refs = new Map<string, RefEntry>(), seen = new Map<string, number>();
  let counter = 1;
  for (const line of plain.split("\n")) {
    if (counter > limit) break;
    const match = line.match(/^\s*-\s+(\w+)(?:\s+"([^"]*)")?/);
    if (!match || !INTERACTIVE_ROLES.includes(match[1]!.toLowerCase())) continue;
    const role = match[1]!.toLowerCase(), name = match[2] ?? "", key = `${role}:${name}`, nth = seen.get(key) ?? 0;
    seen.set(key, nth + 1);
    refs.set(`e${counter++}`, { role, name, nth });
  }
  return { yaml: annotateAriaSnapshotRefs(plain, refs) as string, refs };
}

export const product = (n: number, price = 20) => [
  "    - listitem:",
  `      - link "Lamp ${n}":`,
  `        - /url: /p/${n}`,
  `      - text: $${price + n}`,
  `      - button "Add Lamp ${n}"`,
];

/** A shop page. The results list has a container without a ref, and a run of similar items. */
export function shop({ items = 12, top = [] as string[], change = {} as Record<number, number> } = {}) {
  return [
    "- banner:",
    '  - heading "Shop" [level=1]',
    ...top,
    '  - navigation "Main":',
    "    - list:",
    "      - listitem:",
    '        - link "Home":',
    "          - /url: /",
    "      - listitem:",
    '        - link "Deals":',
    "          - /url: /deals",
    '  - searchbox "Search"',
    "- main:",
    '  - heading "Results" [level=2]',
    '  - list "Results":',
    ...Array.from({ length: items }, (_, i) => product(i + 1, change[i + 1] ?? 20)).flat(),
    "  - form:",
    '    - textbox "Email"',
    '    - button "Subscribe" [disabled]',
    "- contentinfo:",
    "  - text: © Shop",
  ].join("\n");
}

/** The Google results page of the fast path of Camofox (extractGoogleSerp). */
export const google = [
  '- heading "lamp - Google Search"',
  '- searchbox "Search" [e1]: lamp',
  "- navigation:",
  '  - link "Images" [e2]',
  '  - link "News" [e3]',
  '- link "Lamps - Shop" [e4]:',
  "  - /url: https://shop.test/lamps",
  "  - cite: shop.test",
  "  - text: Buy a lamp today",
  '- link "Lamp history" [e5]:',
  "  - /url: https://wiki.test/lamp",
  "  - text: A short history",
  // The title has escaped quotes, and the marker comes after the whole name.
  '- link "He said \\"hi\\" today" [e6]:',
  "  - /url: https://wiki.test/quote",
  "  - text: A short quote",
  '- heading "People also ask"',
  '  - button "Why is a lamp bright?" [e7]',
  '- navigation "pagination":',
  '  - link "Next" [e8]',
].join("\n");

/** A page with an iframe section, as getAriaSnapshot appends it. */
export const withFrame = [
  '- heading "Checkout" [level=1]',
  '- button "Pay"',
  '- iframe "payment":',
  '  - textbox "Card number"',
  '  - button "Submit card"',
].join("\n");
