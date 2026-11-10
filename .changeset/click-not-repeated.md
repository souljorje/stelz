---
"stelz": patch
---

A click that may already have reached the page is no longer repeated. Upstream Camofox retried a slow click with a forced click and then a DOM click, so one request could act up to three times. Stelz now falls back only when the failed attempt sent no input. Otherwise `camofox_click` returns a non-retryable error that asks for a fresh snapshot. The profile stays usable.
