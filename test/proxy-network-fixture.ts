import { createServer, connect, type Socket } from "node:net";
import { assert, type ProbeResult } from "./proxy-acceptance-helpers.ts";

// Self-contained so the localhost fixture runs the same probe in the browser.
export async function probeExit(request: (url: string, init: { cache: "no-store"; signal: AbortSignal }) => Promise<{ ok: boolean; text(): Promise<string> }>, nonce: string): Promise<ProbeResult> {
  const providers = [
    { name: "ipify", url: "https://api.ipify.org?format=json" },
    { name: "cloudflare", url: "https://www.cloudflare.com/cdn-cgi/trace" },
  ];
  let invalid = false, httpError = false;
  for (const provider of providers) {
    try {
      const url = new URL(provider.url); url.searchParams.set("proxy-acceptance", nonce);
      const response = await request(url.href, { cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (!response.ok) { httpError = true; continue; }
      try {
        const body = await response.text();
        const ip: unknown = provider.name === "ipify" ? JSON.parse(body)?.ip : /^ip=([^\r\n]+)$/m.exec(body)?.[1]?.trim();
        const valid = typeof ip === "string" && (
          /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) && ip.split(".").every(part => String(Number(part)) === part && Number(part) <= 255) ||
          /^[\da-f:]+$/i.test(ip) && ip.includes(":") && URL.canParse(`http://[${ip}]/`));
        if (valid) return { outcome: "success", ip: ip as string, provider: provider.name };
      } catch {}
      invalid = true;
    } catch {}
  }
  return { outcome: invalid ? "invalid-response" : httpError ? "http-error" : "network-error" };
}

export function proxyRelay(endpoint: URL) {
  const sockets = new Set<Socket>();
  let port = 0, sent = 0, received = 0;
  const server = createServer(incoming => {
    const upstream = connect(Number(endpoint.port || 80), endpoint.hostname.replace(/^\[|\]$/g, ""));
    for (const socket of [incoming, upstream]) {
      sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    }
    incoming.on("data", data => { sent += data.length; });
    upstream.on("data", data => { received += data.length; });
    incoming.on("error", () => upstream.destroy()); upstream.on("error", () => incoming.destroy());
    incoming.on("close", () => upstream.destroy()); upstream.on("close", () => incoming.destroy());
    incoming.pipe(upstream).pipe(incoming);
  });
  return {
    async start() {
      assert(!server.listening, "Proxy relay is already listening.");
      await new Promise<void>((resolve, reject) => {
        const failed = () => { server.off("listening", listening); reject(Error("Cannot bind the test proxy relay.")); };
        const listening = () => { server.off("error", failed); resolve(); };
        server.once("error", failed); server.once("listening", listening); server.listen(port, "127.0.0.1");
      });
      const address = server.address(); assert(address && typeof address !== "string", "Proxy relay has no address.");
      port = address.port;
    },
    async stop() {
      const closed = server.listening ? new Promise<void>((resolve, reject) => server.close(error => error ? reject(Error("Cannot close the test proxy relay.")) : resolve())) : Promise.resolve();
      for (const socket of sockets) socket.destroy();
      await closed;
    },
    url() {
      assert(port, "Proxy relay has not started.");
      const url = new URL(endpoint); url.hostname = "127.0.0.1"; url.port = String(port); return url.href;
    },
    traffic: () => ({ sent, received }),
  };
}

export function assertRelayTraffic(before: { sent: number; received: number }, after: { sent: number; received: number }) {
  assert(after.sent > before.sent && after.received > before.received, "The profile's own relay did not carry fresh network traffic.");
}

export async function unusedPorts(count: number) {
  const servers: ReturnType<typeof createServer>[] = [];
  try {
    const ports: number[] = [];
    for (let n = 0; n < count; n++) {
      const server = createServer(); servers.push(server);
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      const address = server.address(); assert(address && typeof address !== "string", "Test port reservation failed.");
      ports.push(address.port);
    }
    return ports;
  } finally {
    await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  }
}

// This localhost page observes browser routing even while MCP actions are blocked.
// Every job fetches a new, uncached URL and reports an explicit result with its nonce.
export function networkProbe(timeoutMs = 25000) {
  type Job = { id: string; resolve: (result: ProbeResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; dispatched: boolean };
  const channels = new Map<string, Job | undefined>();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url), token = url.searchParams.get("channel") || "";
    const headers = { "Cache-Control": "no-store" };
    if (!channels.has(token)) return new Response("Unknown probe channel", { status: 404, headers });
    if (url.pathname === "/next" && request.method === "GET") {
      const job = channels.get(token);
      if (!job || job.dispatched) return Response.json(null, { headers });
      job.dispatched = true;
      return Response.json({ id: job.id }, { headers });
    }
    if (url.pathname === "/result" && request.method === "POST") {
      let value: { id?: string; result?: ProbeResult };
      try { value = await request.json() as typeof value; }
      catch { return new Response("Invalid probe result", { status: 400, headers }); }
      const job = channels.get(token), result = value.result;
      if (!job || !job.dispatched || value.id !== job.id || !result ||
        !["success", "network-error", "http-error", "invalid-response"].includes(result.outcome) ||
        result.outcome === "success" && typeof result.ip !== "string") return new Response("Invalid probe result", { status: 400, headers });
      clearTimeout(job.timer); channels.set(token, undefined);
      job.resolve({ ...(result.outcome === "success" ? { outcome: "success", ip: result.ip } : { outcome: result.outcome }),
        ...(typeof result.webRTCEnabled === "boolean" ? { webRTCEnabled: result.webRTCEnabled } : {}),
        ...(result.provider === "ipify" || result.provider === "cloudflare" ? { provider: result.provider } : {}) });
      return new Response(null, { status: 204, headers });
    }
    if (url.pathname !== "/probe") return new Response("Not found", { status: 404, headers });
    return new Response(`<!doctype html><meta charset="utf-8"><title>Independent proxy network probe</title>
<p>Browser routing probe. Keep this test tab open.</p><script type="module">
const channel = new URL(location.href).searchParams.get("channel");
const probeExit = (${probeExit.toString()});
for (;;) {
  try {
    const job = await (await fetch("/next?channel=" + channel, { cache: "no-store" })).json();
    if (job) {
      const result = await probeExit(fetch, job.id);
      result.webRTCEnabled = typeof RTCPeerConnection !== "undefined";
      await fetch("/result?channel=" + channel, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: job.id, result }) });
    }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 100));
}
</script>`, { headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
  } });
  return {
    channel() {
      const token = crypto.randomUUID(); channels.set(token, undefined);
      return {
        url: `http://127.0.0.1:${server.port}/probe?channel=${token}`,
        sample(): Promise<ProbeResult> {
          assert(channels.has(token) && !channels.get(token), "Network probe channel is unavailable or busy.");
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { channels.set(token, undefined); reject(Error("The independent browser network probe did not report a result.")); }, timeoutMs);
            channels.set(token, { id: crypto.randomUUID(), resolve, reject, timer, dispatched: false });
          });
        },
      };
    },
    stop() {
      for (const job of channels.values()) if (job) { clearTimeout(job.timer); job.reject(Error("Network probe stopped.")); }
      channels.clear(); server.stop(true);
    },
  };
}
