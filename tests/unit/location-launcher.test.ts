import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";

function ipHelper(reply: (url: string, init: RequestInit) => Promise<Response>, proxies: unknown[]) {
  const source = readFileSync("node_modules/camoufox-js/dist/ip.js", "utf8").replace(/^import .+;$/gm, "").replaceAll("export ", "");
  class Impit { constructor(options: { proxyUrl: string }) { proxies.push(options.proxyUrl); } fetch = reply; }
  return new Function("Impit", "isIP", `${source};return publicIP;`)(Impit, isIP) as (proxy: string, options?: { signal: AbortSignal }) => Promise<string>;
}
test("the pinned IP helper keeps every retry on the configured proxy and rejects malformed addresses", async () => {
  const proxies: unknown[] = [], requests: string[] = [], signal = new AbortController().signal;
  const publicIP = ipHelper(async (url, init) => { requests.push(url); expect(init.signal).toBe(signal); return new Response("999.999.1.1"); }, proxies);
  await expect(publicIP("http://fixture:password@proxy.test:80", { signal })).rejects.toMatchObject({ code: "IP_DETECTION_FAILED" });
  expect(requests.length).toBe(6); expect(proxies).toEqual(["http://fixture:password@proxy.test:80"]);
});
test("the pinned IP helper stops on proxy authentication and cancellation", async () => {
  let count = 0;
  const publicIP = ipHelper(async () => { count++; return new Response("", { status: 407 }); }, []);
  await expect(publicIP("http://proxy.test:80")).rejects.toMatchObject({ code: "PROXY_AUTHENTICATION" });
  expect(count).toBe(1);
  const controller = new AbortController(); controller.abort();
  await expect(publicIP("http://proxy.test:80", { signal: controller.signal })).rejects.toThrow(); expect(count).toBe(1);
});
test("the real Camofox launch preparation propagates GeoIP failures without retrying disabled", async () => {
  const server = readFileSync("node_modules/@askjo/camofox-browser/server.js", "utf8");
  const source = server.slice(server.indexOf("async function buildLaunchOptionsWithGeoipFallback"), server.indexOf("async function launchBrowserInstance"))
    .replace("(await import('./plugins/local-profile/index.js'))", "plugin");
  const options: unknown[] = [], prepared = { geoip: "198.51.100.10", stelzGeoip: { timezone: "Europe/London" } };
  const build = new Function("plugin", "launchOptions", "withTimeout", "GEOIP_SETUP_TIMEOUT_MS", `${source};return buildLaunchOptionsWithGeoipFallback;`)(
    { prepareProfileLaunch: async (_base: unknown, prepare: (value: unknown) => Promise<unknown>) => prepare(prepared) }, async (value: unknown) => { options.push(value); throw Error("Unknown IP location"); }, (work: unknown) => work, 30000);
  await expect(build({ geoip: true, proxy: { server: "http://proxy.test:80" } })).rejects.toThrow("Unknown IP location");
  expect(options).toEqual([prepared]);
});
