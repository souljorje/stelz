import { isIP } from "node:net";
import { randomUUID } from "node:crypto";

export const DEFAULT_IP_CHECK_INTERVAL_MS = 120_000;

export function parseIpCheckInterval(value: string | undefined): number {
  if (value === undefined) return DEFAULT_IP_CHECK_INTERVAL_MS;
  if (!/^(0|[1-9]\d*)$/.test(value) || Number(value) > DEFAULT_IP_CHECK_INTERVAL_MS) {
    throw Error("STELZ_IP_CHECK_INTERVAL_MS must be an integer from 0 to 120000");
  }
  return Number(value);
}

type Provider = "ipify" | "cloudflare";
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Requests execute in this profile's Firefox add-on, through its actual browser proxy. */
export function createIpVerification(instanceId: string, expected: string, timeoutMs = 15_000) {
  if (expected && !isIP(expected)) throw Error("Expected exit IP must be an IPv4 or IPv6 address");
  const providers: Provider[] = ["ipify", "cloudflare"];
  let provider = 0;
  let checking = false, closed = false;
  let pending: { id: string; provider: Provider; resolve(body: string): void; reject(error: Error): void } | undefined;

  async function close() {
    closed = true;
    pending?.reject(Error("Browser IP verification stopped."));
  }

  function exchange(value: unknown) {
    if (!record(value) || value.instanceId !== instanceId || Object.keys(value).some(key => !["instanceId", "result"].includes(key))) {
      throw Error("Invalid browser network response.");
    }
    const result = value.result;
    if (result !== undefined) {
      if (!record(result) || typeof result.id !== "string" || Object.keys(result).some(key => !["id", "body", "failed"].includes(key))
        || !(result.failed === true && result.body === undefined || result.failed === undefined && typeof result.body === "string" && result.body.length <= 4096)) {
        throw Error("Invalid browser network response.");
      }
      if (pending?.id === result.id) {
        if (result.failed) pending.reject(Error("IP provider request failed."));
        else pending.resolve(result.body as string);
      }
    }
    return !closed && pending ? { request: { id: pending.id, provider: pending.provider } } : {};
  }

  function request(provider: Provider) {
    if (closed) return Promise.reject(Error("Browser IP verification stopped."));
    return new Promise<string>((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => { if (pending?.id === id) pending.reject(Error("The browser did not complete IP verification.")); }, timeoutMs);
      pending = { id, provider,
        resolve(body) { clearTimeout(timer); pending = undefined; resolve(body); },
        reject(error) { clearTimeout(timer); pending = undefined; reject(error); } };
    });
  }

  async function check() {
    if (closed) throw Error("Browser IP verification stopped.");
    if (checking) throw Error("Browser IP verification is already pending.");
    checking = true;
    try {
      for (let attempt = 0; attempt < providers.length; attempt++) {
        const candidate = (provider + attempt) % providers.length;
        let value: { ip: string };
        try {
          const body = await request(providers[candidate]!);
          try { value = JSON.parse(body) as { ip: string }; }
          catch { value = { ip: /^ip=([^\r\n]+)$/m.exec(body)?.[1]?.trim() || "" }; }
          if (!value || typeof value.ip !== "string" || !isIP(value.ip)) throw Error("Invalid IP provider response");
        } catch {
          if (closed) throw Error("Browser IP verification stopped.");
          continue;
        }
        // A valid mismatch is evidence of a routing failure. Do not try another provider.
        if (expected && value.ip !== expected) throw Error("Browser exit IP does not match configured expected IP");
        provider = candidate;
        return value.ip;
      }
      throw Error("Browser exit IP verification failed at all configured providers");
    } finally { checking = false; }
  }

  return { check, close, exchange };
}
