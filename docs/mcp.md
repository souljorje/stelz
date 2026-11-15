---
title: "Shared MCP tools"
description: "The MCP tools of stelz mcp, the --tools groups, the scripts switch, tool results, and the control-handle contract, to read when you call or integrate the tools."
tags: [mcp, agent, reference]
sources: []
created: 2026-11-06T16:47:49Z
modified: 2026-11-15T16:45:00Z
---

# Shared MCP tools

- One connection to `stelz mcp` controls many profiles.
- See [Connect your agent](clients.md).
- Each profile: one controller, one action queue. Separate profiles can run actions concurrently.
- No agent identities.

## Tool groups

`stelz mcp --tools core|full|NAME,NAME`. The default is `core`.

| Value | Tools |
| --- | --- |
| `core` | The nine `profile_*` tools and 13 browser tools. The browser tools have **core** in the table below. |
| `full` | Every listed tool. |
| `NAME,NAME` | The named tools. |

- A comma-separated list can mix `core`, `full`, and tool names. For example, `core,tab_forward` is `core` plus `tab_forward`.
- A name that is not a listed tool stops `stelz mcp` at startup. This includes held tools and misspelled names.
- The tool list stays fixed for the connection. `tools/list` returns the same tools, including when the profile catalog is empty. Profile creation adds no tools.
- `profile_list({})` returns the current catalog.
- Scripts tools follow the rules in [Scripts](#scripts).

## Tools

| Profile tool | Arguments | Effect |
| --- | --- | --- |
| `profile_list` | `{}` | Returns a fresh catalog and profile status. |
| `profile_create` | `{profileId}` | Creates a direct profile or safely reuses an existing one unchanged. Leaves a new browser stopped. |
| `profile_start` | `{profileId}` | Starts the profile or reuses its safe running lifetime. Does not acquire control. |
| `profile_status` | `{profileId}` | Returns profile status and a controller summary. |
| `profile_acquire` | `{profileId}` | Acquires exclusive control of a running profile. Returns status and a fresh opaque `controlHandle`. Never starts a stopped browser. |
| `profile_release` | `{profileId, controlHandle}` | Releases control after current actions finish. Preserves the browser, pages, and phase. |
| `profile_pause` | `{profileId, controlHandle}` | Pauses browser actions for human work in the same window. Retains control. |
| `profile_resume` | `{profileId, controlHandle}` | Resumes after human work and any required IP check. Retains control. |
| `profile_recheck` | `{profileId, controlHandle}` | Repeats the browser IP check. Preserves a pause. |

Every browser tool requires `profileId` and `controlHandle` with its own arguments. Full schemas: `tools/list`.

Run `bun scripts/mcp-tools.ts` to regenerate this table from the catalog. A unit test checks it.

<!-- tools:start -->
| Tool | Group | Policy | Description |
| --- | --- | --- | --- |
| `tab_list` | core | default | List all open Camofox tabs for the current session. |
| `tab_create` | core | default | Open a new tab in the browser of this profile and go to a URL. |
| `tab_close` | core | default | Close a Camoufox browser tab. |
| `tab_navigate` | core | default | Go to a URL in a tab, or use a search macro such as @google_search or @youtube_search. |
| `tab_back` | core | default | Go back one entry in a Camoufox tab's history. |
| `tab_snapshot` | core | default | Read the page of a tab as an accessibility snapshot. |
| `tab_click` | core | default | Click an element in a Camoufox tab. |
| `tab_type` | core | default | Type text into an element in a Camoufox tab. |
| `tab_press` | core | default | Press a single keyboard key in a Camoufox tab (e.g., Enter, Escape, Tab, ArrowDown). |
| `tab_select` | core | default | Choose an option in a native \<select> dropdown in a Camoufox tab. |
| `tab_scroll` | core | default | Scroll a Camoufox page. |
| `tab_screenshot` | core | default | Take a screenshot of a Camoufox page. |
| `tab_wait` | core | default | Wait for a Camoufox page. |
| `tab_forward` | full | default | Go forward one entry in a Camoufox tab's history. |
| `tab_refresh` | full | default | Reload the current page in a Camoufox tab. |
| `tab_mouse_wheel` | full | default | Send a mouse wheel scroll over a specific element (by ref) or coordinate in a Camoufox tab. |
| `tab_drag` | full | default | Perform a trusted press-move-release mouse drag between two coordinates in a Camoufox tab. |
| `tab_ax` | full | default | Get the raw accessibility tree of a Camoufox page (unfiltered, no element refs). |
| `tab_actionables` | full | default | List the clickable and fillable elements on a Camoufox page as candidate interaction targets, each with its ref. |
| `tab_table_rows` | full | default | Read one page of rows from a table on a page. |
| `tab_links` | full | default | List the links on a Camoufox page, with pagination. |
| `tab_images` | full | default | List the images on a Camoufox page. |
| `tab_extract` | full | default | Extract structured data from a Camoufox page using a JSON Schema describing the fields to pull out. |
| `tab_evaluate` | full | scripts | Execute JavaScript in a Camoufox tab's page context. |
| `tab_init_script` | full | scripts | Register a script that runs in the page context before every subsequent navigation in a Camoufox tab. |
<!-- tools:end -->

- Group: `core` tools are in `core` and `full`. `full` tools are only in `full`.
- Policy: `default` tools are always listed. `scripts` tools follow the rules in [Scripts](#scripts).
- `tab_list` reads the tabs that Stelz manages. Tabs that a person opens stay open but are not listed.
- `tab_snapshot` has its own arguments. See [Snapshots](#snapshots).
- `tab_click`, `tab_type`, and `tab_select` accept a [`target`](#targets). These tools and `tab_press` accept [`observe`](#observe).
- `tab_wait` accepts a `target` or `contains` condition. See [Wait](#wait).
- `tab_screenshot` takes `fullPage`. The table ids for `tab_table_rows` come from `tab_snapshot` with `includeStructure`.
- `tab_type` accepts `mode`. See [Typing](configuration/typing.md).
- Stelz holds `tab_activate` and every upstream tool that it has not reviewed. It lists none of them. Stelz has no tool for cookies, storage, file upload, or the viewport. Cookie import and storage import stay in the CLI or UI.
- A call with a `progressToken` gets a progress notification every 10 seconds until it ends.
- Set your client to reset its request timeout on progress. Some calls, such as `tab_type`, can take minutes.
- Each call has its own time limit. See [Typing](configuration/typing.md).

## Tool results

- A JSON result is one compact JSON text block.
- `tab_snapshot`: the first line is JSON with `url`, `refsCount`, `truncated`, `nextOffset`, `viewId`, and `baseline`. `nextOffset` appears only when more text remains. `baseline` appears only when it is `true`. The page text follows as plain text, not JSON-escaped. A screenshot, when present, is an image block. See [Snapshots](#snapshots).
- A `tab_click` that fails its `expected_role` or `expected_accessible_name` check, and a failed `tab_extract`, do not return the page. Their reply has `hint`: `Read tab_snapshot for the current page.`
- A `tab_click`, `tab_type`, `tab_select`, or `tab_press` with `observe` `diff` (the default) is one text block with three parts: one line of compact JSON with the result of the action, the snapshot header line, and the page text. If the read of the page failed, the second line is a note instead. See [Observe](#observe).
- `tab_screenshot`: one image block.
- A failed call returns `isError: true` and one text block. A location failure is JSON with `error` and `location`.
- Results have no `structuredContent`.

## Snapshots

`tab_snapshot` takes a fresh snapshot and returns the page as YAML lines. An element that can take input has a ref on its line, such as `[e12]`. Without arguments, it returns the page with runs of similar items collapsed, cut at 20000 characters, and with no screenshot.

| Argument | Effect |
| --- | --- |
| `scope` | `{role, name?, nth?}`. Returns the subtree of one element. The element can be a container that has no ref. The role and the name are not case-sensitive. If more than one element matches and `nth` is missing, the call fails and gives the number of matches. `nth` counts from 0 in page order. The subtree starts at column 0. |
| `contains` | Returns the lines whose text contains the string, and their ancestors. The match is not case-sensitive. The ref marker is not text. With `scope`, only lines in the scope match. |
| `diff` | Returns the lines that changed since the last page that this connection read. See [Diff](#diff). |
| `collapse` | The default is `true`. Replaces a run of three or more sibling items with the first item and one line, `- … N more like this`. The items in a run have children and the same shape. The shape is the role of an item and the roles below it. Names and text do not count. A line with no children never collapses, so a list of links keeps every name. The collapsed items have no refs in the reply. A reply with `contains` or `diff` does not collapse. |
| `maxChars` | From 1000 to 80000. The default is 20000. |
| `offset`, `viewId` | Read the next window of an earlier reply. See [Paging](#paging). |
| `includeScreenshot` | The default is `false`. Adds a screenshot as an image block. |
| `includeStructure` | The default is `false`. Adds the forms and tables of the page after the page text, on the line after `# structure`, as compact JSON. |

- The order is: `scope`, then `contains`, then `diff`, then `collapse`, then the window.
- Camofox gives refs to the first 500 elements that can take input. If a reply shows later lines of such elements, its text starts with `# Interactive lines without a ref are past the 500-ref limit of this page.` Those lines have no refs.

### Diff

- The baseline is the last full page that this connection received for this tab. Each `tab_snapshot` that takes a snapshot replaces it. Paging does not.
- A read that `maxChars` cut still sets the whole page as the baseline, so a later diff can cover parts that you did not page through.
- `scope` and `contains` apply to the baseline and to the new page before the diff.
- The reply is the full view, and the header has `baseline: true`, when:
  - There is no baseline. Acquire, release, resume, and `tab_close` clear it. The end of the browser lifetime clears it too. This also covers a navigation, a reload, and a new tab.
  - The earlier read covered less than this one. For example, the earlier read used `scope`, and this one does not.
  - The scope matches in only one of the two pages.
  - The diff is not smaller than the page without `collapse`.
- The diff has one line of note, then the changed lines. Each line starts with one marker character:

| Marker | Line |
| --- | --- |
| `+` | A new line, or a changed line in its new form. It keeps its current ref. |
| `-` | A removed line, or a changed line in its old form. It has no ref. |
| space | The parent line of the next lines, for context. It has no ref. |

- A line that no marker shows did not change. A ref on an unchanged line may have shifted, so target it by role and name.
- A parent line shows once for a run of hunks in the same parent. If no line changed, the diff is the line `# No change since your last snapshot.`

```text
# Diff from your last snapshot. + is a new or changed line, - is a removed line. Note that refs on unchanged lines may have shifted; target by role and name.
 - banner:
+  - button "Menu" [e1]
     - listitem:
-      - text: $25
+      - text: $35
```

### Refs

- A ref is a position in the page. It can name another element after the page changes.
- For each connection and tab, Stelz keeps the refs that the connection can rely on. A ref is reliable in two cases. The last reply showed it on a line. Or it still names the same element that the connection saw before. Collapsed lines, lines outside the window, and unchanged lines of a diff do not show refs.
- `tab_click`, `tab_type`, `tab_select`, and `tab_mouse_wheel` check a `ref` before they call Camofox. A ref that is not reliable, or that now names another element, fails with `ref eN may have shifted. Read tab_snapshot again, or target the element by role and name.` A ref that the connection never saw fails the same way.
- A `selector` is not checked. A [`target`](#targets) is not checked either, because Stelz resolves it from a fresh snapshot in the same step.
- A new connection has no reliable refs. Read `tab_snapshot`, then use a ref that the reply shows.

### Paging

- Each reply has a `viewId`. If `truncated` is `true` and `nextOffset` is present, call `tab_snapshot` with that `offset` and the `viewId`. The call reads the cached view and takes no new snapshot.
- A window ends at a line break. `maxChars` can differ between windows.
- Stelz keeps the latest view of each connection and tab. A new snapshot replaces it. An unknown or replaced `viewId` fails with `Read a new tab_snapshot.` Acquire, release, resume, and `tab_close` remove it.
- `offset` needs `viewId`, and `viewId` needs `offset`. `offset` cannot go with `scope`, `contains`, `diff`, `collapse`, `includeScreenshot`, or `includeStructure`.
- Paging does not change the baseline. A ref on a window becomes reliable only if it still names the same element.

## Targets

`tab_click`, `tab_type`, and `tab_select` name the element with one of `target`, `ref`, and `selector`. Pass exactly one. `target` is the preferred way, because it does not depend on a ref that can shift.

| Field | Effect |
| --- | --- |
| `role` | The role in the snapshot, such as `button`, `link`, or `textbox`. Not case-sensitive. |
| `name` | The accessible name in the snapshot. Extra spaces and letter case do not count. |
| `nth` | Which match to use. It counts from 0 in page order, as it does for `scope`. |

- Stelz does these steps in one queued action:
  1. Read a fresh snapshot, without a screenshot.
  2. Find the elements with this `role` and `name`. The match is exact, after the normalization that Camofox uses for names. A longer name does not match.
  3. Call Camofox once, with the ref of the element.
- The call fails, and Camofox gets no action request, in these cases:
  - No element matches. The message lists up to five elements with the same role.
  - More than one element matches, and `nth` is missing. The message gives the number of matches and the range of `nth`.
  - The element is disabled.
  - The element has no ref. Only elements that can take input have refs, and Camofox stops at 500 refs. Use a `selector` for that element.
- A failed target is a mistake in the call. It does not block the browser.
- The snapshot of a target is not a view. It does not change the baseline, the latest view, or the refs that the connection can rely on.
- Stelz does not add `expected_role` or `expected_accessible_name`. Camofox takes a second snapshot for each one. You can still pass them.

## Observe

`tab_click`, `tab_type`, `tab_select`, and `tab_press` take `observe`: `"diff"` (the default) or `"none"`.

- `diff`: after the action succeeds, Stelz reads a snapshot in the same queued action. The result is the result of the action, then the page as `tab_snapshot` returns it with `diff: true`. See [Diff](#diff). Read it to check the action. Do not call `tab_snapshot` after an action.
- The observation is a view that the connection received. It replaces the baseline and the latest view. It also sets the refs that the connection can rely on, as `tab_snapshot` does. With no baseline, or when the diff is not smaller than the page, the page is the full view and the header has `baseline: true`.
- `none`: the result is the result of the action only.
- If the action fails, the call fails with the error of the action and has no observation. This includes an uncertain click. A click that Camofox refused (`ok: false`) did not happen, and it has no observation.
- If the action succeeds and the read of the page fails, the call still succeeds. The second line of the result is `# The action completed. Read tab_snapshot to see the page.` Do not repeat the action. A repeat can do the action twice. The read has its own limit of 15 seconds. If it passes the limit, the call also succeeds with the note, and the browser is blocked for that lifetime, as after any operation that passes its limit.
- The diff can come before a late change of the page. Use `tab_wait` to wait for that change.

```text
{"ok":true}
{"url":"https://example.test/","refsCount":43,"truncated":false,"viewId":"v4"}
# Diff from your last snapshot. + is a new or changed line, - is a removed line. Note that refs on unchanged lines may have shifted; target by role and name.
     - listitem:
-      - text: $25
+      - text: $35
```

## Wait

`tab_wait` has `timeout` (0 to 60000 ms, default 10000). It also takes one condition, or none.

| Argument | Effect |
| --- | --- |
| none | Waits for the page to settle. With `waitForNetwork` (default `true`), it also waits for an idle network. |
| `target` | `{role, name, nth?}`. Waits until the element is on the page. With `nth`, it waits until that many elements match. The matching rules of a [target](#targets) apply. |
| `contains` | Waits until a line of the page contains the text. Not case-sensitive. |

- Pass `target` or `contains`, not both. `waitForNetwork` does not apply to them.
- Stelz reads a fresh snapshot about every 300 ms. A poll is not a view. It changes no baseline, latest view, or reliable ref.
- The result is `{found, waitedMs}`. If `found` is `true`, the result can have `matched`: the line, without its ref, cut at 200 characters. If `found` is `false`, the result has `reason`:

| `reason` | Meaning |
| --- | --- |
| `timeout` | The element or the text did not appear within `timeout`. |
| `paused` | A person paused the profile during the wait. |
| `releasing` | The controller is releasing the profile. |

- These results are not errors. They do not block the browser. A pause or a release waits for the active action, so the wait ends at the next poll when either one starts. Stop the work after `paused` or `releasing`.
- A wait on a paused profile fails, as any action does.

## Scripts

- `tab_evaluate` and `tab_init_script` run arbitrary JavaScript in a page. They are off by default.
- `tab_evaluate` takes `timeoutMs`, a whole number from 1000 to 120000. The default is 30000.
- The `allowScripts` setting of a profile controls them. A person sets it with `stelz profile config ID --allow-scripts` or with **Allow scripts** in the UI. MCP cannot change it. `--no-allow-scripts` turns it off.
- A connection lists a scripts tool only when both rules hold:
  - `--tools full` or the tool name selects it. `core` never lists it.
  - At least one profile has `allowScripts: true` when the connection starts. After the first profile allows scripts, reconnect.
- Each call checks the setting of its own profile. A call on a profile without it fails. The message names the CLI command and the UI setting.
- Turning the setting off does not remove scripts that `tab_init_script` registered. They stay until their tab closes.
- A `tab_evaluate` that passes its `timeoutMs` returns an error. The script can still run in the page. Read a snapshot. Do not run the script again. The profile stays ready.
- A `tab_evaluate` that passes the service time limit blocks the browser lifetime, like any other action. See [Typing](configuration/typing.md).

## Control handles

- Every successful `profile_acquire` returns a fresh opaque handle. Do not derive it from a profile ID, process ID, agent name, or controller summary.
- Use it only on the connection, profile, and browser lifetime that issued it. Keep one handle for each profile.
- List and status return controller summaries without handles.
- A connection cannot acquire a profile while its previous acquisition is active or pending. Release first.
- Release, disconnect, browser restart, and forced operator handoff invalidate the control. Acquire again, use the new handle, and read fresh browser state.
- Release and disconnect preserve running browsers and open pages. The next connection acquires its own handle.

## Limits of the tools

- Creation never reconfigures an existing profile. It keeps its route, expected IP, port, data, and secret references.
- Configuration and lifecycle changes stay with people. See [Stelz as a product](product.md#rules).
- Call order, readiness, and human authentication: [browser skill](../skills/stelz-browser/SKILL.md#do-a-browser-task).
- Conflicts and stale handles: [Troubleshooting](troubleshooting/index.md).
