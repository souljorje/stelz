---
"stelz": minor
---

Upgrade Camoufox to launcher 0.5.9 and browser 158.0.1-beta.41. Start uses the prepared model and derives display and GPU preferences from the saved identity.

Use upstream canvas placeholders to prevent a separate GPU probe browser. Canvas/WebGL readback returns random data, and WebGPU cannot expose the host adapter.

Existing profiles retain their engine checks. Profiles pinned to an earlier executable cannot start with the new engine.
