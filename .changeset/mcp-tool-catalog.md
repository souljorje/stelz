---
"stelz": minor
---

Breaking change: the browser tools have new names. Each `camofox_*` tool is now a `tab_*` tool. `camofox_create_tab`, `camofox_list_tabs`, and `camofox_close_tab` are now `tab_create`, `tab_list`, and `tab_close`. For every other tool, replace the prefix. For example, `camofox_click` is now `tab_click`, and `camofox_snapshot` is now `tab_snapshot`. The `profile_*` tools keep their names.

A permission list in your client names each tool, for example `mcp__stelz__camofox_click`. These entries no longer match. Replace them with the new names, for example `mcp__stelz__tab_click`. Install the browser skill again, because it uses the new names and needs this version.

`stelz mcp --tools core|full|NAME,NAME` selects the tools of a connection. The default, `core`, lists the nine `profile_*` tools and 13 `tab_*` tools. Together they are 22 tools, and `tab_wait` is new in `core`. `full` also lists `tab_forward`, `tab_refresh`, `tab_mouse_wheel`, `tab_drag`, `tab_ax`, `tab_actionables`, `tab_table_rows`, `tab_links`, `tab_images`, and `tab_extract`. A name that is not a listed tool stops `stelz mcp` at startup. `tab_screenshot` accepts `fullPage`.

`tab_evaluate` and `tab_init_script` run JavaScript in a page. They are off by default. A person turns them on for one profile with `stelz profile config ID --allow-scripts` or with **Allow scripts** in the UI. MCP cannot change this setting. A connection lists these tools only with `--tools full` or their names, and only when a profile allows scripts at the start of the connection. Turning the setting off keeps scripts that `tab_init_script` already registered until their tab closes. Profile archives do not carry the setting, so an imported profile starts with scripts off.

`tab_snapshot` now returns one header line and then the page text as plain text. The header is JSON with `url`, `refsCount`, `truncated`, and `nextOffset`. `nextOffset` appears only when more text remains. The result no longer has `structure`, `totalChars`, or `hasMore`. Other tools return compact JSON.

`tab_wait` and `tab_evaluate` use their own time limits, up to 60 seconds and 120 seconds. A `tab_evaluate` that passes its `timeoutMs` now returns an error that says the script can still run. It no longer blocks the browser. In the UI, **Recheck IP** is now **Recheck**.
