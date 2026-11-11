---
title: "Local UI HTTP session"
description: "Session, origin, and credential rules of the local UI server, to read before you change UI authentication or API routes."
tags: [development, architecture, ui]
sources: []
created: 2026-11-11T14:53:45Z
modified: 2026-11-11T15:01:55Z
---

# Local UI HTTP session

- The Hono API runs on Bun at `127.0.0.1`. The React application uses the same origin.
- Each UI server generates an independent bootstrap token and session secret.
- The launch URL carries the token in the fragment. The UI sends it to `POST /api/session`, then removes the fragment.
- The server consumes the token once. It sets an HttpOnly, `SameSite=Strict` cookie scoped to `/`. The cookie name includes the UI port.
- Every request must use the exact configured host and port.
- API requests reject a supplied foreign origin. API methods other than GET and HEAD require the exact UI origin.
- All API routes except session exchange require the session cookie.
- The session secret and profile access keys are separate credentials.
- Browser service keys and saved proxy credentials stay on the backend.
- UI models redact credentials before they apply display limits.
- `POST /api/shutdown` refuses shutdown while work remains active.
- Successful shutdown invalidates the session, expires the cookie, and stops the UI server. It preserves running browsers.
- The UI imports types from `src/api/contracts.ts` and `src/api/transfer-contracts.ts`. At runtime it imports only the pure helpers `profileAppearance` and `src/profiles/proxy-input.ts`. Server runtime modules stay on the backend.
