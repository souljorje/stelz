# stelz

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
