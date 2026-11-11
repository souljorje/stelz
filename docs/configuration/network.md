---
title: "IP checks and location data"
description: "IP verification fields, the IP check policy, and the managed location data for proxied profiles."
tags: [configuration, reference, network, location]
sources: []
created: 2026-11-06T13:49:16Z
modified: 2026-11-11T15:01:55Z
---

# IP checks and location data

## IP verification fields

Live CLI and MCP status report these fields.

| Field | Meaning |
| --- | --- |
| `verificationRequired` | True for a proxy or a nonempty expected IP. False for direct networking without an expected IP. |
| `verificationStatus` | Last verdict: `unverified`, `verified`, or `verification_failed`. Separate from browser phase. |
| `verificationFresh` | Whether the next action can reuse the successful result. Expiry alone does not change the last verdict. |
| `checkedAt`, `exitIp` | Time and exit IP of the last successful check. A later failure can keep `checkedAt`. A failed check clears `exitIp`. |
| `fixedIpVerified` | True only after a successful proxied check with a nonempty expected IP. |
| `checkFailure` | Bounded failure detail, such as an unexpected IP or unavailable providers. |

A stopped profile can keep old fields. Check `phase` first.

## IP check policy

- Preflight: every new proxied lifetime first checks its route and managed location data. See [Managed location data](#managed-location-data). It never authorizes a later start from cached evidence.
- Browser-side check: each browser then needs a successful check. It runs in the browser background through the configured route and opens no visible page.
- A configured proxy always requires verification. A direct profile requires it only with an expected IP. An expected IP adds an exact address requirement.
- Providers: ipify, then Cloudflare trace.
  - Fallback to Cloudflare trace: a failed request or invalid response.
  - After a fallback succeeds, later checks try it first.
  - A valid unexpected IP fails at once. No other provider runs.
- Startup, resume, and explicit recheck need a fresh check.
- Other actions reuse a success for at most `STELZ_IP_CHECK_INTERVAL_MS`. `0`: fresh check before each action.
- Idle browsers do not poll providers.
- A recognized proxy, DNS, or connection failure invalidates the cache. The same action queue runs a fresh check. It does not replay the failed action.
- A failed check in an existing session blocks browser actions and records `verification_failed`. A failed initial location check closes only that startup attempt. Its `location` diagnostic stays.
- Proxy policy: no WebRTC, DNS through SOCKS proxies. Only `127.0.0.1` and `localhost` bypass the proxy.
- Proxy route down: external requests fail. Local snapshots and tab lists can still succeed. Stelz installs no host firewall or kill switch.

## Managed location data

`stelz setup` prepares two databases under `runtime/geoip/` for all profiles.

- GeoIP AIO selects the location. No city or accuracy.
- GeoLite2 City is the comparison. City and accuracy radius for many addresses.
- Build at most 8 days old: setup reuses it without contacting its download service. Older build: setup downloads the latest release only when it differs. Offline, setup keeps the validated older build.
- An interrupted download preserves the active databases.

Each preflight compares the selected location with the comparison record for the exit IP:

| Result | Meaning |
| --- | --- |
| `corroborated` | A city-level record (accuracy radius at most 100 km) has the same UTC offsets in January and July. |
| `uncorroborated` | The record is broader, has no timezone, or is missing. Missing metadata is not evidence against the selection. |
| `conflicting` | A city-level record has different UTC offsets. |

- A build older than 30 days is stale.
- `STELZ_LOCATION_POLICY=warn`: Start reports a conflict or stale data and continues. `strict`: Start blocks it before launch.
- Before Ready, Stelz checks that the browser applies the prepared timezone and language. A passed check does not confirm a physical location.
- Stelz does not grant websites location permission.
