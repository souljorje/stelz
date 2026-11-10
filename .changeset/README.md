# Changesets

Add a changeset for each change that needs a package release:

```sh
bun run changeset
```

Select `stelz`, choose the version increment, and describe the user-visible change.
Commit the generated Markdown file with the implementation.
Tests and internal tooling alone do not require a package release.

The release workflow updates one version PR from these files.
See [Release Stelz](../docs/development/releasing.md) for the complete procedure and agent instructions.
