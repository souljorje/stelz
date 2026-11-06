---
"stelz": minor
---

Replace profile-bound MCP registrations with one `stelz mcp` registration and 18 fixed tools.
Agents can list, create, start, and control multiple profiles through explicit `profileId` arguments.
Each acquisition returns a fresh `controlHandle` for that connection, profile, and browser lifetime.
Control actions and all nine browser tools require both fields.

The removed MCP `--profile` option returns migration guidance.
Keep the same `STELZ_HOME`. Stop running profiles before `stelz setup`, then explicitly start each required profile.
Profile IDs, saved data, and secret references remain unchanged. Profile-import `--profile` selectors remain supported.
Update client examples, agent instructions, and UI snippets for the shared registration.
