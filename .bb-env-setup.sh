#!/usr/bin/env bash
# BB runs this in each new worktree. See CONTRIBUTING.md.
set -u
bun install --frozen-lockfile --ignore-scripts || exit 1
bunx lefthook install || echo "Lefthook did not install the Git hooks. Run bunx lefthook install." >&2
