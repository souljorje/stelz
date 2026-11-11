---
title: "Profile archive format"
description: "Contents, compatibility rules, and size limits of profile transfer archives."
tags: [configuration, reference, transfer]
sources: []
created: 2026-11-06T13:49:16Z
modified: 2026-11-11T14:44:20Z
---

# Profile archive format

- Format: ZIP (ZIP64 supported) with a UTF-8 `manifest.json`.
- No encryption. Encrypted ZIP entries are unsupported.

| Manifest field | Format |
| --- | --- |
| `format`, `version` | `"stelz-profiles"`, `1`. |
| `createdAt`, `source` | UTC ISO timestamp. `stelzVersion`, `platform`, `arch`, and lowercase SHA-256 `engineSha256`. |
| `profiles` | Nonempty array of portable records: `id` and `storage: "native"`, plus optional `name`, `typingMode`, `proxy`, `expectedIp`. |
| `directories`, `files` | Relative directory paths. `{ path, size, sha256 }` records with nonnegative safe-integer sizes. |

- `proxy` absent: direct. `proxy: { "url": "..." }`: proxy URL and credentials. `proxy: {}`: proxy intent without credentials. Import assigns a secret reference without a value. Start stays blocked until you configure the proxy.
- `expectedIp`: literal address or empty string.
- Per profile: `fingerprint.json`, `native-profile.json`, `browser-data/` (without root locks `.parentlock`, `parent.lock`, `lock`), `cookies/`, `uploads/`. Excluded: runtime records, keys, logs, add-ons, traces, temporary files, the executable, global settings, client configuration.
- Import rejects unsafe paths, links, special files, duplicate paths, undeclared entries, invalid sizes, and failed hashes.
- Import needs the same operating system, CPU architecture, and exact local executable SHA-256. It does not migrate storage or browser versions.

| Limit | Default | Override (process environment) |
| --- | --- | --- |
| Compressed archive | 10 GiB | `STELZ_TRANSFER_ARCHIVE_BYTES` (bytes) |
| Expanded data, including the manifest | 10 GiB | `STELZ_TRANSFER_EXPANDED_BYTES` (bytes) |
| Entries, including `manifest.json` | 100,000 | `STELZ_TRANSFER_ENTRIES` |
| Manifest | 64 MiB | `STELZ_TRANSFER_MANIFEST_BYTES` (bytes) |
| Each `native-profile.json`, each `fingerprint.json` | 64 KiB, 16 MiB | None |
| Service secrets file after import | 1 MiB | None |

- Override: decimal integer from `1` through `9007199254740991`, no leading zeros. Set it before a CLI transfer or UI start.
- Inactive UI transfers expire after 30 minutes. An active import does not expire during commit.
