# Onboarding

Read the complete [bootstrap procedure](https://github.com/souljorje/stelz/blob/main/docs/bootstrap.md) when installation, profile creation, or a client connection is missing.
An installed package also contains `docs/bootstrap.md` at its root.

Reuse the selected `STELZ_HOME`, installed browser, existing profile ID, credentials, and client entries.
Use `stelz profile create ID --json` to create or reuse a profile. Do not write profile JSON by hand.
Explicitly requested network settings must match an existing profile. A conflict requires a decision, not an identity reset.
Only new profiles default to direct networking and native storage.

Install the canonical skill into the selected harness's supported location. Register one MCP connection per selected profile.
Preserve unrelated client settings and approvals. Check the current tool inventory after registration.
If reload or restart is necessary, report that action and resume verification afterward.

Report Installed, Browser ready, Client configured, and Verified separately.
Only the target agent's successful local-page interaction and release check establish Verified.
