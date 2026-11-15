---
title: "Typing"
description: "Typing modes, their selection order, and the time limits for browser actions."
tags: [configuration, reference, typing]
sources: []
created: 2026-11-06T13:49:16Z
modified: 2026-11-11T15:01:55Z
---

# Typing

Mode order:

1. The `tab_type` call's `mode`.
2. The profile's `typingMode`.
3. The service's `STELZ_TYPING_MODE` at launch.
4. `keyboard`.

| Mode | Behavior |
| --- | --- |
| `balanced` | Paced typing when the estimated duration, including corrections, is at most 10 seconds. Longer input uses bulk entry. |
| `keyboard` | Variable keystroke timing and random pauses. Never uses bulk entry, even for long text. |
| `instant` | Playwright `fill()` enters the complete value. |

| Action | Limit | Service waits |
| --- | --- | --- |
| Click, navigation, scroll, snapshot, screenshot | 30 seconds | 60 seconds |
| One `tab_type` call | 3 minutes | 3.5 minutes |
| One `tab_wait` call | Its `timeout`. Default 10 seconds. Maximum 60 seconds. | The limit plus 30 seconds |
| `tab_click`, `tab_type`, `tab_select`, or `tab_press` with `observe` `diff` (the default) | The limit above, then 15 seconds for the read of the page | The limit above plus 30 seconds, then 15 seconds for the read |
| `tab_wait` with `target` or `contains` | Its `timeout` plus 15 seconds for the last poll | The limit plus 30 seconds |
| One `tab_evaluate` call | Its `timeoutMs`. Default 30 seconds. Maximum 120 seconds. | The limit plus 30 seconds |

- Keyboard text that cannot finish within 3 minutes fails before the field changes. Use `balanced` or `instant`.
- The read of the page after an action has its own limit of 15 seconds. If the read passes it, the call still succeeds with a note, and further actions stay blocked for that lifetime. See [Observe](../mcp.md#observe).
- A timeout returns a terminal error without a retry instruction. Further actions stay blocked for that lifetime. The service does not replay partially entered text. Recovery: [Browser action or IP check timed out](../troubleshooting/lifetime-and-state.md#browser-action-or-ip-check-timed-out).
- A client timeout does not cancel the service operation. Set client tool timeouts above the service wait: see [Connect your agent](../clients.md).
- Typing replaces existing contents. Empty text clears the field. `auto` is not a valid mode.
