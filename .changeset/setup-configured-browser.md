---
"stelz": patch
---

Setup offers to remove a `CAMOUFOX_EXECUTABLE` setting in `secrets.env` that selects a missing file or another build, and then uses its own copy of the paired browser. `--yes` accepts the offer. Before, setup failed with advice to run setup again.

The same setting in the process environment still fails. The error names the place of the setting and the two ways to continue.
