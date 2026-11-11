---
title: "Typing"
description: "Typing modes, their selection order, and the time limits for browser actions."
tags: [configuration, reference, typing]
sources: []
created: 2026-11-06T13:49:16Z
modified: 2026-11-11T14:44:20Z
---

# Typing

Mode order: the `camofox_type` call's `mode`, the profile's `typingMode`, the service's `STELZ_TYPING_MODE` at launch, `keyboard`.

| Mode | Behavior |
| --- | --- |
| `balanced` | Paced typing when the estimated duration, including corrections, is at most 10 seconds. Longer input uses bulk entry. |
| `keyboard` | Variable keystroke timing and random pauses. Never uses bulk entry, even for long text. |
| `instant` | Playwright `fill()` enters the complete value. |

| Action | Limit | Service waits |
| --- | --- | --- |
| Click, navigation, scroll, snapshot, screenshot | 30 seconds | 60 seconds |
| One `camofox_type` call | 3 minutes | 3.5 minutes |

- Keyboard text that cannot finish within 3 minutes fails before the field changes. Use `balanced` or `instant`.
- A timeout blocks further actions. It needs an explicit stop and start of that profile. The service does not replay partially entered text.
- Typing replaces existing contents. Empty text clears the field. `auto` is not a valid mode.
