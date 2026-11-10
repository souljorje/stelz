# Transfer profiles

Use a `.stelz-profiles.zip` archive to move saved profiles between matching installations.
Use [the local UI](ui.md) for selection and an import preview.
The examples move the `work` profile.

## Before transfer

- Keep the same `STELZ_HOME` for each installation's CLI and UI.
- Prepare the destination through [Getting started](getting-started.md).
- Require the same operating system and CPU architecture on both installations.
- Require the exact same Camoufox executable SHA-256, not only the same browser version label.
- Allow disk space for the ZIP, expanded data, and the staged snapshot or import batch.

Compare these results on both machines. Replace the executable path with each installation's configured Camoufox path:

```sh
uname -s
uname -m
shasum -a 256 /absolute/path/to/camoufox
```

The archive contains saved logins, device settings, typing preferences, cookie inputs, uploads, and available proxy credentials.
It does not contain Camoufox, global service settings, or client registrations.
Import does not migrate browser versions or storage modes.
See [Archive schema and limits](configuration.md#archive-schema-and-limits) for format details and configurable limits.

## Export from the UI

1. Select `work` in **Profiles**.
2. Select **Stop**. Wait for **Stopped**.
3. Run `stelz doctor work` if clean shutdown or process ownership is uncertain.
4. Resolve an unclean lifetime through [Recovery](troubleshooting.md#inspect-an-unclean-lifetime) before export.

**Warning:** The ZIP is unencrypted. It includes saved login sessions and available proxy secrets. Store and transfer it privately.

5. Return to **Profiles**. Select **Export** in its heading.
6. Select `work`, then select **Export 1**.
7. Wait for **ZIP ready**. Select **Download ZIP** and save the file.
8. Close the transfer dialog after the download.

For a batch, select the required stopped profiles before selecting **Export N**.
**Select all stopped** selects eligible profiles only.
**Export ZIP** in a stopped profile's details exports that profile directly.
Export never stops browsers automatically.

## Import into the destination UI

Before import, require the same OS, CPU architecture, and exact Camoufox executable SHA-256 as the source.
Configure that matching executable on the destination before continuing.
The import preview checks compatibility and refuses a mismatch.

1. Run `stelz ui --open` with the destination's service directory.
2. Select **Import** in **Profiles**.
3. Choose the saved ZIP archive.
4. Review the compatibility result, proposed profile IDs, display names, and proxy warnings.
5. Select the profiles to import. Adjust destination IDs or display names if necessary.
6. Select **Import N** and wait for completion.
7. Check the reported source-to-destination mappings.
8. Start the imported profile explicitly with its reported destination ID when ready.

If an ID exists, import proposes `ID-copy`, then `ID-copy-2`, and later available names.
Existing profiles stay unchanged. The destination assigns available loopback ports and new private secret references.
Use the reported destination ID for later CLI commands and MCP `profileId` arguments.
Call `profile_list({})` through the existing shared registration to discover imported profiles.
Import requires no new MCP registration.

Imported profiles remain stopped.
If the source proxy credentials were unavailable, configure the imported profile's proxy before starting it.
It retains proxy intent and never changes to direct networking automatically.
Check the started profile with `stelz doctor ID`, then follow [Client verification](clients.md#verify-the-connection).

## Export from the CLI

Stop only the profiles selected for export. Check `stelz doctor work` if ownership or shutdown is uncertain.
Choose a new output filename because export refuses an existing file.

**Warning:** The ZIP is unencrypted. It includes saved login sessions and available proxy secrets. Store and transfer it privately.

```sh
stelz profile export work --output ./work.stelz-profiles.zip
```

For an advanced batch, add a second stopped profile such as `research` after `work`. Choose a separate output filename.

`--all` selects the complete catalog. Every selected profile must be cleanly stopped.
See [CLI transfer options](cli.md#profile-transfer) for `--all` and structured output.

## Import from the CLI

Before import, require the same OS, CPU architecture, and exact Camoufox executable SHA-256 as the source.
Run `stelz setup` on the destination before continuing.

```sh
stelz profile import ./work.stelz-profiles.zip
```

The result reports the destination ID. Import creates a copy when the original ID is occupied.
To select a source profile and require an unused destination ID:

```sh
stelz profile import ./work.stelz-profiles.zip --profile work --rename work=work-laptop
```

Repeat `--profile` to select a subset. Omit it to select the complete archive.
Repeat `--rename` for selected source IDs. Each destination ID must be unused.
Add `--json` for structured mappings and errors. Results do not contain credentials.
Start the reported destination profile explicitly after import.

## Interrupted transfers and failures

Select **Cancel** before import to remove that transfer's temporary files.
During import, wait for completion. Turning off the UI is unavailable during an active transfer.
Reloading restores an active transfer in the same UI session.
If the upload needs the file again, choose the ZIP again or cancel the transfer.
A new UI server starts a new transfer session.

| Failure | Next action |
| --- | --- |
| Profile is active or unclean | Stop selected profiles cleanly. Inspect uncertain ownership before recovery. |
| Compatibility mismatch | Use a destination with the same OS, architecture, and exact executable hash. |
| Output file exists | Choose another filename. |
| Size limit or insufficient disk | Select fewer profiles or free disk space. Read [transfer limits](configuration.md#archive-schema-and-limits) before changing overrides. |
| Catalog changed during preview | Reload the import preview. Review the proposed mappings again. |
| Import journal is pending | Preserve its journal and staging data. Follow [transaction recovery](troubleshooting.md#configuration-save-or-import-is-pending). |

Read-only diagnostics do not complete a pending import.
Check the catalog after recovery before importing again. The original batch may already be present.
For implementation details, see [Architecture](development/architecture.md) and [Testing](development/testing.md).
