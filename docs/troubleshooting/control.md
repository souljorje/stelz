---
title: "Control problems"
description: "Recovery when a control handle is missing or stale, or when a profile stays paused."
tags: [troubleshooting, agent, mcp]
sources: []
created: 2026-11-06T13:49:16Z
modified: 2026-11-11T14:55:54Z
---

# Control problems

## Missing or stale control handle

1. Call `profile_status({profileId})`. Check whether the browser stopped, restarted, or changed controller.
2. Another client holds control: ask it to call `profile_release({profileId, controlHandle})`. For an operator handoff, run `stelz release work` or select **Release** in the UI and confirm. Make sure that live status shows `controller: null`.
3. Start a stopped browser explicitly.
4. Call `profile_acquire({profileId})` on the intended connection. Keep the new `controlHandle` with that profile ID.

- Handle lost: arrange an operator release and reconnect the client.
- Other rules: see [Control handles](../mcp.md#control-handles).

## Profile is paused

1. Find the window: [Find a profile's windows](../ui.md#find-a-profiles-windows).
2. Complete authentication or manual work in that window.
3. Run `stelz resume work` or call `profile_resume({profileId, controlHandle})`.
4. Make sure that `phase` is `"ready"`.

- Resume fails verification: see [IP verification failed](network.md#ip-verification-failed).
- Release does not resume a paused profile.
