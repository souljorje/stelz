import { isIP } from "node:net";
import type { Impit } from "impit";

const SERVICES = ["https://api.ipify.org", "https://checkip.amazonaws.com", "https://ipinfo.io/ip",
  "https://icanhazip.com", "https://ifconfig.co/ip", "https://ipecho.net/plain"];
// Impit releases native resources only when its wrapper is collected. Reuse a few clients.
// Load the native addon on first use so the supervisor and CLI start without it.
const clients = new Map<string, Impit>();
async function client(proxy: string) {
  let value = clients.get(proxy);
  if (value) clients.delete(proxy);
  else value = new (await import("impit")).Impit({ proxyUrl: proxy, timeout: 5000 });
  clients.set(proxy, value);
  if (clients.size > 8) clients.delete(clients.keys().next().value!);
  return value;
}
const failure = (code: string) => Object.assign(Error(code === "PROXY_AUTHENTICATION" ? "Proxy authentication failed" : "Cannot detect the proxy exit IP"), { code });

/** Return the proxy exit IP. Error codes match the location failures. */
export async function publicIP(proxy: string, signal: AbortSignal) {
  // A missing native addon must fail loudly, not look like an unreachable proxy.
  const impit = await client(proxy);
  let code = "PROXY_UNREACHABLE";
  for (const url of SERVICES) {
    signal.throwIfAborted();
    try {
      const response = await impit.fetch(url, { signal, redirect: "error" });
      if (response.status === 407) throw failure("PROXY_AUTHENTICATION");
      code = "IP_DETECTION_FAILED";
      if (!response.ok) continue;
      const ip = (await response.text()).trim();
      if (isIP(ip)) return ip;
    } catch (error) {
      signal.throwIfAborted();
      const value = error as { code?: string; name?: string; status?: number };
      if (value?.code === "PROXY_AUTHENTICATION" || /ProxyAuthRequired/.test(value?.name || "") || value?.status === 407) throw failure("PROXY_AUTHENTICATION");
    }
  }
  throw failure(code);
}
