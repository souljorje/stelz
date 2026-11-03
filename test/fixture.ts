import { ROOT } from "../src/config.ts";
import { join } from "node:path";
import type { Observation } from "./observations.ts";
export async function fixture(port = 9410) {
  const build = await Bun.build({ entrypoints: [join(ROOT, "test/fixture-browser.ts")], target: "browser" });
  if (!build.success) throw Error(build.logs.join("\n"));
  const script = await build.outputs[0]!.text();
  const observations = new Map<string, Observation>();
  const manualConfirmations = new Map<string, { trusted: boolean }>();
  const server = Bun.serve({ hostname: "127.0.0.1", port, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/observations" && request.method === "POST") {
      const { id, value } = await request.json() as { id: string; value: Observation };
      if (!/^[a-z0-9-]{1,128}$/.test(id) || !value || typeof value !== "object") return new Response("Invalid sample", { status: 400 });
      observations.set(id, value); return new Response(null, { status: 204 });
    }
    if (url.pathname === "/manual-confirmation" && request.method === "POST") {
      const value = await request.json() as { id: string; trusted: boolean };
      if (!/^[a-z0-9-]{1,128}$/.test(value.id) || value.trusted !== true) return new Response("Invalid confirmation", { status: 400 });
      manualConfirmations.set(value.id, { trusted: value.trusted }); return new Response(null, { status: 204 });
    }
    if (url.pathname === "/slow") await Bun.sleep(1500);
    if (url.pathname === "/fixture.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
    const challenge = crypto.randomUUID().slice(0, 8);
    const candidate = url.searchParams.get("profile") || "";
    const label = /^[a-z0-9-]{1,64}$/.test(candidate) ? ` — ${candidate}` : "";
    return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Camoufox acceptance fixture${label}</title>
<style>body{font:18px system-ui;max-width:850px;margin:40px auto;padding:20px;color:#17212b}button,input{font:inherit;margin:6px;padding:8px}pre{white-space:pre-wrap;background:#f2f4f5;padding:14px}section{margin:30px 0}</style>
<h1>Camoufox acceptance fixture${label}</h1><p>Harmless local test data. Challenge: <strong id="challenge">${challenge}</strong></p>
<button id="begin">Begin task</button><section id="task" hidden><label>Answer <input id="answer"></label><button id="submit">Check answer</button><p id="result" role="status">Waiting for an answer</p></section>
<section><h2>Profile storage</h2><form id="marker-form"><label>Profile marker <input id="marker" required></label><button id="save" type="submit">Save profile marker</button></form><p id="marker-status">Storage marker is incomplete</p><pre id="markers">Loading</pre></section>
<section><h2>Manual intervention</h2><button id="human">Human confirmation</button><p id="human-result">Waiting for human</p></section>
<section><h2>Observable fingerprint</h2><pre id="observations">Loading</pre></section><script type="module" src="/fixture.js"></script></html>`, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  } });
  return { observations, manualConfirmations, stop: () => server.stop() };
}
if (import.meta.main) { await fixture(); console.log("Fixture: http://127.0.0.1:9410 (keep this terminal running)"); }
