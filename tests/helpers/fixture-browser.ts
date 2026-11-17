const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const challenge = el("challenge").textContent!;
const db = () => new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open("stelz-fixture", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("markers");
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});
async function indexed(value?: string) {
  const database = await db();
  return new Promise<string | undefined>((resolve, reject) => {
    const transaction = database.transaction("markers", value === undefined ? "readonly" : "readwrite");
    const store = transaction.objectStore("markers");
    const request = value === undefined ? store.get("profile") : store.put(value, "profile");
    let result: string | undefined;
    request.onsuccess = () => { result = request.result as string | undefined; };
    transaction.oncomplete = () => { database.close(); resolve(result); };
    transaction.onerror = () => { database.close(); reject(transaction.error); };
  });
}
async function storage() {
  return { cookie: document.cookie, localStorage: localStorage.getItem("profile"), indexedDB: await indexed() ?? null };
}
async function refresh() {
  const values = await storage(), value = values.indexedDB;
  el("marker-status").textContent = value && localStorage.getItem("profile") === value && document.cookie.includes(`profile=${encodeURIComponent(value)}`) ? `Storage marker: ${value}` : "Storage marker is incomplete";
}
el("begin").onclick = () => { el("task").hidden = false; el<HTMLInputElement>("answer").focus(); };
el("submit").onclick = () => {
  const answer = el<HTMLInputElement>("answer").value;
  el("result").textContent = answer.endsWith(challenge) ? `Verified: ${answer}` : "Answer must end with the displayed challenge";
};
el<HTMLFormElement>("marker-form").onsubmit = async event => {
  event.preventDefault();
  const value = el<HTMLInputElement>("marker").value;
  // A delayed native click after navigation must not erase the persisted test marker.
  if (!value) return;
  document.cookie = `profile=${encodeURIComponent(value)}; Max-Age=604800; Path=/; SameSite=Lax`;
  localStorage.setItem("profile", value); await indexed(value); await refresh();
};
el("human").onclick = async event => {
  el("human-result").textContent = "Human confirmation received";
  const id = new URL(location.href).searchParams.get("manual");
  if (id) await fetch("/manual-confirmation", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, trusted: event.isTrusted }) });
};
const digest = async (value: BufferSource) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", value))).map(v => v.toString(16).padStart(2, "0")).join("");
const query = new URL(location.href).searchParams;
const requestedSamples = Number(query.get("samples") ?? 1);
const sampleCount = Number.isInteger(requestedSamples) && requestedSamples >= 1 && requestedSamples <= 8 ? requestedSamples : 1;
const documentId = crypto.randomUUID();
async function observe(index: number) {
  const errors: Record<string, string> = {};
  const webgl = (kind: "webgl" | "webgl2") => {
    let gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
    try {
      const canvas = document.createElement("canvas");
      gl = kind === "webgl" ? canvas.getContext("webgl") : canvas.getContext("webgl2");
      const ext = gl?.getExtension("WEBGL_debug_renderer_info");
      return gl && ext ? { vendor: gl.getParameter(ext.UNMASKED_VENDOR_WEBGL), renderer: gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) } : null;
    } catch (error) { errors[kind] = String(error); return null; }
    finally {
      try { gl?.getExtension("WEBGL_lose_context")?.loseContext(); }
      catch (error) { errors[kind] = String(error); }
    }
  };
  // Each sample uses new rendering resources. No hashes or generated settings are reused.
  let canvasHash: string | null = null, audio: string | null = null;
  try {
    const canvas = document.createElement("canvas"); canvas.width = 240; canvas.height = 60;
    const draw = canvas.getContext("2d"); if (!draw) throw Error("2D canvas context is unavailable");
    draw.font = "16px Arial"; draw.fillStyle = "#123456"; draw.fillText("Camoufox profile continuity", 8, 30);
    canvasHash = await digest(new TextEncoder().encode(canvas.toDataURL()));
  } catch (error) { errors.canvas = String(error); }
  try {
    const context = new OfflineAudioContext(1, 2048, 44100), oscillator = context.createOscillator();
    oscillator.frequency.value = 440; oscillator.connect(context.destination); oscillator.start();
    audio = await digest((await context.startRendering()).getChannelData(0).buffer);
    oscillator.disconnect();
  } catch (error) { errors.audio = String(error); }
  let markers = null;
  try { markers = await storage(); } catch (error) { errors.storage = String(error); }
  // A proxied profile has a configured location. The page must still ask before it can read it.
  let geolocation = "unavailable";
  try { geolocation = (await navigator.permissions.query({ name: "geolocation" })).state; } catch (error) { errors.geolocation = String(error); }
  const id = query.get("capture");
  const captureId = id && sampleCount > 1 ? `${id}-${index}` : id;
  const value = {
    userAgent: navigator.userAgent, platform: navigator.platform, hardwareConcurrency: navigator.hardwareConcurrency,
    languages: navigator.languages, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    screen: { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight, colorDepth: screen.colorDepth },
    window: { innerWidth, innerHeight, outerWidth, outerHeight, devicePixelRatio }, webdriver: navigator.webdriver,
    webgl: webgl("webgl"), webgl2: webgl("webgl2"), canvas: canvasHash, audio,
    geolocation, storage: markers, errors,
    measurement: { recipe: "stelz-fixture-v2", captureId, documentId, sampleIndex: index, sampleCount,
      capturedAt: new Date().toISOString(), timeOrigin: performance.timeOrigin, elapsedMs: performance.now(),
      origin: location.origin, documentURL: location.href, visibility: document.visibilityState,
      fonts: document.fonts.status, secureContext: isSecureContext },
    ...(query.has("network") ? {
      exitIp: (await (await fetch("https://api.ipify.org?format=json", { cache: "no-store" })).json() as { ip: string }).ip,
      webRTCEnabled: typeof RTCPeerConnection !== "undefined",
    } : {}),
  };
  if (captureId) {
    const response = await fetch("/observations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: captureId, value }) });
    if (!response.ok) throw Error(`Observation upload failed: ${response.status}`);
  }
}
async function observations() {
  await document.fonts.ready;
  for (let index = 1; index <= sampleCount; index++) await observe(index);
}
// The feed reports its scroll position in the fixed header.
const feed = document.querySelector("main")!;
feed.addEventListener("scroll", () => { el("position").textContent = `Scroll position: x=${Math.round(feed.scrollLeft)} y=${Math.round(feed.scrollTop)}`; });
// Targets. These controls change only the DOM.
document.querySelectorAll<HTMLElement>(".add").forEach((button, index) => { button.onclick = () => { el("status").textContent = `Added by button ${index}`; }; });
el("mark").onclick = () => { el("status").textContent = "Marked"; };
el("note").oninput = () => { el("echo").textContent = `Echo: ${el<HTMLInputElement>("note").value}`; };
el("reveal").onclick = () => setTimeout(() => { const late = document.createElement("button"); late.textContent = "Late button"; el("targets").append(late); }, 1200);
// Typing. The page reports the field values, every input event, and the submissions after each change.
const generation = Number(document.documentElement.dataset.generation);
const events: { type: string; target: string; key: string; trusted: boolean; at: number }[] = [];
let submits = 0, sequence = 0, timer: ReturnType<typeof setTimeout> | undefined;
function publish() {
  const values = Object.fromEntries(["message", "multiline", "editable", "number", "date"].map(id => {
    const field = el<HTMLInputElement>(id); return [id, field.value === undefined ? field.textContent : field.value];
  }));
  el("submissions").textContent = `Submissions: ${submits}`;
  void fetch("/sample", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ generation, sequence: ++sequence, values, events, submits }) });
}
for (const type of ["input", "beforeinput", "keydown", "keypress", "keyup"]) document.addEventListener(type, event => {
  events.push({ type, target: (event.target as HTMLElement).id, key: (event as KeyboardEvent).key || "", trusted: event.isTrusted, at: performance.now() });
  clearTimeout(timer); timer = setTimeout(publish, 50);
});
el<HTMLFormElement>("typing-form").onsubmit = event => { event.preventDefault(); submits++; publish(); };
publish();
// The device probes run only for a capture.
void refresh(); if (query.get("capture")) void observations();
