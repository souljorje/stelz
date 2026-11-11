---
title: "Configure a proxy or expected exit IP"
description: "Proxy URL formats and the steps to set, change, or remove a proxy or expected exit IP."
tags: [proxy, network, location]
sources: []
created: 2026-11-06T13:49:16Z
modified: 2026-11-11T14:55:54Z
---

# Configure a proxy or expected exit IP

- A proxy is optional. Blank **Proxy**: direct connection.
- A missing, empty, or invalid configured proxy blocks startup. It never permits direct fallback.
- Settings affect the profile's browser traffic, not the client's LLM traffic.
- CLI: `stelz profile create` sets a proxy or expected IP only when it creates a profile. See [Create or reuse a profile](cli.md#create-or-reuse-a-profile). It cannot change an existing profile. Use the UI.

## Change or remove a proxy in the UI

1. Run `stelz ui --open` with the usual `STELZ_HOME`. Open **Profiles** and select `work`.
2. Select **Stop** if the profile is running. Wait for **Stopped**.
3. Open **Overview** and find **Connection**.
4. Paste the provider's proxy details in **Proxy**. To use a direct connection, clear **Proxy**, or select **Remove proxy** for a managed proxy.
5. Enter an optional **Expected exit IP**. Clear it to remove the fixed-address requirement.
6. Select **Save network**. Make sure that the UI shows `Network settings saved.`
7. Select **Check connection**. Resolve any blocker in **Location alignment**: [Location alignment blocks Start](troubleshooting/network.md#location-alignment-blocks-start).
8. Select **Start**. Run `stelz status work` to check the [IP verification fields](configuration/network.md#ip-verification-fields).

- Changing only the expected IP keeps the saved proxy authentication. The UI hides saved credentials.
- Replace credentials: paste the replacement details, or select **Edit details** and enter the credentials again.
- Removing a proxy detaches this profile's reference. Other profiles keep the shared secret value.
- **Managed externally**: a process environment override or shared secret reference controls the value. The UI cannot replace it. Stop the profile, change the external value, and keep the reference name.
- Precedence: [Service directory and precedence](configuration/environment.md#service-directory-and-precedence).
- UI conflict: select **Discard edits and load latest**. Review the new configuration before you enter the change again.
- Do not force a stale save or remove a transaction journal. See [Configuration save or import is pending](troubleshooting/lifetime-and-state.md#configuration-save-or-import-is-pending).

## Paste provider details

The UI and CLI profile creation accept these formats:

```text
http://user:password@proxy.example:8080
user:password@proxy.example:8080
proxy.example:8080:user:password
proxy.example:8080
```

- No protocol: HTTP. The UI shows **HTTP assumed** before saving.
- Bracket IPv6 addresses: `[2001:db8::1]:8080`.
- Ambiguous input opens separate fields. **Enter manually** enters each part directly.
- Shorthand passwords and separate credential fields are literal. Stelz encodes their reserved characters.
- URL-style credentials can contain percent escapes. Stelz decodes them once.

### cURL form

`--proxy` (`-x`) and optional `--proxy-user` (`-U`) also work:

```sh
curl https://example.com -x proxy.example:8080 -U 'user:password'
```

- Stelz reads the proxy options locally. It does not run the command.
- Shell substitutions, variables, conflicting credentials, and multiple proxy endpoints need manual entry.

### Import a list

1. Select **Import list** beside the proxy field.
2. Choose a text file, or paste one proxy per line. For a download link, select **Download the list** and choose the downloaded file. Stelz does not fetch the link.
3. Select one detected proxy, then **Use proxy**.

Only the selected proxy reaches the local service. Limits: 1 MB, 10,000 lines.

## Supported proxy URLs

| Form | Support |
| --- | --- |
| `http://proxy.example:8080` | HTTP proxy without authentication. |
| `http://user:password@proxy.example:8080` | HTTP proxy with authentication. |
| `https://user:password@proxy.example:8443` | HTTPS proxy. Authentication is optional. |
| `socks5://proxy.example:1080` | SOCKS5 without authentication. Stelz does not support authenticated SOCKS5. |

- With a protocol, an omitted port uses `80` (HTTP), `443` (HTTPS), or `1080` (SOCKS5). Input without a protocol needs a port.
- A secret that you edit in `secrets.env`: use a complete URL with percent-encoded credentials. Format detection runs only at profile creation and UI network edits.
- Unsupported: paths other than `/`, query strings, and fragments.
- Rejected: control characters, and normalized URLs longer than 8192 characters.
- Expected IP: one literal IPv4 or IPv6 address, compared exactly with the returned address. Use the provider's IPv6 representation. No CIDR, hostname, port, or zone suffix.

## Location checks

- A rotated exit is allowed only when its location settings and the expected-IP rule stay compatible. `strict` blocks it on a conflict.
- Failed check: [IP verification failed](troubleshooting/network.md#ip-verification-failed).
- Providers, cache timing, and routing limits: [IP check policy](configuration/network.md#ip-check-policy).
- Data age and `STELZ_LOCATION_POLICY`: [Managed location data](configuration/network.md#managed-location-data).
