import { isIP } from "node:net";

export const DEFAULT_IP_CHECK_INTERVAL_MS = 120_000;

export function parseIpCheckInterval(value: string | undefined): number {
  if (value === undefined) return DEFAULT_IP_CHECK_INTERVAL_MS;
  if (!/^(0|[1-9]\d*)$/.test(value) || Number(value) > DEFAULT_IP_CHECK_INTERVAL_MS) {
    throw Error("STELZ_IP_CHECK_INTERVAL_MS must be an integer from 0 to 120000");
  }
  return Number(value);
}

export type Probe = {
  goto(url: string, options: object): Promise<unknown>;
  evaluate<T>(fn: (endpoint: string) => Promise<T>, endpoint: string): Promise<T>;
  close(): Promise<void>;
};

type ProbeContext = {
  sessions: Map<string, unknown>;
  createLeasedPage(session: unknown): Promise<{ page: Probe; lease: unknown }>;
  closeLeasedPage(session: unknown, page: Probe, lease: unknown): Promise<void>;
};

export function createIpVerification(ctx: ProbeContext, id: string, expected: string) {
  if (expected && !isIP(expected)) throw Error("Expected exit IP must be an IPv4 or IPv6 address");
  let page: Probe | undefined;
  let session: unknown;
  let lease: unknown;
  const providers = ["https://api.ipify.org?format=json", "https://www.cloudflare.com/cdn-cgi/trace"];
  let provider = 0;
  let navigated: number | undefined;

  async function close() {
    const leasedPage = page;
    const leasedSession = session;
    const pageLease = lease;
    page = undefined;
    session = undefined;
    lease = undefined;
    navigated = undefined;
    if (leasedPage) await ctx.closeLeasedPage(leasedSession, leasedPage, pageLease);
  }

  async function check() {
    if (!page) {
      session = ctx.sessions.get(id);
      if (!session) throw Error("Profile session is unavailable");
      const leased = await ctx.createLeasedPage(session);
      page = leased.page;
      lease = leased.lease;
    }
    try {
      for (let attempt = 0; attempt < providers.length; attempt++) {
        const candidate = (provider + attempt) % providers.length;
        let value: { ip: string };
        try {
          if (navigated !== candidate) {
            await page.goto(providers[candidate]!, { waitUntil: "domcontentloaded", timeout: 10000 });
            navigated = candidate;
          }
          value = await page.evaluate(async (endpoint) => {
            const url = new URL(endpoint);
            url.searchParams.set("_", String(Date.now()));
            const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(10000) });
            if (!response.ok) throw Error("IP provider request failed");
            const body = await response.text();
            try { return JSON.parse(body) as { ip: string }; }
            catch { return { ip: /^ip=([^\r\n]+)$/m.exec(body)?.[1]?.trim() || "" }; }
          }, providers[candidate]!);
          if (!value || typeof value.ip !== "string" || !isIP(value.ip)) throw Error("Invalid IP provider response");
        } catch {
          navigated = undefined;
          continue;
        }
        // A valid mismatch is evidence of a routing failure. Do not try another provider.
        if (expected && value.ip !== expected) throw Error("Browser exit IP does not match configured expected IP");
        provider = candidate;
        return value.ip;
      }
      throw Error("Browser exit IP verification failed at all configured providers");
    } catch (error) {
      await close().catch(() => {});
      throw error;
    }
  }

  return { check, close };
}
