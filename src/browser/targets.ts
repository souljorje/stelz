import type { AriaHelpers, AriaNode } from "./aria.ts";
import { REF_LIMIT, SelectorError, findNode, matchNodes, type Scope } from "./snapshot-view.ts";

// What the service looks for in one fresh snapshot: the element that a role/name target names, or the text that tab_wait waits for.
// Both work on a parsed snapshot. They do not change what a controller has seen.

/** A role/name target. It follows the rules of `scope`: `nth` counts from 0 in page order. */
export type Target = Scope & { name: string };

/**
 * The ref of the element that `target` names in this snapshot. The snapshot comes from the same queued action as the call that uses the ref,
 * so the ref still names that element. It throws when no click is safe: no match, an ambiguous match, a disabled element, or no ref.
 */
export function resolveTarget(nodes: AriaNode[], target: Target, helpers: AriaHelpers): string {
  const node = findNode(nodes, target, helpers, "target");
  const named = `${node.role} ${JSON.stringify(node.name)}`;
  if (node.attributes.includes("disabled")) throw new SelectorError(`The element is disabled: ${named}. Wait until the page enables it, or choose another element.`);
  if (node.ref) return node.ref;
  throw new SelectorError(helpers.interactive(node)
    ? `The element has no ref, because it is past the ${REF_LIMIT}-ref limit of this page: ${named}. Read it with tab_snapshot and scope or contains, or use a selector.`
    : `The element has no ref, because only elements that take input have refs: ${named}. Use a selector.`);
}

/** What tab_wait waits for. */
export type Condition = { target: Target } | { contains: string };

const MATCHED_CHARS = 200;
/**
 * The line of the first element that meets the condition, without its ref marker, or undefined when none does.
 * A target is present when it has a match. With `nth`, it needs that many matches. `contains` follows the rules of `tab_snapshot`.
 */
export function findCondition(nodes: AriaNode[], condition: Condition, helpers: AriaHelpers): string | undefined {
  let node: AriaNode | undefined;
  if ("target" in condition) node = matchNodes(nodes, condition.target, helpers)[condition.target.nth ?? 0];
  else {
    const needle = condition.contains.toLowerCase();
    node = nodes.find(item => item.text.toLowerCase().includes(needle));
  }
  return node?.text.trim().slice(0, MATCHED_CHARS);
}
