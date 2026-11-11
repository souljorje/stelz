---
title: "Transfer profiles"
description: "Export profiles to a ZIP archive and import them on a matching installation, in the UI or the CLI."
tags: [profile, transfer]
sources: []
created: 2026-11-05T20:23:02Z
modified: 2026-11-11T14:27:18Z
---

# Transfer profiles

Archive: `.stelz-profiles.zip`. Examples move `work`. Contents and compatibility rules: [Archive schema and limits](configuration.md#archive-schema-and-limits).

## Before transfer

- Prepare the destination: [Getting started](getting-started.md).
- Keep the same `STELZ_HOME` for each installation's CLI and UI.
- Operating system, CPU architecture, and exact Camoufox executable SHA-256 must match on both installations. The import preview refuses a mismatch.
- Disk space: the ZIP, expanded data, and the staged snapshot or import batch.
- Stop every exported profile cleanly. Export never stops a browser. Uncertain shutdown or ownership: run `stelz doctor work`, then see [Inspect an unclean lifetime](troubleshooting.md#inspect-an-unclean-lifetime).

Compare these results on both machines. Use each installation's configured Camoufox path:

```sh
uname -s
uname -m
shasum -a 256 /absolute/path/to/camoufox
```

**Warning:** The ZIP has no encryption. It includes saved login sessions and available proxy secrets. Store and transfer it privately.

## Export

In the UI:

1. Select `work` in **Profiles**, then **Stop**. Wait for **Stopped**.
2. Select **Export** in the **Profiles** heading. Select `work`, then **Export 1**.
3. Wait for **ZIP ready**. Select **Download ZIP**.

- Batch: select several stopped profiles, or **Select all stopped**.
- **Export ZIP** in a stopped profile's details exports that profile.

In the CLI, use a new output filename. Export refuses an existing file.

```sh
stelz profile export work --output ./work.stelz-profiles.zip
```

Batch: add more stopped profile IDs. See [CLI transfer options](cli.md#profile-transfer) for `--all` and structured output.

## Import

In the UI, with the destination's service directory:

1. Run `stelz ui --open`. Select **Import** in **Profiles**, then choose the ZIP.
2. Review the compatibility result, proposed profile IDs, display names, and proxy warnings.
3. Select the profiles. Adjust destination IDs or display names if necessary.
4. Select **Import N**. Wait for completion. Check the reported source-to-destination mappings.

In the CLI, run `stelz setup` on the destination first.

```sh
stelz profile import ./work.stelz-profiles.zip
stelz profile import ./work.stelz-profiles.zip --profile work --rename work=work-laptop
```

- `--profile`: repeat to select a subset. Omitted: the complete archive.
- `--rename`: repeat for selected source IDs. Each destination ID must be unused.
- `--json`: structured mappings and errors. Results omit credentials.

After import:

- An existing ID: import proposes `ID-copy`, then `ID-copy-2`, and later names. Existing profiles stay unchanged.
- Use the reported destination ID in CLI commands and MCP `profileId` arguments. `profile_list({})` lists imported profiles. No new MCP registration.
- Imported profiles stay stopped. Start explicitly, then run `stelz doctor ID` and [Verify the connection](clients.md#verify-the-connection).
- Source proxy credentials unavailable: configure the proxy before you start. The profile never changes to direct networking automatically.

## Interrupted transfers

- **Cancel** before import removes the transfer's temporary files.
- During import, wait for completion.
- Reload restores an active transfer in the same UI session. A new UI server starts a new session.
- The upload needs the file again: choose the ZIP again, or cancel.
- Active profile, compatibility mismatch, or size limit: [UI session, window, or transfer fails](troubleshooting.md#ui-session-window-or-transfer-fails).
- Pending import journal: [Configuration save or import is pending](troubleshooting.md#configuration-save-or-import-is-pending).
