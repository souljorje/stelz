# stelz

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
