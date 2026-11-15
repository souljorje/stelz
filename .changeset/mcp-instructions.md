---
"stelz": patch
---

The server instructions of `stelz mcp` now match the new tools. They tell an agent to read the diff that each action returns. They also tell it to name elements by role and name, and to use `tab_wait` when the diff does not show an expected change yet. Before, they told an agent to read fresh snapshots. A client that gives the server instructions to its model shows the new text after the update.
