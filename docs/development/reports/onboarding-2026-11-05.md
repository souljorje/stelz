# Onboarding acceptance: 2026-11-05

This historical report preserves one assisted Codex onboarding run.
It does not validate the current package, public installation path, or another client.
Use [Agent onboarding acceptance](../testing.md#agent-onboarding-acceptance) for the reproducible procedure.
Use [Bootstrap](../../bootstrap.md) for current installation orchestration.
Use [Client verification](../../clients.md#verify-the-connection) for registration and the actual-tool check.

## Environment and candidate

The assisted check passed on local macOS ARM64.
The host supplied Bun 1.4.4, Node.js 24.14.0, npm 11.16.0, and a compatible Camoufox executable.
The target client was Codex CLI 0.142.4.
The agent read a local bootstrap document and installed the supplied Stelz 0.2.0 archive into a temporary npm prefix.
Version `0.2.0` identifies this historical candidate only.
The archive SHA-256 was `17cdaa57f05f47060a33afe9b8502537fd65de06f30a3256bf8d68b7c339dd94`.

## Observed states

| State | Observed result |
| --- | --- |
| Installed | The fresh agent installed the archive with lifecycle scripts enabled, initialized an empty service directory, and prepared the runtime. |
| Browser ready | The agent created native profile `work` on port 9377. Start and doctor confirmed the running service and owned processes. |
| Client configured | The agent installed a symlink to the canonical skill and a project MCP entry. Global client configuration remained unchanged. |
| Verified | A fresh Codex session acquired control, opened the local fixture, read snapshots, clicked the observed reference, and checked the result. |

The first session reported **Verified: pending** because it lacked the newly registered tools.
The next session used actual `stelz-work` MCP tools.
An SDK probe did not replace browser interaction.
After release, status reported `ready` with no controller.
Reacquisition returned the same page and result.

## Repeated onboarding and reuse

The agent repeated initialization, profile creation, and startup.
Creation returned `created: false`.
The profile ID, port, native storage, catalog hash, and secret-file hash remained unchanged.
The browser instance remained `2211f6d7-15e5-4225-8f1d-01956bc44233`.
The fixture tab remained `086c8d6a-e9f9-4f10-9bbc-13a4d90171ef`.
Its persistent count increased from 1 to 2 after a second observed click.
The final release left the same browser ready with no controller.

After recording that evidence, the operator stopped only the temporary `work` profile.
The fixture server stopped separately.
The test retained native profile data for inspection.

## Required interventions

- The installed Codex CLI initially rejected the user's model catalog before the agent could start.
  The operator supplied a temporary compatible catalog through a session-only flag.
  That copy supplied missing model capability fields and disabled an incompatible optional response transport.
  The global catalog, authentication, sandbox, and approval settings remained unchanged.
  This assistance prevents a claim of fully unattended onboarding on that host.
- The first sandboxed desktop browser launch aborted.
  The agent inspected ownership, stopped only the failed test lifetime, and requested normal launch permission.
  The approved launch succeeded.
  Protected project skill and MCP directories also required normal permission escalation.
  Stopping the temporary fixture required scoped permission.
- The operator started a fresh Codex session after registration.
  The first session supplied exact connection arguments and a checkpoint.
- The local fixture required no website authentication or new credentials.

## Automated checks recorded with the run

The implementation checks passed: 484 Bun tests, 97 Node regression tests, typecheck, build, and isolated release verification.
Those counts describe the recorded revision only.
CLI checks covered direct and proxy creation, environment input, reuse, concurrent creation, interrupted transactions, conflicts, redaction, and unsafe files.
Catalog, lifecycle, and MCP checks covered port allocation, rollback, exclusive control, and browser survival after disconnect.
The release verifier checked the installed CLI and bundled onboarding resources outside the source checkout.
Automated coverage did not replace the agent's registered-tool evidence.

## Scope and limitations

The check used a fresh package prefix, service directory, and project configuration.
It reused host dependencies and the browser executable.
It did not establish installation on a fresh operating system or exercise missing-dependency download paths.
The public bootstrap URL and npm release path were not inputs to this development run.
The report therefore contains no acceptance evidence for those public paths.

The previous record described Claude Code and Hermes setup paths as based on their official documentation.
It also recorded directory-symlink support in the installed Hermes skill loader.
Neither client completed this onboarding run. Claude Code was unavailable.
Separate [browser handoff evidence](browser-acceptance-2026-11.md#other-recorded-acceptance) does not establish complete Hermes onboarding.
Proxy creation, conflicts, and interrupted transactions passed automated CLI checks.
This agent run used direct networking.

The recorded evidence locations were `.state/onboarding-acceptance/` and the temporary acceptance project.
These are local artifact locations. This report does not establish their continued availability.
Keep private test data and credentials outside Git.
