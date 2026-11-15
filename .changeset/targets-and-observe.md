---
"stelz": minor
---

Breaking change: `tab_click`, `tab_type`, `tab_select`, and `tab_press` now return the changed lines of the page after the action, and the first three need exactly one of `ref`, `selector`, and `target`.

- `observe` is `"diff"` (the default) or `"none"`. With `diff`, the result is one line of JSON with the result of the action, then the snapshot header and the changed lines, as `tab_snapshot` returns them with `diff: true`. A client must not parse the whole text as one JSON value. Pass `observe: "none"` for the result of the action only. If the action succeeds and the read of the page fails, the call still succeeds and says `# The action completed. Read tab_snapshot to see the page.` Do not repeat the action.
- `target` is `{role, name, nth?}`. It is the preferred way to name an element on `tab_click`, `tab_type`, and `tab_select`. Stelz finds the element in a fresh snapshot in the same step. A call with two of `ref`, `selector`, and `target`, or with none, now fails.
- `tab_wait` takes `target` or `contains`. It waits until the element or the text is on the page. The result is `{found, waitedMs}`, with `reason` (`timeout`, `paused`, or `releasing`) when `found` is `false`. That is not an error.

A `scope` or a `target` that matches no element no longer blocks the browser when its name contains the word `timeout`. See [Shared MCP tools](https://github.com/souljorje/stelz/blob/main/docs/mcp.md#targets).
