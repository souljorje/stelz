// Runtime validation stays strict. Provider input is normalized at configuration boundaries.
export function validateProxy(raw: string, id = "Profile"): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw Error(`${id}: proxy URL is invalid. Credentials are hidden.`); }
  if (!["http:", "https:", "socks5:"].includes(u.protocol) || !u.hostname || u.pathname !== "/" && u.pathname !== "" || u.search || u.hash) throw Error(`${id}: use HTTP(S) or unauthenticated SOCKS5.`);
  if (u.protocol === "socks5:" && (u.username || u.password)) throw Error(`${id}: SOCKS5 authentication is not supported. Use an HTTP proxy.`);
  try { decodeURIComponent(u.username); decodeURIComponent(u.password); } catch { throw Error(`${id}: proxy credentials have invalid percent encoding.`); }
  return u;
}
