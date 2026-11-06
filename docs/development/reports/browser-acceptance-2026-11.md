# Browser acceptance: November 2026

This historical report preserves the November results and limits previously recorded in the development test guide.
It is not a test result for the current checkout or a release approval.
The source record did not identify an archive hash or source commit for every run.
Use [Testing](../testing.md) to reproduce checks against a named candidate.

## Environment recorded on 2026-11-02

The earlier browser acceptance run passed on local macOS 26.5.2 on Apple Silicon.
The recorded tools were Bun 1.4.4, Node.js 24.14.0, TypeScript 5.9.3, and Camoufox 152.0.4 beta.30.
The Camofox server dependency was npm version 1.18.1.
These are historical versions. They do not specify the current package version or prove another platform's browser behavior.

## Native measurements on 2026-11-03

Native measurement passed with Camoufox 152.0.4 beta.30 on macOS arm64.
Each of two profiles produced 18 complete samples across three explicit browser lifetimes.
Each lifetime contained two fresh documents with three sequential samples per document.
Required device properties and cookie, localStorage, and IndexedDB markers remained stable in those samples.

Each profile produced three canvas hashes, one per lifetime.
Canvas hashes matched within each lifetime. Each profile produced one audio hash across all samples.
Those observations did not extend the stability contract to canvas or audio hashes.

The measurement design recorded raw samples, unique values, incomplete probes, and differences within documents, within lifetimes, and across lifetimes.
It also recorded the browser engine hash, host environment, display observations, experiment recipe, and network policy.
The contract required unchanged saved device settings and persistent storage markers under the same recorded environment.
Selected device properties, including WebGL and WebGL2, had to match within that controlled experiment.

Canvas and audio hashes remained measured outputs.
Missing or failed probes could not establish stability.
A difference across lifetimes did not establish that a restart caused it.
Language and timezone followed current network policy.
A changed policy was separate from drift under unchanged conditions.
Observed stability applied only to the recorded environment and samples.
It did not establish future stability or website acceptance.

## Proxy evidence on 2026-11-03

An earlier proxy check used one shared endpoint.
That evidence did not establish distinct exits for separate profiles.
The later check required two distinct exits and repeated browser measurements.

Two-proxy acceptance passed with exits `206.220.14.4` and `198.135.34.88`.
Each exit remained unchanged across three browser lifetimes with three independent samples per lifetime.
Both relay interruptions prevented external requests while cached successful verification was less than one second old.
The other profile retained its own exit.
Explicit recheck blocked the failed route. Recovery preserved its browser lifetime.
Swapped IP pins blocked both profiles. Cleanup stopped all test browsers.

A separate live cache check ran 100 MCP tab-list actions per profile without refreshing verification.
Explicit recheck bypassed the two-minute cache. Both profiles stopped after that check.
This evidence measured observed behavior. It did not establish continuous IP stability or a host network kill switch.

## Window evidence on 2026-11-03

The previous test guide recorded passing window acceptance with both storage modes.
That description belongs to the historical run.
The current `test:windows` procedure creates two native profiles.
The old result does not establish additional current storage-mode support.

The documented checks covered title prefixes, unchanged page titles, page selection, controller preservation, and stale browser lifetimes.
Release and disconnect had to preserve windows.
Foreground restrictions required an incomplete result with explicit reasons, rather than a pass.

## Other recorded acceptance

The source record also described these successful checks without a separate run date:

- Human takeover used a manual click while paused, followed by resume in the original browser and tab.
- Codex-to-Hermes handoff used actual MCP tool calls in the same browser and tab.
  Hermes read the original storage marker, changed it, and released control.
  The browser lifetime and device pin remained unchanged.
  The check used temporary harness configurations and a working local model endpoint.
  Original configurations and approval policies remained unchanged.

Claude Code was not installed. That client remained untested in these checks.
These handoff results were separate from the [2026-11-05 onboarding run](onboarding-2026-11-05.md).

## Transfer evidence and remaining failure on 2026-11-05

Native transfer acceptance passed on macOS arm64.
The check used synthetic local data and isolated profiles.
It checked cookies, localStorage, IndexedDB, fingerprint bytes, a fresh access key, and window controls after import.
Its report location was `.state/profile-transfer/report.json`.

Broader validation found a 30-second `camofox_scroll` timeout with one set of saved fingerprints.
The same fingerprints reproduced the timeout on the pre-transfer baseline.
The version under test passed with the baseline fingerprints.
Successful ZIP transfer checks therefore did not establish complete browser acceptance.
The record did not resolve the timeout's cause.

## Documentation walkthrough on 2026-11-06

This run checked the reorganized documentation against the `0.3.0` service on local macOS ARM64.
It used a new disposable service directory and the host's existing runtimes and Camoufox executable.
It did not change operator profiles or global client configuration.

The operator followed the real UI flow to create `work` without a proxy and start its visible browser.
The UI reported Ready. A second disposable profile, `research`, remained stopped.
Codex then used a temporary stdio connection to the selected `work` profile.
Its actual MCP tools acquired control, opened the local onboarding page, read a snapshot, and clicked the observed button once.
The page reported `Stelz verified`, with the count increasing from 12 to 13.
Release and reacquisition preserved that page, count, and browser lifetime. The final release kept the browser open.
The operator stopped only the disposable browser after recording the result.

The installed Codex CLI needed a temporary model-catalog compatibility copy before verification could run.
The copy supplied two missing capability flags for its reviewer and selected the standard transport for the configured model and reviewer.
Approval review and sandbox protections remained enabled. Global catalog and configuration files stayed unchanged.
The first interaction attempt recorded an unexplained counter change after reacquisition.
A later attempt found the disposable browser stopped. Those attempts did not pass the complete verification procedure.
The final check used a separate local demonstration tab and passed.

The README screenshot shows the real manager with disposable `work` and `research` profiles.
It contains no generated interface or private browsing data.
Private command logs, MCP results, and source captures remain under `.state/docs-reorg/`.

Claude Code was unavailable. Hermes registration followed its official documentation but did not receive a live check in this run.
This result does not establish fresh-OS installation, browser download, proxy acceptance, or verification through every supported client.

## Interpretation and evidence limits

Saved device settings do not guarantee identical observable fingerprints.
Browser executable changes require an explicit migration.
No recorded test established that websites cannot detect automation.
Public detector procedures and their pass conditions are documented in [Testing](../testing.md#public-fingerprint-checks).
This record contains no blanket public-detector pass claim.

Local evidence locations described by the test procedures included:

| Evidence | Location |
| --- | --- |
| Native samples | `.state/native-acceptance-*/report.json` |
| Proxy observations and route failures | `.state/proxy-acceptance-*/report.json` |
| Window checks | `.state/profile-windows-*/report.json` |
| Human takeover | `.state/manual-acceptance-*/report.json` |
| Transfer checks | `.state/profile-transfer/report.json` |

These paths identify local artifacts. This Markdown report does not embed their raw contents or establish their continued availability.
Keep credentials, browser data, and private artifacts outside Git.
