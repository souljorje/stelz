# Import and export profiles

Use a `.stelz-profiles.zip` archive to move one or more profiles between matching installations.
The archive includes saved browser data, device settings, typing preferences, and available proxy credentials.
It is not encrypted. Keep it private because saved browser data can contain active login sessions.
Initialize the destination with `stelz init`. Both installations need the matching Camoufox executable.

## Use the UI

Stop the profiles cleanly before export. Export never stops a browser automatically.
Open **Profiles**, select **Export**, and select the profiles to include.
Use **Select all stopped** to select every eligible profile.
Download the archive when preparation completes, then close the dialog.
A stopped profile also has an export action in its details.

Select **Import** and choose the ZIP archive.
Review the profiles and their proposed IDs and display names. Select the profiles to import.
Select **Import N**, where `N` is the selected count, to save the batch.
The new profiles remain stopped until you start them explicitly.

If an ID already exists, import proposes `ID-copy`, then `ID-copy-2`, and so on.
Existing profiles and their data stay unchanged.
A profile whose proxy credentials were unavailable at export remains blocked until you configure its proxy.
It never changes to a direct connection automatically.

The dialog reports transfer progress. Select **Cancel** to remove temporary files before you import profiles.
During import, wait for the result. Turning off the UI is unavailable during an active transfer.
Reloading the page restores an active transfer in the same UI session.
If an upload needs the file again after reload, choose the ZIP again or cancel the transfer.
A new UI server starts a new transfer session.

## Use the CLI

```sh
stelz profile export work personal --output ./profiles.stelz-profiles.zip
stelz profile export --all --output ./all-profiles.stelz-profiles.zip
stelz profile import ./profiles.stelz-profiles.zip
stelz profile import ./profiles.stelz-profiles.zip --profile work --rename work=work-laptop
```

Export refuses an existing output file. Use another filename.
`--all` includes every configured profile. Every selected profile must be cleanly stopped.
Repeat `--profile SOURCE_ID` to import a subset. Omit it to import the complete archive.
Repeat `--rename SOURCE_ID=NEW_ID` to select explicit unused destination IDs.
Add `--json` for structured results. Results contain profile mappings and do not include credentials.
The destination service assigns new loopback ports and private secret references.
Export saves the effective typing mode, including a mode inherited from the source service.
Import saves that mode as a profile preference.

## Compatibility and saved data

Import requires the same operating system, CPU architecture, and exact Camoufox executable SHA-256.
Export also checks saved fingerprints against the local executable.
Stelz does not migrate browser versions or storage modes during import.
Profile archives contain native Firefox data.

The ZIP64-compatible archive contains a versioned `manifest.json` and SHA-256 hashes for its files.
Native browser data remains intact, including SQLite sidecar files.
The archive includes saved cookie inputs and reusable uploads.
Export omits service files, including process records, `access-key`, logs, and temporary files.
It also omits native browser lock files at the root of `browser-data/`.
The archive contains neither the browser executable nor global service or client configuration.

Import checks the archive before it changes the profile catalog.
It rejects unsafe paths, links, unsupported entry types, duplicate entries, and failed file hashes.
Import installs the data and secrets, then publishes the selected batch in one catalog update.
An interrupted commit leaves a private journal. The next configuration operation or explicit start completes recovery.
Read-only status does not change the journal. Conflicting manual edits require inspection.
The private journal is `STELZ_HOME/.profile-import-transaction.json`.
Run `stelz doctor ID` to inspect a pending import.
Keep its journal and staging directories while recovery is pending.

## Transfer limits

Archives and expanded profile data each have a default limit of 10 GiB.
The default entry limit is 100,000. The manifest limit is 64 MiB.
Set these environment variables before starting the UI or CLI to change the transfer limits:

| Variable | Unit |
| --- | --- |
| `STELZ_TRANSFER_ARCHIVE_BYTES` | Compressed archive bytes |
| `STELZ_TRANSFER_EXPANDED_BYTES` | Expanded file bytes |
| `STELZ_TRANSFER_ENTRIES` | ZIP entries |
| `STELZ_TRANSFER_MANIFEST_BYTES` | Manifest bytes |

Use positive integers. These limits apply to each transfer, not to the saved-profile count.
Allow free disk space for the archive, the extracted data, and the staged import or export snapshot.
Inactive UI transfer files expire after 30 minutes. Finish or cancel a transfer before turning off the UI.
