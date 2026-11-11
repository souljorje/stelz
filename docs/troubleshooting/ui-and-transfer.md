---
title: "UI and transfer problems"
description: "Recovery when the UI session, a browser window control, or a profile transfer fails."
tags: [troubleshooting, ui, transfer]
sources: []
created: 2026-11-06T13:49:16Z
modified: 2026-11-11T14:44:20Z
---

# UI and transfer problems

| Symptom | Next action |
| --- | --- |
| UI refuses an old session URL (token consumed, or cookie from another UI session) | Reload the authenticated browser. If unavailable, end only the UI command and run `stelz ui --open`. |
| UI port `9380` is occupied | Use the existing UI, or run `stelz ui --port 9381 --open`. Leave the unknown listener intact. |
| Show window fails (page closed, lifetime changed, or activation failed) | Select a fresh entry in **Browser windows**. On macOS, select that browser manually, then retry. |
| Transfer rejects active profiles (running, unclean, or unknown ownership) | Stop only the export profiles. Inspect unclean lifetimes first. |
| Import rejects compatibility (OS, architecture, or executable hash differs) | Use a matching destination. Do not edit the manifest. |
| Catalog changed during import preview, or export output exists | Reload the preview and review the mappings, or use a new output filename. |
| `too_large`, size or entry limit, or insufficient disk | Free disk space or select fewer profiles. Change [transfer limits](../configuration/archive.md) before a new session if appropriate. |

See [Transfer profiles](../profile-transfer.md).
