export type ProbeProxyAuth = { host: string; port: number; username: string; password: string };
export type IpProbeConfig = { instanceId: string; endpoint: string; accessKey: string; proxyAuth?: ProbeProxyAuth };

// Serialized into the profile add-on. Keep all runtime dependencies inside this function.
export function profileIpProbeMain(config: IpProbeConfig) {
  type Request = { id: string; provider: "ipify" | "cloudflare" };
  type Result = { id: string; body: string } | { id: string; failed: true };
  const providers = { ipify: "https://api.ipify.org?format=json", cloudflare: "https://www.cloudflare.com/cdn-cgi/trace" };
  let active: string | undefined, result: Result | undefined, completed: Result | undefined;
  let activeUrl: string | undefined;
  const authenticated = new Set<string>();
  if (config.proxyAuth) {
    type Challenge = { requestId: string; url: string; originUrl?: string; tabId: number; isProxy: boolean; challenger: { host: string; port: number } };
    const api = (globalThis as unknown as { browser: {
      runtime: { getURL(path: string): string };
      webRequest: { onAuthRequired: { addListener(fn: (details: Challenge) => unknown, filter: object, extra: string[]): void } };
    } }).browser;
    const origin = api.runtime.getURL("");
    api.webRequest.onAuthRequired.addListener(details => {
      // Juggler only supplies proxy credentials to page requests. Authenticate
      // this add-on's current probe, never a website or another extension.
      if (details.tabId !== -1 || !details.originUrl?.startsWith(origin) || details.url !== activeUrl) return {};
      const proxy = config.proxyAuth!;
      if (!details.isProxy || details.challenger.host.replace(/^\[|\]$/g, "").toLowerCase() !== proxy.host
        || details.challenger.port !== proxy.port || authenticated.has(details.requestId)) return { cancel: true };
      authenticated.add(details.requestId);
      return { authCredentials: { username: proxy.username, password: proxy.password } };
    }, { urls: ["https://api.ipify.org/*", "https://www.cloudflare.com/*"] }, ["blocking"]);
  }
  async function probe(request: Request): Promise<Result> {
    try {
      const url = new URL(providers[request.provider]);
      url.searchParams.set("_", request.id);
      activeUrl = url.href;
      authenticated.clear();
      const response = await fetch(url, { credentials: "omit", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw Error("IP provider request failed.");
      const body = await response.text();
      if (body.length > 4096) throw Error("IP provider response is too large.");
      return { id: request.id, body };
    } catch { return { id: request.id, failed: true }; }
    finally { activeUrl = undefined; authenticated.clear(); }
  }
  async function tick() {
    try {
      const sent = result;
      const response = await fetch(config.endpoint, { method: "POST", credentials: "omit", redirect: "error",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + config.accessKey },
        body: JSON.stringify({ instanceId: config.instanceId, result: sent }), signal: AbortSignal.timeout(3_000) });
      if (!response.ok) throw Error("Browser network bridge is unavailable.");
      if (result === sent) result = undefined;
      const { request } = await response.json() as { request?: Request };
      if (request && typeof request.id === "string" && request.id.length <= 64 && Object.hasOwn(providers, request.provider)) {
        if (completed?.id === request.id) result = completed;
        else if (!active) {
          active = request.id;
          void probe(request).then(value => { completed = result = value; active = undefined; });
        }
      }
    } catch { /* Retry the bridge connection without replaying a completed provider request. */ }
    setTimeout(tick, result ? 0 : 750);
  }
  void tick();
}
