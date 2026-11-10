---
"stelz": patch
---

A click that may already have reached the page is no longer repeated. Upstream Camofox retried a slow click with a forced click and then a DOM click, so one request could act up to three times. Stelz now checks the target first without input and falls back only when that check fails. The click itself waits longer for the browser to confirm input, so a slow click completes instead of failing after 3 seconds. A failure after input returns a non-retryable error that asks for a fresh snapshot. The profile stays usable.
