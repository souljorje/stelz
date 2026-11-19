---
"stelz": patch
---

Setup replaces a configured browser that is not the paired build. When `CAMOUFOX_EXECUTABLE` in `secrets.env` selects another build or a missing file, setup names the installed and the required version and asks. After a yes, or with `--yes`, it installs the paired build and removes the setting. Before, setup failed with advice to run setup again.

The same setting in the process environment still fails. The error tells you to unset it.
