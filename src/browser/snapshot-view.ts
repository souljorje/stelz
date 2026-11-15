import type { AriaHelpers, AriaNode } from "./aria.ts";

// Pure functions that turn parsed snapshots into the text of one reply: scope, contains, diff, collapse, and windows.
// A view is a list of rows. A row that shows a ref carries that ref, so the caller knows which refs a reply showed.

export type Scope = { role: string; name?: string; nth?: number };
export type Filter = { scope?: Scope; contains?: string };
export type ViewOptions = Filter & { diff?: boolean; collapse?: boolean };
/** One printed line. */
export type Row = {
  text: string;
  /** The ref that this row shows. */
  ref?: string;
  /** The node of a row that can show a ref. A removed line or a context line has none. */
  node?: AriaNode;
};
/** A node of a view with its text relative to the view. A scope view starts at column 0. */
type Line = { node: AriaNode; text: string; raw: string; indent: number; parent: number };

export const DEFAULT_MAX_CHARS = 20_000;
export const MIN_MAX_CHARS = 1_000;
export const MAX_MAX_CHARS = 80_000;
/** The ref limit of Camofox (MAX_SNAPSHOT_NODES in server.js). Interactive lines after it have no ref. */
export const REF_LIMIT = 500;
// Collapse a run of at least this many items. The first item stays, so a run of three shows one item and a line for the other two.
const COLLAPSE_MIN = 3;
// The diff gives up when the pages differ in more lines than this. The reply is then the full view.
const MAX_EDITS = 1_000;
const MAX_SHAPE = 500;

const DIFF_NOTE = "# Diff from your last snapshot. + is a new or changed line, - is a removed line. " +
  "Note that refs on unchanged lines may have shifted; target by role and name.";
const NO_CHANGE_NOTE = "# No change since your last snapshot.";
const NO_REF_NOTE = "# Interactive lines without a ref are past the 500-ref limit of this page.";

/** The key that tells whether two requests read the same part of the page. An empty key means the whole page. */
export function filterKey({ scope, contains }: Filter) {
  if (!scope && contains === undefined) return "";
  return JSON.stringify([scope ? [scope.role.trim().toLowerCase(), scope.name ?? null, scope.nth ?? null] : null, contains?.toLowerCase() ?? null]);
}

/** A selector that names no safe element: no match, too many matches, or an element that cannot take the action. The caller's mistake, not a browser failure. */
export class SelectorError extends Error {}

/** The nodes with this role and name, in page order. The role is exact and not case-sensitive. The names compare after Camofox normalizes them. */
export function matchNodes(nodes: AriaNode[], { role, name }: Scope, { normalize }: AriaHelpers): AriaNode[] {
  const wanted = role.trim().toLowerCase(), text = name === undefined ? undefined : normalize(name);
  return nodes.filter(node => node.role === wanted && (text === undefined || normalize(node.name) === text));
}

const describe = ({ role, name }: Scope) => `role "${role}"${name === undefined ? "" : ` and name "${name}"`}`;

/**
 * The one node that a selector names, for a scope or for a target. `nth` counts from 0 in page order.
 * A selector that matches more than one node needs `nth`.
 */
export function findNode(nodes: AriaNode[], selector: Scope, helpers: AriaHelpers, noun: "scope" | "target" = "scope"): AriaNode {
  const hits = matchNodes(nodes, selector, helpers), described = describe(selector);
  if (!hits.length) throw new SelectorError(`No element matches the ${noun}: ${described}.${noun === "target" ? nearby(nodes, selector, helpers) : ""}`);
  if (selector.nth === undefined) {
    if (hits.length > 1) throw new SelectorError(`The ${noun} matches ${hits.length} elements: ${described}. Pass nth (0 to ${hits.length - 1})${noun === "scope" ? " or a more exact name" : ""}.`);
    return hits[0]!;
  }
  if (selector.nth >= hits.length) throw new SelectorError(`The ${noun} matches ${hits.length} ${hits.length === 1 ? "element" : "elements"}: ${described}. nth must be 0 to ${hits.length - 1}.`);
  return hits[selector.nth]!;
}

// The elements with the same role, the ones with the most words of the wanted name first. They tell the caller what the page has.
const CANDIDATES = 5;
function nearby(nodes: AriaNode[], { role, name = "" }: Scope, { normalize }: AriaHelpers) {
  const wanted = normalize(name), words = new Set(wanted.split(" ").filter(Boolean)), same = role.trim().toLowerCase();
  const close = nodes.filter(node => node.role === same).map((node, order) => {
    const text = normalize(node.name);
    return { node, order, score: text.split(" ").filter(word => words.has(word)).length + (text && (text.includes(wanted) || wanted.includes(text)) ? words.size + 1 : 0) };
  }).sort((a, b) => b.score - a.score || a.order - b.order).slice(0, CANDIDATES);
  if (!close.length) return ` The page has no element with the role "${role}".`;
  return ` Elements with this role: ${close.map(({ node }) => `${node.role} ${JSON.stringify(node.name.length > 60 ? `${node.name.slice(0, 57)}...` : node.name)}`).join(", ")}.`;
}

/** Apply scope, then contains. A scope can match any node, also one that has no ref. The result is in document order. */
function selectLines(nodes: AriaNode[], filter: Filter, helpers: AriaHelpers): Line[] {
  let lo = 0, hi = nodes.length, dedent = 0;
  if (filter.scope) {
    const root = findNode(nodes, filter.scope, helpers);
    lo = root.index; hi = root.end; dedent = root.indent;
  }
  let chosen: number[] = [];
  if (filter.contains === undefined) for (let i = lo; i < hi; i++) chosen.push(i);
  else {
    const needle = filter.contains.toLowerCase(), keep = new Set<number>();
    for (let i = lo; i < hi; i++) {
      if (!nodes[i]!.text.toLowerCase().includes(needle)) continue;
      // Keep the match and its ancestors, up to the top of the scope.
      for (let at = i; at >= lo && !keep.has(at); at = nodes[at]!.parent) keep.add(at);
    }
    chosen = [...keep].sort((a, b) => a - b);
  }
  const position = new Map(chosen.map((index, line) => [index, line]));
  return chosen.map(index => {
    const node = nodes[index]!;
    return { node, text: node.text.slice(dedent), raw: node.raw.slice(dedent), indent: node.indent - dedent, parent: position.get(node.parent) ?? -1 };
  });
}

const rowOf = (line: Line): Row => ({ text: line.raw, ...(line.node.ref ? { ref: line.node.ref } : {}), node: line.node });

/**
 * Replace each run of sibling items that have the same shape with its first item and one line, "… N more like this".
 * The lines must be contiguous nodes, as in the whole page or in a scope view. A leaf never collapses, so a list of links keeps every name.
 */
function collapseRows(lines: Line[]): Row[] {
  const size = (i: number) => lines[i]!.node.end - lines[i]!.node.index;
  const shapes = new Map<number, string>();
  // The shape of an item is its role and the shapes of its children. Names and text do not count.
  const shape = (i: number): string => {
    let found = shapes.get(i);
    if (found === undefined) {
      const kids: string[] = [];
      for (let k = i + 1; k < i + size(i); k += size(k)) kids.push(shape(k));
      found = (lines[i]!.node.role + (kids.length ? `(${kids.join(",")})` : "")).slice(0, MAX_SHAPE);
      shapes.set(i, found);
    }
    return found;
  };
  const rows: Row[] = [];
  const walk = (from: number, to: number) => {
    for (let i = from; i < to;) {
      const span = size(i);
      let next = i + span, count = 1;
      if (span > 1) for (const key = shape(i); next < to && size(next) > 1 && shape(next) === key; next += size(next)) count++;
      rows.push(rowOf(lines[i]!));
      walk(i + 1, i + span);
      if (count >= COLLAPSE_MIN) {
        rows.push({ text: `${" ".repeat(lines[i]!.indent)}- … ${count - 1} more like this` });
        i = next;
      } else i += span;
    }
  };
  walk(0, lines.length);
  return rows;
}

/** One removed line (`a` is its index) or one inserted line (`b` is its index). The other index is the position in the other list. */
type Edit = { kind: "-" | "+"; a: number; b: number };

/**
 * The shortest list of removals and insertions that turns `a` into `b` (Myers). It returns undefined past `limit` edits.
 * Equal lines at the start and at the end cost nothing.
 */
export function edits(a: string[], b: string[], limit = MAX_EDITS): Edit[] | undefined {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const x = a.slice(start, endA), y = b.slice(start, endB);
  const n = x.length, m = y.length, max = Math.min(n + m, limit), offset = max + 1;
  const trace: Int32Array[] = [];
  const v = new Int32Array(2 * max + 3);
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let px = k === -d || (k !== d && v[k - 1 + offset]! < v[k + 1 + offset]!) ? v[k + 1 + offset]! : v[k - 1 + offset]! + 1;
      let py = px - k;
      while (px < n && py < m && x[px] === y[py]) { px++; py++; }
      v[k + offset] = px;
      if (px >= n && py >= m) { found = d; break; }
    }
  }
  if (found < 0) return undefined;
  const result: Edit[] = [];
  let px = n, py = m;
  for (let d = found; d > 0; d--) {
    const before = trace[d]!, k = px - py;
    const from = k === -d || (k !== d && before[k - 1 + offset]! < before[k + 1 + offset]!) ? k + 1 : k - 1;
    const fromX = before[from + offset]!, fromY = fromX - from;
    // Walk back over the equal lines that follow this edit.
    while (px > fromX && py > fromY) { px--; py--; }
    result.push({ kind: px === fromX ? "+" : "-", a: start + fromX, b: start + fromY });
    px = fromX; py = fromY;
  }
  return result.reverse();
}

// Two edits are in one hunk when no equal line lies between them.
const touches = (left: Edit, right: Edit) => right.a === left.a + (left.kind === "-" ? 1 : 0) && right.b === left.b + (left.kind === "+" ? 1 : 0);

/**
 * The lines of `current` that changed since `previous`, as rows. An added or changed line has its current ref.
 * A removed line has none. Each hunk starts with the parent line of its first line, for context, without a ref.
 */
function diffRows(previous: Line[], current: Line[]): Row[] | undefined {
  const script = edits(previous.map(line => line.text), current.map(line => line.text));
  if (!script) return undefined;
  if (!script.length) return [{ text: NO_CHANGE_NOTE }];
  const rows: Row[] = [{ text: DIFF_NOTE }];
  // The line of the current page that equals each unchanged line of the previous page.
  const equal: number[] = [];
  let ai = 0, bi = 0;
  for (const edit of script) {
    if (edit.kind === "-") for (; ai < edit.a; ai++, bi++) equal[ai] = bi;
    else for (; bi < edit.b; ai++, bi++) equal[ai] = bi;
    if (edit.kind === "-") ai++; else bi++;
  }
  for (; ai < previous.length && bi < current.length; ai++, bi++) equal[ai] = bi;
  let shown = "";
  for (let i = 0; i < script.length;) {
    let end = i + 1;
    while (end < script.length && touches(script[end - 1]!, script[end]!)) end++;
    const hunk = script.slice(i, end), first = hunk[0]!;
    const removed = first.kind === "-", side = removed ? previous : current, parent = side[removed ? first.a : first.b]!.parent;
    // The parent line shows once for a run of hunks in the same parent. A parent that both pages have is the same line on both sides.
    const key = removed ? (equal[parent] === undefined ? `a${parent}` : `b${equal[parent]}`) : `b${parent}`;
    if (parent >= 0 && key !== shown) { rows.push({ text: ` ${side[parent]!.text}` }); shown = key; }
    for (const edit of hunk) if (edit.kind === "-") rows.push({ text: `-${previous[edit.a]!.text}` });
    for (const edit of hunk) if (edit.kind === "+") rows.push({ ...rowOf(current[edit.b]!), text: `+${current[edit.b]!.raw}` });
    i = end;
  }
  return rows;
}

const length = (rows: Row[]) => rows.reduce((sum, row) => sum + row.text.length + 1, 0) - 1;

type Built = { rows: Row[]; baseline: boolean };
/**
 * Build the rows of one view. `previous` is the baseline, or undefined when there is none.
 * Scope and contains apply to both sides before the diff. A diff that is not smaller than the full view gives the full view,
 * and `baseline` says so when the caller asked for a diff. The size rule compares with the view before collapse. A collapsed view can be
 * smaller than a diff and still hide the changed lines.
 */
export function buildView(current: AriaNode[], previous: AriaNode[] | undefined, options: ViewOptions, helpers: AriaHelpers): Built {
  const lines = selectLines(current, options, helpers);
  const all = lines.map(rowOf);
  if (options.diff && previous) {
    let before: Line[] | undefined;
    // A scope may match on one page and not on the other. Then there is nothing to compare.
    try { before = selectLines(previous, options, helpers); } catch { before = undefined; }
    const changes = before && diffRows(before, lines);
    if (changes && length(changes) < length(all)) return { rows: changes, baseline: false };
  }
  // A collapsed run would hide lines that the caller asked for with contains.
  return { rows: options.contains !== undefined || options.collapse === false ? all : collapseRows(lines), baseline: !!options.diff };
}

export type Page = { text: string; truncated: boolean; nextOffset?: number; rows: Row[] };
/**
 * One window of a view, by characters. The window ends at a line break, except for a line that is longer than `maxChars`.
 * `rows` are the rows that the window shows completely.
 */
export function windowRows(rows: Row[], offset: number, maxChars: number): Page {
  const starts: number[] = [];
  let at = 0;
  for (const row of rows) { starts.push(at); at += row.text.length + 1; }
  const total = Math.max(0, at - 1), text = rows.map(row => row.text).join("\n");
  if (offset > 0 && offset >= total) throw Error("offset is past the end of the view. Read a new tab_snapshot.");
  let end = Math.min(total, offset + maxChars), next = end;
  if (end < total) {
    // Cut at the last line break in the window. Keep the cut inside a line that is longer than the window.
    if (text[end] === "\n") next = end + 1;
    else {
      const cut = text.lastIndexOf("\n", end - 1);
      if (cut >= offset) { end = cut; next = cut + 1; }
    }
  }
  return { text: text.slice(offset, end), truncated: offset > 0 || end < total, ...(end < total ? { nextOffset: next } : {}),
    rows: rows.filter((row, i) => starts[i]! >= offset && starts[i]! + row.text.length <= end) };
}

const hasLostRefs = (page: Page, refsCount: number, helpers: AriaHelpers) =>
  refsCount >= REF_LIMIT && page.rows.some(row => row.node && !row.node.ref && helpers.interactive(row.node));

/**
 * A window with one note on top when it shows interactive lines that have no ref. They are past the ref limit.
 * The note counts in `maxChars`, so the text is never longer than `maxChars`.
 */
export function windowView(rows: Row[], offset: number, maxChars: number, refsCount: number, helpers: AriaHelpers): Page {
  const page = windowRows(rows, offset, maxChars);
  if (!hasLostRefs(page, refsCount, helpers)) return page;
  const narrow = windowRows(rows, offset, maxChars - NO_REF_NOTE.length - 1);
  return hasLostRefs(narrow, refsCount, helpers) ? { ...narrow, text: `${NO_REF_NOTE}\n${narrow.text}` } : narrow;
}
