---
"stelz": minor
---

The npm package now holds only the runtime. Documentation and the browser skill are no longer in it.

The browser skill is one self-contained file. Install it by saving `SKILL.md` into your client's skill folder. See [Connect your agent](https://github.com/souljorje/stelz/blob/main/docs/clients.md). A skill that you linked from the installed package stops working after this update. Install it again.

Bun now runs the `stelz` command and the supervisor from source.
