---
"stelz": patch
---

The profile browser no longer flashes a blank window about every 2 minutes. Upstream Camofox's health probe opened and closed a test window while no agent acted. Stelz disables the probe, because it also cannot replace a browser.
