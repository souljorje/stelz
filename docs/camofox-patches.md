# Camofox adapter patches

The adapter applies these eight exact source patches to pinned Camofox 1.18.1 and camoufox-js 0.11.5.
Setup rejects missing, duplicate, or changed matches. Reapplying an exact completed patch has no effect.
Setup copies dependencies, applies patches, and validates the complete staged runtime before atomic activation.
Setup retains symlink rejection, stopped-profile checks, process ownership, admission locks, and rollback cleanup.

| Patch | Reason | Removal criterion |
| --- | --- | --- |
| Locator fill | Route text through the configured paced or instant typing helper. | Upstream supplies the same configurable typing behavior. |
| Executable resource link | Prevent changes to an installed macOS app bundle. | Upstream reads app resources without writing symlinks. |
| camoufox-js properties path | Read macOS properties from Contents/Resources. | The pinned library resolves that resource path itself. |
| Window and screen bounds | Preserve the existing desktop window and screen selection policy. | Upstream supports equivalent explicit bounds through configuration. |
| Proxy WebRTC policy | Disable WebRTC for proxied browsers. | Upstream enforces the same policy on every proxy launch. |
| Browser launch | Route launch through persistent profile and fingerprint handling. | Upstream provides equivalent persistent-context ownership and device replay. |
| Context claim | Reuse the selected persistent profile context. | Upstream claims that context without creating a replacement. |
| Native persistence guard | Prevent checkpoint restoration over native Firefox storage. | Upstream disables checkpoint persistence for native storage. |

Remove a patch only after the replacement passes offline regression tests and explicit browser acceptance.
An upstream version change requires a separate compatibility review. This restructuring does not change patch behavior.
