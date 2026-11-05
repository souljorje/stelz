# Onboarding acceptance

## Reproduce the agent check

Use local macOS ARM64 with a signed-in coding agent. Keep its existing approval protections.
Build and pack a release candidate. Give a fresh agent only the bootstrap document, candidate archive, a new writable test directory, and this request:

> Follow the bootstrap document. Install this archive into the supplied test prefix, use the supplied temporary STELZ_HOME, and create or reuse profile work. Install the canonical skill in this test project's supported location. Preserve global client configuration. Configure a project-scoped MCP connection if supported, otherwise write the exact connection arguments for a new session. Verify through your actual browser tools. Report Installed, Browser ready, Client configured, and Verified separately. Do not claim unavailable tools work. Leave the browser running after release.

Record the agent's actions, errors, and intervention requests. A model must perform the browser interaction through its registered MCP tools.
An SDK script can inspect the resulting state but cannot replace that evidence.
If tools require a new session, start that session with the saved connection and the same profile. Resume only the verification step.
Repeat the original onboarding prompt afterward. Require the same profile ID, port, secret references, browser lifetime, and saved local-page marker.

After the agent demonstrates release and reuse, the test operator can explicitly stop the test profile and fixture server.
Do not stop or remove real service profiles. Keep failed test state for inspection.

## Automated coverage

`tests/integration/profile-cli.test.ts` covers direct and proxy creation, environment input, repeated creation, concurrent creation, legacy catalogs, interrupted transactions, conflicts, redacted results, missing initialization, and unsafe service files.
Existing catalog, lifecycle, and MCP suites cover port allocation, rollback, exclusive control, and browser survival after disconnect.
The release verifier checks the installed CLI and bundled onboarding resources outside the source checkout.

## Run record: 2026-11-05

The assisted Codex acceptance check passed on local macOS ARM64.
The host supplied Bun 1.4.4, Node.js 24.14.0, npm 11.16.0, and a compatible Camoufox executable.
The target client was Codex CLI 0.142.4.
The agent read the local bootstrap document and installed the supplied Stelz 0.2.0 archive into a new temporary npm prefix.
The archive SHA-256 was `17cdaa57f05f47060a33afe9b8502537fd65de06f30a3256bf8d68b7c339dd94`.

| State | Observed result |
| --- | --- |
| Installed | The fresh agent installed the archive with lifecycle scripts enabled, initialized an empty service directory, and prepared the runtime. |
| Browser ready | The agent created native profile `work` on port 9377. Start and doctor confirmed the running service and owned processes. |
| Client configured | The agent installed a symlink to the canonical skill and a project MCP entry. It preserved global client configuration. |
| Verified | A fresh Codex session acquired control, opened the local fixture, read snapshots, clicked the observed reference, and verified the result. |

The first session reported **Verified: pending** because it lacked the newly registered tools.
The next session used the actual `stelz-work` MCP tools. It did not use an SDK probe for browser interaction.
After release, status reported `ready` with no controller. Reacquisition returned the same page and result.

The agent then repeated initialization, profile creation, and startup.
Creation returned `created: false`. Profile ID, port, native storage, and catalog and secret-file hashes remained unchanged.
The instance remained `2211f6d7-15e5-4225-8f1d-01956bc44233`.
The fixture tab remained `086c8d6a-e9f9-4f10-9bbc-13a4d90171ef`.
Its persistent count increased from 1 to 2 after a second observed click.
The final release again left the same browser ready with no controller.
After recording that evidence, the test operator stopped only the temporary `work` profile.
The fixture server stopped separately. The test retained native profile data for inspection.

## Required interventions

- The installed Codex CLI initially rejected the user's model catalog before the agent could start.
  The test operator supplied a temporary compatible catalog through a session-only flag.
  The copy supplied missing model capability fields and disabled an incompatible optional response transport.
  The global catalog, authentication, sandbox, and approval settings stayed unchanged.
  This assistance prevents a claim of fully unattended onboarding on this host.
- The first sandboxed desktop browser launch aborted. The agent inspected ownership, stopped only the failed test lifetime, and requested normal launch permission.
  The approved launch succeeded. Protected project skill and MCP directories also required normal permission escalation.
  Stopping the temporary fixture also required scoped permission.
- The operator started a fresh Codex session after registration. The first session supplied exact connection arguments and a checkpoint.
- No website authentication or new credentials were necessary for the local fixture.

## Scope and limitations

The test used a fresh package prefix, service directory, and project configuration. It reused host dependencies and the browser executable.
It does not establish installation on a fresh operating system or exercise the missing-dependency download branches.
The public bootstrap URL and npm release path were not the input to this development run.
Publish the document and release before testing that public path.

Claude Code and Hermes setup paths follow their official documentation.
The installed Hermes skill loader also supports directory symlinks.
Neither client completed this onboarding acceptance run. Claude Code was unavailable.
Proxy creation, conflicts, legacy references, and interrupted transactions passed automated CLI checks. This agent check used direct networking.

The implementation checks passed: 484 Bun tests, 97 Node regression tests, typecheck, build, and isolated release verification.
Ten CLI tests include concurrent reuse, interrupted creation, and conflicting legacy paths.
Local evidence is retained under `.state/onboarding-acceptance/` and the temporary acceptance project.
