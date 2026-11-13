---
title: "Agent onboarding acceptance"
description: "Two-session procedure that checks agent setup and a first browser task, to read when you accept a release candidate with a real coding agent."
tags: [development, testing, acceptance, agent]
sources: []
created: 2026-11-11T14:53:43Z
modified: 2026-11-11T15:01:55Z
---

# Agent onboarding acceptance

- Use a desktop machine with a configured coding agent. Keep its approval protections and global client configuration.
- First session: [Agent setup](../bootstrap.md). Second session: a first browser task.
- Other suites: [Acceptance](acceptance.md).

## Procedure

1. Build and pack a candidate. Push its branch, so that the skill link resolves to the candidate's skill.
2. Prepare a new writable project directory, npm prefix, and temporary `STELZ_HOME`.
3. Give a fresh agent in that project the [setup request from the README](../../README.md#agent-setup) with the branch's skill link.
   Add the test conditions: install the archive instead of the registry, and use the test prefix and `STELZ_HOME`.
4. Approve the setup downloads when the agent asks. Record each other intervention request.
5. Make sure that the agent produced the installed package, a prepared runtime, the installed skill file, one shared MCP registration, an open UI, and a report with the next steps.
   The agent must not create or start a profile.
6. Create and start `work` in the UI. Start a new client session in the same project.
7. Serve the fixture as in [Verify the connection](../clients.md#verify-the-connection). Ask the agent to verify Stelz on that page in profile `work`. Keep the browser window visible.
8. Make sure that the agent used a fresh catalog, acquisition with `{profileId}`, fresh snapshots, the fixture action and its result, and release.
9. Stop only the test profile and the fixture server. Keep failed test state for inspection.

- The model must do the browser interaction through its registered MCP tools. See [Verify the connection](../clients.md#verify-the-connection).
