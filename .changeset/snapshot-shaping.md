---
"stelz": minor
---

Breaking change: `tab_snapshot` returns less text, and a tool refuses a ref that may have shifted.

`tab_snapshot` returns no screenshot unless you pass `includeScreenshot: true`. Before, it always returned one. It collapses a run of at least three similar items into the first item and one line, `- … N more like this`. It cuts the text at 20000 characters. The header has two new fields: `viewId`, and `baseline` when its value is `true`. See [Shared MCP tools](https://github.com/souljorje/stelz/blob/main/docs/mcp.md#snapshots).

New arguments of `tab_snapshot`:

- `scope` reads the subtree of one element, by role and name. The element can be a container that has no ref. `contains` reads the lines that contain a text, and their ancestors.
- `diff` reads only the lines that changed since your last snapshot of the tab. A diff shows the current refs on new and changed lines only. If there is no earlier snapshot, or the diff is not smaller than the page, the reply is the full view and its header has `baseline: true`.
- `collapse` turns the collapsing off. `maxChars` sets the size of one reply, up to 80000 characters.
- `includeScreenshot` adds the screenshot. `includeStructure` adds the forms and tables of the page, with the table ids for `tab_table_rows`.

`offset` now needs the `viewId` of the reply that gave you `nextOffset`. It reads the cached view and takes no new snapshot. A new snapshot replaces the cached view, and an old `viewId` fails with `Read a new tab_snapshot.` A client that pages with `offset` alone must pass the `viewId` now.

A ref is a position, so it can name another element after the page changes. `tab_click`, `tab_type`, `tab_select`, and `tab_mouse_wheel` now check a `ref` before they call the browser. They refuse a ref that no reply of the connection showed, or that names another element now. The error is `ref eN may have shifted. Read tab_snapshot again, or target the element by role and name.` Selectors are not checked. Acquire, release, resume, and a closed tab clear the refs that a connection can use.

A `tab_click` that fails its role or name check, and a failed `tab_extract`, no longer return the whole page. Their reply tells you to read `tab_snapshot`.
