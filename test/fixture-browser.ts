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
    const request = value === undefined ? store.get("identity") : store.put(value, "identity");
    let result: string | undefined;
    request.onsuccess = () => { result = request.result as string | undefined; };
    transaction.oncomplete = () => { database.close(); resolve(result); };
    transaction.onerror = () => { database.close(); reject(transaction.error); };
  });
}
async function refresh() {
  const value = await indexed();
  el("markers").textContent = JSON.stringify({ cookie: document.cookie, localStorage: localStorage.getItem("identity"), indexedDB: value }, null, 2);
  el("marker-status").textContent = value && localStorage.getItem("identity") === value && document.cookie.includes(`identity=${encodeURIComponent(value)}`) ? `Storage marker: ${value}` : "Storage marker is incomplete";
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
  document.cookie = `identity=${encodeURIComponent(value)}; Max-Age=604800; Path=/; SameSite=Lax`;
  localStorage.setItem("identity", value); await indexed(value); await refresh();
};
el("human").onclick = async event => {
  el("human-result").textContent = "Human confirmation received";
  const id = new URL(location.href).searchParams.get("manual");
  if (id) await fetch("/manual-confirmation", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, trusted: event.isTrusted }) });
};
const canvas = document.createElement("canvas"); canvas.width = 240; canvas.height = 60;
const draw = canvas.getContext("2d")!; draw.font = "16px Arial"; draw.fillStyle = "#123456"; draw.fillText("Camoufox profile continuity", 8, 30);
const digest = async (value: BufferSource) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", value))).map(v => v.toString(16).padStart(2, "0")).join("");
async function observe() {
  const gl = document.createElement("canvas").getContext("webgl"); const ext = gl?.getExtension("WEBGL_debug_renderer_info");
  const gl2 = document.createElement("canvas").getContext("webgl2"); const ext2 = gl2?.getExtension("WEBGL_debug_renderer_info");
  let audio = "unavailable";
  try {
    const context = new OfflineAudioContext(1, 2048, 44100), oscillator = context.createOscillator();
    oscillator.frequency.value = 440; oscillator.connect(context.destination); oscillator.start();
    audio = await digest((await context.startRendering()).getChannelData(0).buffer);
  } catch {}
  const value = {
    userAgent: navigator.userAgent, platform: navigator.platform, hardwareConcurrency: navigator.hardwareConcurrency,
    languages: navigator.languages, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    screen: { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight, colorDepth: screen.colorDepth },
    window: { innerWidth, innerHeight, outerWidth, outerHeight, devicePixelRatio }, webdriver: navigator.webdriver,
    webgl: gl && ext ? { vendor: gl.getParameter(ext.UNMASKED_VENDOR_WEBGL), renderer: gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) } : null,
    webgl2: gl2 && ext2 ? { vendor: gl2.getParameter(ext2.UNMASKED_VENDOR_WEBGL), renderer: gl2.getParameter(ext2.UNMASKED_RENDERER_WEBGL) } : null,
    canvas: await digest(new TextEncoder().encode(canvas.toDataURL())), audio,
    ...(new URL(location.href).searchParams.has("network") ? {
      exitIp: (await (await fetch("https://api.ipify.org?format=json", { cache: "no-store" })).json() as { ip: string }).ip,
      webRTCEnabled: typeof RTCPeerConnection !== "undefined",
    } : {}),
  };
  el("observations").textContent = JSON.stringify(value, null, 2);
  const id = new URL(location.href).searchParams.get("capture");
  if (id) await fetch("/observations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, value }) });
}
void refresh(); void observe();
