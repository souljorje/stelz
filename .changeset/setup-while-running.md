---
"stelz": minor
---

`stelz setup` no longer requires stopped profiles. Each setup prepares a runtime generation in `runtime-generations/`, or reuses an unchanged one. A running profile keeps the generation that it started with, and its status shows `restartToUpdate: true` until you restart it. Setup removes generations that no running profile uses. New command: `stelz restart ID|all` stops and then starts running profiles.
