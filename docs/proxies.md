# Configure a proxy or expected exit IP

A proxy is optional. Leave **Proxy URL** blank for a direct connection.
A missing, empty, or invalid configured proxy blocks startup. It never permits direct fallback.

Use [Getting started](getting-started.md) to prepare the `work` profile first.
These settings affect that profile's browser traffic. They do not change the client's LLM traffic.

## Change the work profile in the UI

1. Run `stelz ui --open` with the usual `STELZ_HOME`.
2. Open **Profiles** and select `work`.
3. Select **Stop** if the profile is running. Wait for **Stopped**.
4. Open **Overview** and find **Connection**.
5. Enter a supported URL in **Proxy URL**, or leave it empty for direct networking.
6. Enter an optional **Expected exit IP**. Leave it empty if no fixed address is required.
7. Select **Save network**. Require `Network settings saved.`.
8. Select **Start**. Run `stelz status work` to check the result.

An unchanged proxy address preserves its saved authentication when you change only the expected IP.
The UI shows the saved address without its username or password.
To replace credentials, enter the complete replacement URL, including the credentials.

For a proxy, require `phase: "ready"`, `verificationRequired: true`, and `verificationStatus: "verified"` before browser work.
Check `exitIp` against the intended route.
For direct networking without an expected IP, `verificationRequired: false` is normal.
Such a profile does not perform an IP lookup.

## Remove a proxy or expected IP

1. Stop `work` cleanly.
2. Clear **Proxy URL**, or select **Remove proxy** for a managed proxy.
3. Clear **Expected exit IP** if you also want to remove the fixed-address requirement.
4. Select **Save network**.
5. Start `work` explicitly.
6. Run `stelz status work` to check its phase and verification requirements.

Removing the proxy detaches this profile's reference. Shared secret values remain available to other profiles.
Removing only the expected IP still requires successful checks for a proxy connection.
Keeping an expected IP after proxy removal still requires checks for the direct connection.

## Managed values and save conflicts

**Managed externally** means a process environment override or shared secret reference controls the value.
The UI cannot replace that secret. Stop the affected profile before changing its external value.
Preserve the configured reference name.
For a process override, correct the launching environment before starting the profile again.
An empty override still takes precedence over `secrets.env`.
See [Setting precedence](configuration.md#service-directory-and-precedence).

If the UI reports a conflict, select **Discard edits and load latest**.
Review the new configuration before entering the change again.
Do not force a stale save or delete a transaction journal.
See [Pending configuration recovery](troubleshooting.md#configuration-save-or-import-is-pending).

## Supported proxy URLs

Use a complete URL with an explicit scheme:

| Form | Support |
| --- | --- |
| `http://proxy.example:8080` | HTTP proxy without authentication. |
| `http://user:password@proxy.example:8080` | HTTP proxy with authentication. |
| `https://user:password@proxy.example:8443` | HTTPS proxy with authentication. Authentication is also optional. |
| `socks5://proxy.example:1080` | SOCKS5 without authentication. |

An omitted port uses `80` for HTTP, `443` for HTTPS, or `1080` for SOCKS5.
Percent-encode reserved characters in the username and password. Invalid percent encoding fails.
Authenticated SOCKS5 is unsupported. Use an HTTP(S) endpoint when authentication is required.

Paths other than `/`, query strings, and fragments are unsupported.
UI and creation inputs reject whitespace, backslashes, control characters, and URLs longer than 8192 characters.
Bare `host:port`, provider shorthand, and `host:port:user:password` are not supported inputs.
Stelz does not infer a scheme or convert provider credential formats.

Expected IP accepts one literal IPv4 or IPv6 address.
The check compares the returned address with the configured string exactly.
Use the provider's returned representation for IPv6. There is no CIDR, hostname, port, or zone-suffix support.

## Create a profile from the CLI

Use the UI to change an existing profile's network settings.
For agent-led creation, use the [profile command reference](cli.md#profile-commands).
It describes proxy environment inputs, compatible reuse, and conflicts.

## IP check policy

Proxy connections always require a successful browser-side IP check.
Direct connections require one only when you set an expected IP.
A failed check blocks agent actions. Repair the connection, then use the recovery steps below.
Keep the service's reserved IP-check tab open.

Checks can reuse recent successful results. They do not guarantee continuous IP stability.
See [IP check policy](configuration.md#ip-check-policy) for providers, cache timing, and routing limits.

## Recover from a failed check

1. Run `stelz doctor work` and `stelz status work`.
2. Read `configuration`, `error`, and `checkFailure`.
3. Correct the provider connection without changing the running configuration, if possible.
4. Run `stelz recheck work` after the connection works again.
5. Require `verificationStatus: "verified"`.
6. If `phase` remains `paused`, finish manual work before running `stelz resume work`.
7. Read a fresh snapshot before the next browser action.

For changed credentials, proxy URLs, or expected IP settings, stop `work` before saving the change.
Start it explicitly afterward. Recheck does not reload a running browser's network configuration.
For `blocked` after an operation timeout, use [the timeout procedure](troubleshooting.md#browser-action-or-ip-check-timed-out).
