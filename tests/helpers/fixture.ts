import { join, resolve } from "node:path";
import type { Observation } from "./observations.ts";
const ROOT = resolve(import.meta.dir, "../..");

/** What the page reports after each input: the values of its typing fields, every input event, and the form submissions. */
export type InputSample = { key: string; sequence: number; values: Record<string, string>;
  events: { type: string; target: string; key: string; trusted: boolean; at: number }[]; submits: number };

/**
 * The one page of the browser checks. All sections are in one scroll container below a fixed header, so a scroll moves a nested feed.
 * Query: `profile` labels the title, `capture` posts device observations, `input` reports typing, `manual` reports a human click,
 * and `pagination` adds 900 rows.
 * `/slow` serves the same page late. tests/helpers/fixture-browser.ts is the script of the page.
 */
export async function fixture(port: number) {
  const build = await Bun.build({ entrypoints: [join(ROOT, "tests/helpers/fixture-browser.ts")], target: "browser" });
  if (!build.success) throw Error(build.logs.join("\n"));
  const script = await build.outputs[0]!.text();
  const observations = new Map<string, Observation>();
  const manualConfirmations = new Map<string, { trusted: boolean }>();
  // The last report of each input key. A check gives each page load its own key.
  const input = new Map<string, InputSample>();
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
    if (url.pathname === "/sample" && request.method === "POST") {
      const next = await request.json() as InputSample;
      const last = input.get(next.key);
      if (!last || next.sequence > last.sequence) input.set(next.key, next);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/fixture.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
    if (url.pathname === "/slow") await Bun.sleep(1500);
    else if (url.pathname !== "/") return new Response(null, { status: 404 });
    const candidate = url.searchParams.get("profile") || "";
    const label = /^[a-z0-9-]{1,64}$/.test(candidate) ? ` — ${candidate}` : "";
    const pagination = url.searchParams.has("pagination")
      ? Array.from({ length: 900 }, (_, index) => `<p>Pagination row ${index}: independent browser state and observation coverage.</p>`).join("") : "";
    return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Camoufox acceptance fixture${label}</title>
<style>body{margin:0;overflow:hidden;font:18px system-ui}header{height:100px}main{position:absolute;top:100px;bottom:0;left:0;right:0;overflow:auto}article{width:6000px;min-height:6000px;padding:0 20px}
section{margin:30px 0}button,input,textarea{font:inherit;margin:6px;padding:8px}label{display:block}#editable{border:1px solid;padding:10px;width:400px}</style>
<header><button id="header">Header control</button><p id="position">Scroll position: x=0 y=0</p></header>
<main><article><h1>Camoufox acceptance fixture${label}</h1><p>Harmless local test data.</p>
<button id="begin">Reveal controls</button><section id="task" hidden><label>Extra field <input></label><button>Extra action</button></section>
<section><h2>Profile storage</h2><form id="marker-form"><label>Profile marker <input id="marker" required></label><button id="save" type="submit">Save profile marker</button></form><p id="marker-status">Storage marker is incomplete</p></section>
<section><h2>Manual intervention</h2><button id="human">Human confirmation</button><p id="human-result">Waiting for human</p></section>
<section id="targets"><h2>Targets</h2>
<button class="add">Add item</button><button class="add">Add item</button><button disabled>Disabled action</button>
<button id="mark">Mark done</button><p id="status" role="status">Waiting</p>
<label>Note <input id="note"></label><p id="echo">Echo: none</p><button id="reveal">Reveal later</button></section>
<section><h2>Typing</h2><form id="typing-form"><label>Message <input id="message" value="old value"></label><button>Submit message</button></form>
<label>Multiline <textarea id="multiline">old value</textarea></label>
<div id="editable" contenteditable="true" role="textbox" aria-label="Editable message">old value</div>
<label>Number <input id="number" type="number" value="1"></label>
<label>Date <input id="date" type="date" value="2026-01-01"></label></section>${pagination}
</article></main><script type="module" src="/fixture.js"></script></html>`, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  } });
  return { url: `http://127.0.0.1:${server.port}`, observations, manualConfirmations, input, stop: () => server.stop() };
}
