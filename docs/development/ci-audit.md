# CI audit — 18 November 2026

Compare `chore/simplify-tests` at `7ff3f88` with candidate `0661b2a`, not with `main`.
The baseline already runs the full suite in CI and pre-push checks. Keep that policy because subprocess dependencies make affected selection uncertain.

## Findings and changes

[Vincent Koc's article](https://vincent.build/openclaw-ci-cost-reduction/) distinguishes feedback time from compute use and warns against incomplete dependency evidence.
The [linked OpenClaw implementation](https://github.com/openclaw/openclaw/blob/a7d05c7af04aa17ac57c994da238d0c60f058ca6/.github/workflows/ci.yml) includes scope planning, cache trust, and a large runner matrix.
Stelz has two short Linux jobs. Its measured workload does not justify that orchestration, learned selection, a typechecker migration, or more shards.

The archive job runs two independent installations sequentially. Each installation already has its own prefix and service home.
`test:install --both` runs them concurrently against the same archive and waits for both. Either failure fails the command.
CI and Release use this option. Existing single-mode commands remain available.

The change preserves both PR status names, all tests, native validation, release permissions, and validation of the exact publication archive.
It does not change runner size, dependency caches, release scheduling, or production code.

## Measurements

Sources: [baseline run 44271728495](https://github.com/souljorje/stelz/actions/runs/44271728495) and [candidate run 44272645723](https://github.com/souljorje/stelz/actions/runs/44272645723).
Use only complete, successful attempts in this comparison. GitHub attempt numbers are explicit below.

| Metric | Baseline 3 | Baseline 4 | Candidate 1 | Candidate 2 |
| --- | ---: | ---: | ---: | ---: |
| Workflow feedback | 68 s | 81 s | 65 s | 70 s |
| Sum of runner durations | 108 s | 115 s | 106 s | 107 s |
| Build and tests job | 45 s | 66 s | 61 s | 63 s |
| Packed archive job | 63 s | 49 s | 45 s | 44 s |
| Installation steps, combined | 34 s | 28 s | 11 s | 21 s |

Each attempt runs 876 tests: 875 pass and one existing platform-specific case is skipped.
Both installation modes pass, including SQLite and Impit checks under Node.
All compared installations use this identical archive SHA-256:

```text
a0b4792bddedfb69b1e55ea385304565731498dfd09c15efcf9076aa3ef13a9f
```

Mean installation time falls from 31 to 16 seconds. Mean package-job time falls from 56 to 44.5 seconds, about 21%.
Mean runner use is 111.5 versus 106.5 seconds, about 4.5% lower. Mean feedback is 74.5 versus 67.5 seconds.
Two attempts per revision cannot establish a durable speedup or change in flakiness.
Cache restoration, runner contention, and network latency vary. No total-feedback speedup is established by these observations.

## Method and limits

Feedback is each attempt's `updated_at - run_started_at`, including queue and workflow completion overhead.
Runner use is the sum of current-attempt job durations. It is not CPU utilization or billed minutes.
Check each job's `run_attempt` before summing. A partial rerun can include a successful job from an earlier attempt.

```sh
gh api repos/souljorje/stelz/actions/runs/RUN/attempts/ATTEMPT
gh api repos/souljorje/stelz/actions/runs/RUN/attempts/ATTEMPT/jobs
gh api repos/souljorje/stelz/actions/runs/RUN/attempts/ATTEMPT/logs > /tmp/ci-logs.zip
```

Baseline attempt 1 failed because GitHub rate-limited a setup release request. Attempt 2 reran only the package job.
Together they used 155 runner-seconds and took 156 seconds from the first start to the successful retry, including the retry gap.
They are excluded from the complete-run table, not hidden as successful full runs. Parallel installation does not remove this network dependency.

Standard hosted runners are [free for public repositories](https://docs.github.com/en/actions/concepts/billing-and-usage). Stelz's runner charge remains $0.
Storage and other services are outside this measurement. Do not report the article's dollar savings as Stelz savings.

## Verification and follow-up

- Both candidate CI attempts pass the full suite and both archive installation modes.
- Missing archives and conflicting `--both --native` flags return a nonzero exit status.
- Actionlint 1.7.12 validates the workflows. Normal hooks remain active.
- No publication or live-browser workflow runs for this audit. The release installation command uses the same verified runner entrypoint.

Keep the small installation change. Defer broader caches and job suppression until they have measured benefits and explicit dependency boundaries.
The observed rate-limit failure makes verified prerequisite reuse worth a separate experiment. Preserve freshness, integrity, and isolated-install coverage before adopting it.

## Vite build follow-up

`vite build` reads `vite.config.ts` and builds the Node plugin, UI, and theme bootstrap concurrently after `dist/` is cleared once.
It replaces both build scripts. The plugin keeps its single ESM file, runtime dependencies, and exports. The theme script stays blocking and external.
Dependency validation, archive packaging, and Changesets remain unchanged. No dependency is added.
The configuration uses Vite's experimental multi-environment builder API. Vite remains pinned to 8.3.6.

Three warm local builds before this change took 193/194/193 ms; afterward, 236/233/237 ms.
The CLI adds about 42 ms locally. This change consolidates build tooling; it does not establish a speedup or lower CI compute use.
These local measurements compare the build follow-up with `54b38e5`; the CI installation comparison above uses its stated revisions.
