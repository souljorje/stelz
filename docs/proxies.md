---
title: "Configure a proxy or expected exit IP"
description: "Proxy URL formats, provider input, and the UI steps to set, change, or remove a proxy or expected exit IP. Read it before you change a profile's network route."
tags: [proxy, network, location]
sources: []
created: 2026-11-06T13:49:16Z
modified: 2026-11-11T14:13:54Z
---

# Configure a proxy or expected exit IP

A proxy is optional. Leave **Proxy** blank for a direct connection.
A missing, empty, or invalid configured proxy blocks startup. It never permits direct fallback.
These settings affect the profile's browser traffic, not the client's LLM traffic.
To create a profile with a proxy from the CLI, see [Create or reuse a profile](cli.md#create-or-reuse-a-profile).

## Change or remove a proxy in the UI

1. Run `stelz ui --open` with the usual `STELZ_HOME`. Open **Profiles** and select `work`.
2. Select **Stop** if the profile is running. Wait for **Stopped**.
3. Open **Overview** and find **Connection**.
4. Paste the provider's proxy details in **Proxy**. Clear **Proxy**, or select **Remove proxy** for a managed proxy, to use a direct connection.
5. Enter an optional **Expected exit IP**. Clear it to remove the fixed-address requirement.
6. Select **Save network**. Require `Network settings saved.`.
7. Select **Check connection**. Resolve any blocker in **Location alignment** with [Location alignment blocks Start](troubleshooting.md#location-alignment-blocks-start).
8. Select **Start**. Run `stelz status work` to check the [IP verification fields](configuration.md#ip-verification-fields).

Changing only the expected IP keeps the saved proxy authentication. The UI hides saved credentials.
To replace credentials, paste the replacement details or select **Edit details**, then enter the credentials again.
Removing a proxy detaches this profile's reference. Other profiles keep the shared secret value.
Checks stay required when a proxy remains with no expected IP, or when an expected IP remains with no proxy.

**Managed externally** means a process environment override or shared secret reference controls the value.
The UI cannot replace it. Stop the profile, then change the external value and keep the reference name.
An empty override still takes precedence over `secrets.env`. See [Setting precedence](configuration.md#service-directory-and-precedence).
If the UI reports a conflict, select **Discard edits and load latest** and review the new configuration before you enter the change again.
Do not force a stale save or remove a transaction journal. See [Configuration save or import is pending](troubleshooting.md#configuration-save-or-import-is-pending).

## Paste provider details

The UI and CLI profile creation accept these formats:

```text
http://user:password@proxy.example:8080
user:password@proxy.example:8080
proxy.example:8080:user:password
proxy.example:8080
```

An omitted protocol uses HTTP. The UI shows **HTTP assumed** before saving. Bracket IPv6 addresses, for example `[2001:db8::1]:8080`.
You can also paste a cURL example with `--proxy` (`-x`) and optional `--proxy-user` (`-U`):

```sh
curl https://example.com -x proxy.example:8080 -U 'user:password'
```

Stelz reads the proxy options locally. It does not run the command.
Shell substitutions, variables, conflicting credentials, and multiple proxy endpoints need manual entry.
Ambiguous input opens separate fields. Select **Enter manually** to enter each part directly.
Shorthand passwords and separate credential fields are literal. Stelz encodes their reserved characters.
URL-style credentials can contain percent escapes. Stelz decodes them once.

To import a list, select **Import list** beside the proxy field. Choose a text file or paste one proxy per line.
Select one detected proxy, then **Use proxy**. For a download link, select **Download the list** and choose the downloaded file. Stelz does not fetch the link.
Only the selected proxy reaches the local service. A file can contain up to 1 MB and 10,000 lines.

## Supported proxy URLs

| Form | Support |
| --- | --- |
| `http://proxy.example:8080` | HTTP proxy without authentication. |
| `http://user:password@proxy.example:8080` | HTTP proxy with authentication. |
| `https://user:password@proxy.example:8443` | HTTPS proxy. Authentication is optional. |
| `socks5://proxy.example:1080` | SOCKS5 without authentication. Authenticated SOCKS5 is unsupported. |

With a protocol, an omitted port uses `80` for HTTP, `443` for HTTPS, or `1080` for SOCKS5. Input without a protocol needs a port.
For a secret that you edit in `secrets.env`, use a complete URL with percent-encoded credentials. Format detection runs only at profile creation and UI network edits.
Paths other than `/`, query strings, and fragments are unsupported. Inputs reject control characters and normalized URLs longer than 8192 characters.
Expected IP accepts one literal IPv4 or IPv6 address. The check compares the returned address with the configured string exactly.
Use the provider's IPv6 representation. There is no CIDR, hostname, port, or zone-suffix support.

## Location checks

Each new proxied browser needs a preflight check with a 30-second deadline.
**Ready to start** applies only to the checked inputs, and Start repeats preflight with current inputs.
A rotated exit is allowed only when its location settings and the expected-IP rule stay compatible.
A failed check blocks agent actions. See [IP verification failed](troubleshooting.md#ip-verification-failed).
[IP check policy](configuration.md#ip-check-policy) and [Managed location data](configuration.md#managed-location-data) state the providers, data age, and `STELZ_LOCATION_POLICY`.
