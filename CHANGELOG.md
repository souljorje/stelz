# stelz

## 0.6.1

### Patch Changes

- 89b1beb: Turn off the Firefox offer to restore the last session. It showed once, on the second start of a profile, and made pages 39 px shorter for that session.
- 19c4894: Use verified Camoufox and GeoIP AIO backups when the upstream downloads are unavailable.
  Setup can read release manifests from any HTTPS host.
- f9ba27c: Setup replaces a configured browser that is not the paired build. When `CAMOUFOX_EXECUTABLE` in `secrets.env` selects another build or a missing file, setup names the installed and the required version and asks. After a yes, or with `--yes`, it installs the paired build and removes the setting. Before, setup failed with advice to run setup again.
  
  The same setting in the process environment still fails. The error tells you to unset it.

## 0.6.0

### Minor Changes

- 5bbe1bc: Upgrade Camoufox to launcher 0.5.9 and browser 158.0.1-beta.41. Start uses the prepared model and derives display and GPU preferences from the saved identity.
  
  Use upstream canvas placeholders to prevent a separate GPU probe browser. Canvas/WebGL readback returns random data, and WebGPU cannot expose the host adapter.
  
  Existing profiles retain their engine checks. Profiles pinned to an earlier executable cannot start with the new engine.
- 063c79c: Breaking change: the browser tools have new names. Each `camofox_*` tool is now a `tab_*` tool. `camofox_create_tab`, `camofox_list_tabs`, and `camofox_close_tab` are now `tab_create`, `tab_list`, and `tab_close`. For every other tool, replace the prefix. For example, `camofox_click` is now `tab_click`, and `camofox_snapshot` is now `tab_snapshot`. The `profile_*` tools keep their names.
  
  A permission list in your client names each tool, for example `mcp__stelz__camofox_click`. These entries no longer match. Replace them with the new names, for example `mcp__stelz__tab_click`. Install the browser skill again, because it uses the new names and needs this version.
  
  `stelz mcp --tools core|full|NAME,NAME` selects the tools of a connection. The default, `core`, lists the nine `profile_*` tools and 13 `tab_*` tools. Together they are 22 tools, and `tab_wait` is new in `core`. `full` also lists `tab_forward`, `tab_refresh`, `tab_mouse_wheel`, `tab_drag`, `tab_ax`, `tab_actionables`, `tab_table_rows`, `tab_links`, `tab_images`, and `tab_extract`. A name that is not a listed tool stops `stelz mcp` at startup. `tab_screenshot` accepts `fullPage`.
  
  `tab_evaluate` and `tab_init_script` run JavaScript in a page. They are off by default. A person turns them on for one profile with `stelz profile config ID --allow-scripts` or with **Allow scripts** in the UI. MCP cannot change this setting. A connection lists these tools only with `--tools full` or their names, and only when a profile allows scripts at the start of the connection. Turning the setting off keeps scripts that `tab_init_script` already registered until their tab closes. Profile archives do not carry the setting, so an imported profile starts with scripts off.
  
  `tab_snapshot` now returns one header line and then the page text as plain text. The header is JSON with `url`, `refsCount`, `truncated`, and `nextOffset`. `nextOffset` appears only when more text remains. The result no longer has `structure`, `totalChars`, or `hasMore`. Other tools return compact JSON.
  
  `tab_wait` and `tab_evaluate` use their own time limits, up to 60 seconds and 120 seconds. A `tab_evaluate` that passes its `timeoutMs` now returns an error that says the script can still run. It no longer blocks the browser. In the UI, **Recheck IP** is now **Recheck**.
- 7740ed3: The npm package now holds only the runtime. Documentation and the browser skill are no longer in it.
  
  The browser skill is one self-contained file. Install it by saving `SKILL.md` into your client's skill folder. See [Connect your agent](https://github.com/souljorje/stelz/blob/main/docs/clients.md). A skill that you linked from the installed package stops working after this update. Install it again.
  
  Bun now runs the `stelz` command and the supervisor from source.
- de7e54f: Add `stelz/sdk`, a script SDK for Bun. A script calls `start(profileId)` to start a browser, and `acquire(profileId, work)` to control a running profile. `acquire` never starts a browser and always releases control, and the browser and its tabs stay open.
  
  - `work` receives a `Browser` with `tabs()`, `page(tabId)`, `open(url)`, `pause()`, `resume()`, and `captureFailure(directory)`. A `Page` has `navigate`, `click`, `type`, `select`, `press`, `scroll`, `snapshot`, `expectElement`, `expectText`, and `evaluate`.
  - The SDK calls the same code as the MCP tools, with the same names, rules, and role-and-name targets. It does not start a child `stelz mcp` process.
  - A script runs with Bun, on the machine of the service. Select the service directory with `STELZ_HOME`.
  - The SDK installs no signal handlers. The next `acquire` takes over from a script that died.
  
  The `package.json` file now has an `exports` field. It exports `stelz/sdk` only. See [Script SDK](https://github.com/souljorje/stelz/blob/main/docs/sdk.md).
- 9702f89: Breaking change: `tab_snapshot` returns less text, and a tool refuses a ref that may have shifted.
  
  `tab_snapshot` returns no screenshot unless you pass `includeScreenshot: true`. Before, it always returned one. It collapses a run of at least three similar items into the first item and one line, `- … N more like this`. It cuts the text at 20000 characters. The header has two new fields: `viewId`, and `baseline` when its value is `true`. See [Shared MCP tools](https://github.com/souljorje/stelz/blob/main/docs/mcp.md#snapshots).
  
  New arguments of `tab_snapshot`:
  
  - `scope` reads the subtree of one element, by role and name. The element can be a container that has no ref. `contains` reads the lines that contain a text, and their ancestors.
  - `diff` reads only the lines that changed since your last snapshot of the tab. A diff shows the current refs on new and changed lines only. If there is no earlier snapshot, or the diff is not smaller than the page, the reply is the full view and its header has `baseline: true`.
  - `collapse` turns the collapsing off. `maxChars` sets the size of one reply, up to 80000 characters.
  - `includeScreenshot` adds the screenshot. `includeStructure` adds the forms and tables of the page, with the table ids for `tab_table_rows`.
  
  `offset` now needs the `viewId` of the reply that gave you `nextOffset`. It reads the cached view and takes no new snapshot. A new snapshot replaces the cached view, and an old `viewId` fails with `Read a new tab_snapshot.` A client that pages with `offset` alone must pass the `viewId` now.
  
  A ref is a position, so it can name another element after the page changes. `tab_click`, `tab_type`, `tab_select`, and `tab_mouse_wheel` now check a `ref` before they call the browser. They refuse a ref that no reply of the connection showed, or that names another element now. The error is `ref eN may have shifted. Read tab_snapshot again, or target the element by role and name.` Selectors are not checked. Acquire, release, resume, and a closed tab clear the refs that a connection can use.
  
  A `tab_click` that fails its role or name check, and a failed `tab_extract`, no longer return the whole page. Their reply tells you to read `tab_snapshot`.
- 2b472fc: Breaking change: `tab_click`, `tab_type`, `tab_select`, and `tab_press` now return the changed lines of the page after the action, and the first three need exactly one of `ref`, `selector`, and `target`.
  
  - `observe` is `"diff"` (the default) or `"none"`. With `diff`, the result is one line of JSON with the result of the action, then the snapshot header and the changed lines, as `tab_snapshot` returns them with `diff: true`. A client must not parse the whole text as one JSON value. Pass `observe: "none"` for the result of the action only. If the action succeeds and the read of the page fails, the call still succeeds and says `# The action completed. Read tab_snapshot to see the page.` Do not repeat the action.
  - `target` is `{role, name, nth?}`. It is the preferred way to name an element on `tab_click`, `tab_type`, and `tab_select`. Stelz finds the element in a fresh snapshot in the same step. A call with two of `ref`, `selector`, and `target`, or with none, now fails.
  - `tab_wait` takes `target` or `contains`. It waits until the element or the text is on the page. The result is `{found, waitedMs}`, with `reason` (`timeout`, `paused`, or `releasing`) when `found` is `false`. That is not an error.
  
  A `scope` or a `target` that matches no element no longer blocks the browser when its name contains the word `timeout`. See [Shared MCP tools](https://github.com/souljorje/stelz/blob/main/docs/mcp.md#targets).

### Patch Changes

- 0d89231: Camofox is now version 1.19.0.
  
  Camofox 1.19.0 can restart a browser that has a session, close a crashed tab, and resize a popup. Stelz keeps these actions off.
- ba87838: Prevent repeated browser clicks after native input. Remove the trial click and stop fallback attempts when the click budget expires.
- c5fb039: The server instructions of `stelz mcp` now match the new tools. They tell an agent to read the diff that each action returns. They also tell it to name elements by role and name, and to use `tab_wait` when the diff does not show an expected change yet. Before, they told an agent to read fresh snapshots. A client that gives the server instructions to its model shows the new text after the update.
- 84ff904: Send native click events in sequence. After an uncertain click, block further browser actions until the profile stops and starts again.
- 371b7e4: Keep proxy authentication credentials in memory during browser IP checks instead of writing them into the profile add-on.

## 0.5.0

### Minor Changes

- 2f56b05: One module now sets every browser action limit. `camofox_type` can take up to 3 minutes, instead of 45 seconds. Clicks, navigation, scrolls, snapshots, and screenshots keep their 30-second limit. Keyboard text that cannot finish in time fails before the field changes. Long tool calls send MCP progress notifications every 10 seconds when the client requests them. Set Codex `tool_timeout_sec` and the Hermes `timeout` to 240 seconds or more.
  
  Typos and their corrections no longer apply to fields with a length limit, one-time-code entry, a numeric or similar input mode, live suggestions, search inputs, or rich editors.
- bb4f7e4: Select proxy locations with GeoIP AIO, the official Camoufox default, and compare them with GeoLite2 City. `stelz setup` downloads both databases. A proxied profile can get a different timezone at its next Start. A running browser keeps its settings.
  
  Preflight now reports the location source, its build date, and whether the comparison database corroborates, cannot confirm, or contradicts the location. When a build is older than 8 days, setup downloads a newer release if one exists. Set `STELZ_LOCATION_POLICY=strict` to block Start on a conflict or on data that is older than 30 days.
  
  A passed browser check now states that the browser applies the prepared timezone and language. It does not confirm a physical location.
- a057edd: Remove compatibility with earlier Stelz versions. `stelz mcp --profile` no longer returns migration guidance, and MCP no longer checks a browser service's control protocol version. Create new profiles for profiles from earlier versions.
- fd154c1: Use the official Camoufox launcher instead of camoufox-js. To update from an earlier version, stop all running profiles before you install the new package. Then run `stelz setup` and start profiles explicitly.
  
  Fingerprint checks now use the launcher's coherence rules. A saved macOS identity with an ANGLE renderer or another upstream contradiction blocks Start. The window-chrome rule only gives a warning.
  
  Stelz now requires the paired Camoufox `156.0.1-beta.36`. Setup and Start reject other builds. A profile pinned to another build, such as 152, cannot start. Create a new profile instead.
  Window sizes are no longer part of the saved identity. Startup checks them against the real window.
- 017c289: Make `keyboard` the default typing mode, with variable timing and no bulk fallback for long text. Rename `auto` to `balanced`. The former name is invalid and saved settings are not migrated.
  
  Add occasional corrected typos to paced typing in ordinary text fields. Specialized inputs, such as dates, still use bulk entry.
- a43ba2f: Validate browser fingerprints before admitting profile control and preserve staged fingerprints after interrupted startup. Add read-only fingerprint checks and transfer diagnostics.
- 32892cf: Show location readiness before proxied browser startup. Prepare shared GeoIP data through setup and require preflight plus browser verification before Ready. Preserve actionable failures in the UI, CLI, and MCP.
- 0cc3c80: `stelz setup` is now the only setup command, and `stelz init` is removed. Setup creates missing service files. Before it downloads anything, setup asks once in a terminal, or requires `--yes`. `--json` prints one report with the source of each part: the browser, the location data, and the fingerprint model.
- c309ef8: `stelz setup` now prepares the paired Camoufox build itself. It reuses its own copy in `STELZ_HOME/browsers/`, clones the paired install from the upstream Camoufox cache, or downloads the release and verifies its published SHA-256 digest. `CAMOUFOX_EXECUTABLE` is now an optional override, and it must name the paired build.
- 0f88d66: `stelz setup` no longer requires stopped profiles. Each setup prepares a runtime generation in `runtime-generations/`, or reuses an unchanged one. A running profile keeps the generation that it started with, and its status shows `restartToUpdate: true` until you restart it. Setup removes generations that no running profile uses. New command: `stelz restart ID|all` stops and then starts running profiles.

### Patch Changes

- 130a412: Wait for complete startup window measurements within the existing deadline. Read the startup page between two window samples, and read it again while the window changes. A stable mismatch still blocks Start.
  Activate the selected native tab before scrolling.
- 0814558: A click that may already have reached the page is no longer repeated. Upstream Camofox retried a slow click with a forced click and then a DOM click, so one request could act up to three times. Stelz now checks the target first without input and falls back only when that check fails. The click itself waits longer for the browser to confirm input, so a slow click completes instead of failing after 3 seconds. A failure after input returns a non-retryable error that asks for a fresh snapshot. The profile stays usable.
- 430512a: You can now set up Stelz by sending a coding agent a link to the browser skill and asking it to install the skill. The agent installs Stelz instead of copying the skill file, registers the tools, and opens the Stelz UI. Then it tells you the next steps: create and start a profile, and start a new agent session. Agent setup no longer creates a profile or runs a browser check. The README shows the one-line request.
  
  The browser skill is now one short procedure, with its recovery steps included. It links to the documentation for tool contracts, settings, and operator procedures, and the documentation links to the skill for agent behavior instead of repeating it.
- 50921eb: Tabs that a person opens in a profile browser now stay open. Upstream Camofox closed every page that it did not create within 60 seconds. Its orphan page reaper now closes only pages that Camofox created, registered, or tried to close.
- f3f59fb: The profile browser no longer flashes a blank window about every 2 minutes. Upstream Camofox's health probe opened and closed a test window while no agent acted. Stelz disables the probe, because it also cannot replace a browser.
- 32892cf: Start profiles with one blank window. Reuse the native startup page as the first MCP tab and remove the diagnostic health page.
  Run IP verification through the profile's private browser add-on without visible probe pages. Preserve proxy verification and fail-closed behavior.
- f4281c0: Move the pointer to the page center before scrolling, so a previous header click does not leave wheel input outside the feed.
- 2ab10dc: The setup question now gives the size, purpose, and source link of each download. With `--json`, each item of the `downloads` list has `name`, `size`, `purpose`, and `source`. Setup prints progress on stdout, and on stderr only with `--json`.
  The setup summary is now an aligned table with the source and status of each part, and links the agent setup guide.
  A dropped connection during a setup download now reports a connection error and keeps no partial file.
  When GitHub limits release requests, setup says so and names the time to try again.
- aac1d8c: The UI first-run screen, diagnostics, and errors now name `stelz setup` only. The agent skill reads readiness from the `profile_start` result and requires verification whenever `verificationRequired` is true. The install, bootstrap, and update guides use the new setup flow.
- aec4ac9: Enable the Camoufox cursor marker by default for new browser sessions.

## 0.4.0

### Minor Changes

- 3818391: Accept provider proxy URLs, shorthand credentials, and cURL examples during profile creation and network edits. Add masked previews, manual fields, and local proxy-list import to the UI. Preserve saved authentication during unrelated network changes.
- 35071ef: Replace profile-bound MCP registrations with one `stelz mcp` registration and 18 fixed tools.
  Agents can list, create, start, and control multiple profiles through explicit `profileId` arguments.
  Each acquisition returns a fresh `controlHandle` for that connection, profile, and browser lifetime.
  Control actions and all nine browser tools require both fields.
  
  The removed MCP `--profile` option returns migration guidance.
  Keep the same `STELZ_HOME`. Stop running profiles before `stelz setup`, then explicitly start each required profile.
  Profile IDs, saved data, and secret references remain unchanged. Profile-import `--profile` selectors remain supported.
  Update client examples, agent instructions, and UI snippets for the shared registration.

## 0.3.1

### Patch Changes

- 40dc963: Use the project logo in the local UI and README. Add a theme-aware favicon and reusable SVG assets.
- bd7164f: Organize documentation by task. Include the contributor guide and UI screenshot in the package, and check documentation links and images.
- bcfdda5: Remove the standalone third-party notices document from the release archive.

## 0.3.0

### Minor Changes

- Use current profile catalogs, native Firefox storage, and schema-2 fingerprint pins exclusively.
  Remove identity CLI/MCP aliases and checkpoint storage.

Changesets generates entries for releases after 0.2.1.
See [GitHub releases](https://github.com/souljorje/stelz/releases) for earlier release notes.
