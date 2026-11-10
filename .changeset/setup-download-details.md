---
"stelz": patch
---

The setup question now gives the size, purpose, and source link of each download. With `--json`, each item of the `downloads` list has `name`, `size`, `purpose`, and `source`. Setup prints progress on stdout, and on stderr only with `--json`.
The setup summary is now an aligned table with the source and status of each part, and links the agent setup guide.
