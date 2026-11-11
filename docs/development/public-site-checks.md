---
title: "Public fingerprint checks"
description: "Procedure, test home, and results of the public-site fingerprint check, to read when you run `bun run test:public`."
tags: [development, testing, acceptance]
sources: []
created: 2026-11-11T14:53:43Z
modified: 2026-11-11T15:01:55Z
---

# Public fingerprint checks

- Run `bun run test:public`.
- Other suites: [Acceptance](acceptance.md).
- Sites: [Fingerprint web scraping](https://demo.fingerprint.com/web-scraping), [Fingerprint Playground](https://demo.fingerprint.com/playground), [Pixelscan](https://pixelscan.net/fingerprint-check), [Rebrowser](https://bot-detector.rebrowser.net/).
- A pass does not show that a website cannot detect automation.
- Use a separate proxy. Do not share it with lifecycle tests, which create multiple identities.
- It rejects `--profile`, ignores `STELZ_HOME`, and reuses one native profile.

## Procedure

1. Create a private env file with `PROXY_TEST_USAGE=dedicated-public` and `PROXY_TEST_URL`. Add `PROXY_TEST_EXPECTED_IP` when an exit pin is necessary.
2. From the repository root, create a test home once. Save the printed absolute path:

   ```sh
   bun --no-env-file -e 'import { createTestHome } from "./tests/helpers/test-home.ts"; console.log(createTestHome("public-profile", ".state"));'
   ```

3. Use that same path for every public check:

   ```sh
   PUBLIC_TEST_HOME=/absolute/path/printed/above PROXY_TEST_ENV=/absolute/path/to/public.env bun run test:public
   ```

## Test home

- Keeps cookies and device settings. Bound to the proxy protocol, host, port, and IP pin.
- A credential rotation keeps the profile. A route or IP pin change needs a new `PUBLIC_TEST_HOME`.
- Concurrent runs cannot share it. After a crash, make sure the run is not active, then remove `.public-check.lock`.
- No direct-connection fallback. No shell proxy URL fallback.

## Run behavior

- Authentication pauses the profile. Complete it in the same Camoufox window, then type `done` in the terminal. A noninteractive terminal or cancelled authentication gives an incomplete run.
- A service deadline blocks further actions. See [Browser action or IP check timed out](../troubleshooting/lifetime-and-state.md#browser-action-or-ip-check-timed-out).

## Result

- Artifacts: `.state/public-sites/<run>/` with `report.json`, `report.md`, and for each site a PNG screenshot and a snapshot JSON file.
- Site results: `PASS`, `FAIL`, `INCONCLUSIVE`, `UNSUPPORTED`, `ERROR`. Loading pages, missing signals, and unfamiliar results cannot pass.
- Success: four passing site checks, four screenshots, successful shutdown. Advisory warnings do not fail the run.
