---
title: "Network problems"
description: "Recovery when location alignment blocks Start or the browser IP check fails."
tags: [troubleshooting, network, proxy]
sources: []
created: 2026-11-06T13:49:16Z
modified: 2026-11-11T15:01:55Z
---

# Network problems

## Location alignment blocks Start

Read **Location alignment** in the profile details, or run `stelz status work --json`. The `location` result gives the phase, time, reason, and recovery action.

| Problem | Action |
| --- | --- |
| Location data is missing, damaged, or incompatible | Run `stelz setup`, then select **Check again**. |
| Location data is stale (`GEOIP_DATA_STALE`, strict policy) | Run `stelz setup` with network access, then check again. |
| Location databases disagree (`LOCATION_CONFLICT`, strict policy) | Use another proxy exit. To start anyway, set `STELZ_LOCATION_POLICY=warn`. |
| Proxy credentials are missing or rejected | Edit the proxy credentials, then check again. |
| Proxy connection fails or times out, or IP detection fails | Check the provider connection and the IP services, then check again. |
| Expected IP does not match | Check the proxy route and expected IP setting. |
| Exit IP has no complete location | Check the provider's exit location. Setup does not repair a missing location record. |
| Browser location does not match | Check the route, then start again. Inspect logs if the failure repeats. |

- Stopped profile: `stelz recheck work` runs preflight without starting a browser.
- Do not remove the fingerprint or native data to repair location alignment.

## IP verification failed

1. Run `stelz doctor work` and `stelz status work`. Read `configuration`, `error`, and `checkFailure`.
2. Correct the proxy or provider connection when the configured route is still correct.
3. Run `stelz recheck work`. Make sure that `verificationStatus` is `"verified"` and `exitIp` is the intended address.
4. `phase` is `paused`: complete manual work, then run `stelz resume work`.

- Missing secret, invalid URL, changed credentials, or incorrect expected IP: stop `work`, save the corrected settings (see [Configure a proxy](../proxies.md)), then start `work`.
- `verificationFresh: false` with `verificationStatus: "verified"`: Run `stelz recheck work`. See [IP check policy](../configuration/network.md#ip-check-policy).
- See [IP verification fields](../configuration/network.md#ip-verification-fields).
