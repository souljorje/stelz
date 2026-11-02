import { isIP } from "node:net";

export type Probe = {
  goto(url: string, options: object): Promise<unknown>;
  evaluate<T>(fn: () => Promise<T>): Promise<T>;
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
  let navigated = false;

  async function close() {
    const leasedPage = page;
    const leasedSession = session;
    const pageLease = lease;
    page = undefined;
    session = undefined;
    lease = undefined;
    navigated = false;
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
      if (!navigated) {
        await page.goto("https://api.ipify.org?format=json", { waitUntil: "domcontentloaded", timeout: 20000 });
        navigated = true;
      }
      const value = await page.evaluate(async () => {
        const response = await fetch(`https://api.ipify.org?format=json&_=${Date.now()}`, {
          cache: "no-store", signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw Error("IP check failed");
        return response.json() as Promise<{ ip: string }>;
      });
      if (!isIP(value.ip)) throw Error("IP check did not return an IP address");
      if (expected && value.ip !== expected) throw Error("Browser exit IP does not match configured expected IP");
      return value.ip;
    } catch (error) {
      await close().catch(() => {});
      throw error;
    }
  }

  return { check, close };
}
