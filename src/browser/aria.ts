import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Parser for the annotated ARIA YAML of Camofox: Playwright's ariaSnapshot() text, with a ref marker [eN] after the name of each
// element that has a ref. It also reads the iframe sections that Camofox appends and the Google results format, which share one grammar.

export type AriaNode = {
  /** Position in document order. */
  index: number;
  /** The line as Camofox printed it, with its ref marker. */
  raw: string;
  /** The same line without the ref marker. Two snapshots compare by this text. */
  text: string;
  indent: number;
  /** Index of the parent node, or -1 at the top level. */
  parent: number;
  /** Index after the last descendant. A node has children when `end > index + 1`. */
  end: number;
  /** The lowercase role, such as button or text. Empty for a line that is not a list item. */
  role: string;
  /** The accessible name, without quotes. */
  name: string;
  /** The ref, such as e12. */
  ref?: string;
  /** The bracket groups after the name, such as disabled or level=2. The ref marker is not one of them. */
  attributes: string[];
};

// Camofox puts ` [eN]` right after the role and the name. Two writers do it differently when a name has an escaped quote.
// The Google results code puts the marker after the whole name. The annotator of the other pages cuts the name at the first quote.
const markers = [/^(\s*-\s+)(\w+)(\s+"(?:[^"\\]|\\.)*")?(\s\[(e\d+)\])/, /^(\s*-\s+)(\w+)(\s+"[^"]*")?(\s\[(e\d+)\])/];
const item = /^(\s*)-\s+(.*)$/;

/** Split `role "name" [attribute]: value` into its key and its value. A key may be single-quoted as a whole. */
function splitKey(rest: string): { key: string; value?: string } {
  if (rest.startsWith("'")) {
    let key = "", i = 1;
    for (; i < rest.length; i++) {
      if (rest[i] !== "'") key += rest[i];
      else if (rest[i + 1] === "'") { key += "'"; i++; }
      else break;
    }
    const after = rest.slice(i + 1);
    return { key, ...(after.startsWith(":") ? { value: after.slice(1).trim() } : {}) };
  }
  let quoted = false;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (quoted) { if (c === "\\") i++; else if (c === '"') quoted = false; }
    else if (c === '"') quoted = true;
    else if (c === ":" && (i + 1 === rest.length || rest[i + 1] === " ")) return { key: rest.slice(0, i), value: rest.slice(i + 1).trim() };
  }
  return { key: rest };
}

function unquote(literal: string) {
  try { return JSON.parse(`"${literal}"`) as string; } catch { return literal; }
}

/** Parse annotated ARIA YAML into nodes in document order. Blank lines are dropped. */
export function parseAria(yaml: string): AriaNode[] {
  const nodes: AriaNode[] = [];
  const open: number[] = [];
  for (const raw of yaml.split("\n")) {
    if (!raw.trim()) continue;
    const marked = markers[0]!.exec(raw) ?? markers[1]!.exec(raw);
    const text = marked ? marked[1]! + marked[2]! + (marked[3] ?? "") + raw.slice(marked[0].length) : raw;
    const indent = text.length - text.trimStart().length;
    let role = "", name = "";
    const attributes: string[] = [];
    const found = item.exec(text);
    if (found) {
      const key = splitKey(found[2]!).key;
      role = (/^[^\s"[]+/.exec(key)?.[0] ?? "").toLowerCase();
      const after = key.slice(role.length);
      const quoted = /^\s+"((?:[^"\\]|\\.)*)"/.exec(after);
      if (quoted) name = unquote(quoted[1]!);
      for (const group of after.slice(quoted?.[0].length ?? 0).matchAll(/\[([^\]]*)\]/g)) attributes.push(group[1]!);
    }
    while (open.length && nodes[open.at(-1)!]!.indent >= indent) nodes[open.pop()!]!.end = nodes.length;
    const index = nodes.length;
    nodes.push({ index, raw, text, indent, parent: open.at(-1) ?? -1, end: -1, role, name, ...(marked ? { ref: marked[5]! } : {}), attributes });
    open.push(index);
  }
  for (const index of open) nodes[index]!.end = nodes.length;
  return nodes;
}

/** What the views need from Camofox. */
export type AriaHelpers = {
  /** Compare names after this. It is the function that Camofox uses for its own name checks. */
  normalize(value: unknown): string;
  /** Camofox gives a ref to this node, if the 500-ref limit allows. */
  interactive(node: AriaNode): boolean;
};

/**
 * Load the helpers from the Camofox tree. The plugin runs from `plugins/local-profile/index.js` inside that tree,
 * where a package name does not resolve, and `src/` has no relative path to it. The plugin loads the tool contracts the same way.
 */
export async function loadAriaHelpers(upstream: string): Promise<AriaHelpers> {
  const load = (file: string) => import(pathToFileURL(join(upstream, "lib", file)).href) as Promise<Record<string, unknown>>;
  const [annotate, roles] = await Promise.all([load("aria-annotate.js"), load("interactive-roles.js")]);
  const { normalizedAccessibleName, SKIP_PATTERNS } = annotate, { INTERACTIVE_ROLES } = roles;
  if (typeof normalizedAccessibleName !== "function" || !Array.isArray(SKIP_PATTERNS) || !Array.isArray(INTERACTIVE_ROLES))
    throw Error("Camofox does not provide the ARIA helpers that Stelz needs.");
  return {
    normalize: normalizedAccessibleName as (value: unknown) => string,
    interactive: node => INTERACTIVE_ROLES.includes(node.role) && !(node.name && (SKIP_PATTERNS as RegExp[]).some(pattern => pattern.test(node.name))),
  };
}
