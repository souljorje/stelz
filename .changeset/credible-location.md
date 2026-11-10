---
"stelz": minor
---

Select proxy locations with GeoIP AIO, the official Camoufox default, and compare them with GeoLite2 City. `stelz setup` downloads both databases. A proxied profile can get a different timezone at its next Start. A running browser keeps its settings.

Preflight now reports the location source, its build date, and whether the comparison database corroborates, cannot confirm, or contradicts the location. When a build is older than 8 days, setup downloads a newer release if one exists. Set `STELZ_LOCATION_POLICY=strict` to block Start on a conflict or on data that is older than 30 days.

A passed browser check now states that the browser applies the prepared timezone and language. It does not confirm a physical location.
