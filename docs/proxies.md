# Configure a proxy or expected exit IP

A proxy is optional. Leave **Proxy** blank for a direct connection.
A missing, empty, or invalid configured proxy blocks startup. It never permits direct fallback.

Use [Getting started](getting-started.md) to prepare the `work` profile first.
These settings affect that profile's browser traffic. They do not change the client's LLM traffic.

## Change the work profile in the UI

1. Run `stelz ui --open` with the usual `STELZ_HOME`.
2. Open **Profiles** and select `work`.
3. Select **Stop** if the profile is running. Wait for **Stopped**.
4. Open **Overview** and find **Connection**.
5. Paste the provider's proxy details in **Proxy**, or leave it empty for direct networking.
6. Enter an optional **Expected exit IP**. Leave it empty if no fixed address is required.
7. Select **Save network**. Require `Network settings saved.`.
8. Select **Check connection**. Read **Location alignment** and resolve any blocker.
9. Select **Start**. Run `stelz status work` to check the result.

An unchanged proxy address preserves its saved authentication when you change only the expected IP.
The UI shows the saved address without its username or password.
To replace credentials, paste the replacement details or select **Edit details**.
Saved credentials remain hidden. Enter them again when you change a saved proxy through the separate fields.

For a proxy, require `phase: "ready"`, `verificationRequired: true`, and `verificationStatus: "verified"` before browser work.
Check `exitIp` against the intended route.
For direct networking without an expected IP, `verificationRequired: false` is normal.
Such a profile does not perform an IP lookup.

## Remove a proxy or expected IP

1. Stop `work` cleanly.
2. Clear **Proxy**, or select **Remove proxy** for a managed proxy.
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

## Paste provider details

The UI and CLI profile creation accept these formats:

```text
http://user:password@proxy.example:8080
user:password@proxy.example:8080
proxy.example:8080:user:password
proxy.example:8080
```

An omitted protocol uses HTTP. The UI shows **HTTP assumed** before saving.
Explicit HTTPS and SOCKS5 protocols remain unchanged.
Bracket IPv6 addresses, for example `[2001:db8::1]:8080`.

You can also paste a cURL example with `--proxy` (`-x`) and optional `--proxy-user` (`-U`):

```sh
curl https://example.com -x proxy.example:8080 -U 'user:password'
```

Stelz reads the proxy options locally. It does not execute the command or contact the example website.
Shell substitutions, variables, conflicting credentials, and multiple proxy endpoints require manual entry.

The preview shows the address without credentials. Ambiguous input opens separate fields for confirmation.
Select **Enter manually** to enter the protocol, host, port, username, and password directly.
Shorthand passwords and separate credential fields are literal. Stelz encodes their reserved characters automatically.
URL-style credentials can contain existing percent escapes. Stelz decodes them once before saving the canonical URL.

### Import a proxy list

1. Select **Import list** beside the proxy field.
2. Choose a text file or paste a list with one proxy per line.
3. Select one detected proxy.
4. Select **Use proxy**. Then save the network settings or create the profile.

For a download link, select **Import list**, then **Download the list**. Choose the downloaded file.
Stelz does not automatically fetch the link or save it as a proxy endpoint.
List parsing stays in the UI. Only the selected proxy reaches the local service when you save.
Duplicate entries are combined. Invalid lines are reported without their credentials.
Files can contain up to 1 MB and 10,000 lines. This limit does not restrict the saved profile count.

## Supported proxy URLs

| Form | Support |
| --- | --- |
| `http://proxy.example:8080` | HTTP proxy without authentication. |
| `http://user:password@proxy.example:8080` | HTTP proxy with authentication. |
| `https://user:password@proxy.example:8443` | HTTPS proxy with authentication. Authentication is also optional. |
| `socks5://proxy.example:1080` | SOCKS5 without authentication. |

An omitted port uses `80` for HTTP, `443` for HTTPS, or `1080` for SOCKS5.
For secrets edited directly in `secrets.env`, use a complete URL with percent-encoded credentials.
Provider-format detection runs during profile creation and UI network edits, not at browser startup.
Authenticated SOCKS5 is unsupported. Use an HTTP(S) endpoint when authentication is required.

Paths other than `/`, query strings, and fragments are unsupported.
Inputs reject control characters and normalized URLs longer than 8192 characters.
Whitespace and backslashes in separate credentials are encoded. They are not permitted in proxy hosts.

Expected IP accepts one literal IPv4 or IPv6 address.
The check compares the returned address with the configured string exactly.
Use the provider's returned representation for IPv6. There is no CIDR, hostname, port, or zone-suffix support.

## Create a profile from the CLI

Use the UI to change an existing profile's network settings.
For agent-led creation, use the [profile command reference](cli.md#profile-commands).
It describes proxy environment inputs, compatible reuse, and conflicts.

## IP check policy

Each new proxied browser requires a preflight check before launch. This check has a 30-second deadline.
It checks the proxy exit IP, any expected IP, and the managed location data.
**Ready to start** applies only to the checked inputs. Start repeats preflight with current inputs.
Proxy connections also require a successful browser-side IP check.
Before Ready, Stelz checks the browser timezone and language against the prepared settings.
Geolocation coordinates are checked in the launch configuration. They are not browser-observed coordinates.
Stelz does not grant websites location permission.
A rotated exit is allowed only when its location settings and the expected-IP rule remain compatible.
A failed initial check closes that startup attempt. It preserves native data and the failure reason.
Direct connections require one only when you set an expected IP.
A failed check blocks agent actions. Repair the connection, then use the recovery steps below.
The profile's private browser add-on performs checks in the background. No IP-check tab is required.

Checks can reuse recent successful results. They do not guarantee continuous IP stability.
See [IP check policy](configuration.md#ip-check-policy) for providers, cache timing, and routing limits.

## Recover from a failed check

1. Run `stelz doctor work` and `stelz status work`.
2. Read `location`, `configuration`, `error`, and `checkFailure`.
3. Correct the provider connection without changing the running configuration, if possible.
4. Run `stelz recheck work` after the connection works again.
5. Require `verificationStatus: "verified"`.
6. If `phase` remains `paused`, finish manual work before running `stelz resume work`.
7. Read a fresh snapshot before the next browser action.

For changed credentials, proxy URLs, or expected IP settings, stop `work` before saving the change.
Start it explicitly afterward. Recheck does not reload a running browser's network configuration.
For `blocked` after an operation timeout, use [the timeout procedure](troubleshooting.md#browser-action-or-ip-check-timed-out).
