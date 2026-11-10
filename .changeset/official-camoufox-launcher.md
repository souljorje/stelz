---
"stelz": minor
---

Use the official Camoufox launcher instead of camoufox-js. To update from an earlier version, stop all running profiles before you install the new package. Then run `stelz setup` and start profiles explicitly.

Fingerprint checks now use the launcher's coherence rules. A saved macOS identity with an ANGLE renderer or another upstream contradiction blocks Start. The window-chrome rule only gives a warning.

Stelz now requires the paired Camoufox `156.0.1-beta.36`. Setup and Start reject other builds. A profile pinned to another build, such as 152, cannot start. Create a new profile instead.
Window sizes are no longer part of the saved identity. Startup checks them against the real window.
