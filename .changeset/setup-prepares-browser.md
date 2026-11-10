---
"stelz": minor
---

`stelz setup` now prepares the paired Camoufox build itself. It reuses its own copy in `STELZ_HOME/browsers/`, clones the paired install from the upstream Camoufox cache, or downloads the release and verifies its published SHA-256 digest. `CAMOUFOX_EXECUTABLE` is now an optional override, and it must name the paired build.
