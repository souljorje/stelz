---
"stelz": minor
---

One module now sets every browser action limit. `camofox_type` can take up to 3 minutes, instead of 45 seconds. Clicks, navigation, scrolls, snapshots, and screenshots keep their 30-second limit. Keyboard text that cannot finish in time fails before the field changes. Long tool calls send MCP progress notifications every 10 seconds when the client requests them. Set Codex `tool_timeout_sec` and the Hermes `timeout` to 240 seconds or more.

Typos and their corrections no longer apply to fields with a length limit, one-time-code entry, a numeric or similar input mode, live suggestions, search inputs, or rich editors.
