import { afterEach, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { prepareBrowser, readBrowserRelease } from "../../src/browser/browser-setup.ts";
import { browserAssetPattern, browserExecutable, browserPin, pairedBrowser } from "../../src/browser/camoufox.ts";
import { hash } from "../../src/browser/location.ts";
import { downloadReleaseAsset, readRelease, withReleaseFallback, type ReleaseAssetRequest } from "../../src/browser/release-asset.ts";
import releaseSources from "../../src/browser/release-sources.json" with { type: "json" };

const { ZipFile } = createRequire(new URL("../../package.json", import.meta.url))("yazl") as typeof import("yazl");
const homes: string[] = [];
const temp = () => { const home = mkdtempSync(join(tmpdir(), "stelz-browser-")); homes.push(home); return home; };
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const offline = (() => { throw Error("Unexpected network request"); }) as unknown as typeof fetch;
// A browser directory with the paired version, as upstream lays it out.
function browserFixture(directory: string, version = pairedBrowser()) {
  const executable = browserExecutable(directory);
  const resources = process.platform === "darwin" ? join(dirname(executable), "../Resources") : dirname(executable);
  mkdirSync(dirname(executable), { recursive: true }); mkdirSync(resources, { recursive: true });
  writeFileSync(executable, "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(join(resources, "application.ini"), `[App]\nVersion=${version}\n`);
  return executable;
}
function zipFixture() {
  const zip = new ZipFile(), chunks: Buffer[] = [];
  zip.addBuffer(Buffer.from("#!/bin/sh\n"), "Camoufox.app/Contents/MacOS/camoufox");
  zip.addBuffer(Buffer.from(`[App]\nVersion=${pairedBrowser()}\n`), "Camoufox.app/Contents/Resources/application.ini");
  const bytes = new Promise<Buffer>((resolve, reject) => zip.outputStream
    .on("data", (chunk: Buffer) => chunks.push(chunk)).on("end", () => resolve(Buffer.concat(chunks))).on("error", reject));
  zip.end();
  return bytes;
}

test("a configured browser must be the paired build", async () => {
  const home = temp(), unpaired = browserFixture(join(home, "unpaired"), "152.0.4-beta.30");
  // The error names the installed version and the required one, and the next step.
  await expect(prepareBrowser(home, join(home, "missing"), { request: offline })).rejects.toThrow(
    `The configured Camoufox is missing: ${join(home, "missing")}. Stelz requires Camoufox ${pairedBrowser()}. Run stelz setup to install it.`);
  await expect(prepareBrowser(home, unpaired, { request: offline })).rejects.toThrow(
    `Camoufox 152.0.4-beta.30 is installed, but it is not supported. Stelz requires Camoufox ${pairedBrowser()}. Run stelz setup to install it.`);
  const configured = browserFixture(join(home, "configured"));
  expect(await prepareBrowser(home, configured, { request: offline, installed: () => { throw Error("No cache read"); } }))
    .toEqual({ executable: configured, source: "configured" });
});

test("setup reuses its copy, or clones the paired upstream install without a download", async () => {
  const home = temp(), cache = join(home, "cache/paired");
  browserFixture(join(home, "cache/152"), "152.0.4-beta.30"); browserFixture(cache);
  const installed = () => [{ version: "152.0.4-beta.30", path: join(home, "cache/152") }, { version: pairedBrowser(), path: cache }];
  // An interrupted setup left a stage behind.
  mkdirSync(join(home, "browsers/.stage-old"), { recursive: true }); writeFileSync(join(home, "browsers/.stage-old/browser.zip"), "partial");
  const cloned = await prepareBrowser(home, undefined, { request: offline, installed });
  expect(cloned).toEqual({ executable: browserExecutable(join(home, "browsers", pairedBrowser())), source: "upstream-cache" });
  expect(existsSync(browserExecutable(cache))).toBe(true);
  expect(existsSync(join(home, "browsers/.stage-old"))).toBe(false);
  expect(await prepareBrowser(home, undefined, { request: offline, installed: () => { throw Error("No cache read"); } }))
    .toEqual({ ...cloned, source: "managed" });
});

test.skipIf(process.platform !== "darwin" || process.arch !== "arm64")("setup downloads and verifies the paired release, and keeps nothing on failure", async () => {
  const pin = browserPin(), bytes = await zipFixture(), asset = `camoufox-${pin.version}-${pin.build}-mac.arm64.zip`;
  expect(bytes.length).toBeGreaterThan(0);
  // The upstream release must match the pinned digest too. The fixture archive stands in for the pinned one.
  const pins = releaseSources.browser.sha256 as Record<string, string>, pinned = pins[asset]!;
  pins[asset] = hash(bytes);
  try {
  const request = (digest: string | null = hash(bytes), drop = false, corrupt = false) => (async (url: string) => {
    if (url === `https://api.github.com/repos/${pin.repo}/releases/tags/${pin.tag}`) return Response.json({ tag_name: pin.tag, assets: [
      { name: `camoufox-${pin.version}-${pin.build}-lin.x86_64.zip`, digest: `sha256:${"1".repeat(64)}`, size: 1, browser_download_url: "https://example.test/other" },
      { name: asset, ...(digest ? { digest: `sha256:${digest}` } : {}), size: bytes.length, browser_download_url: `https://github.com/${pin.repo}/releases/download/${pin.tag}/${asset}` }] });
    // A dropped connection ends the body after its first bytes.
    if (url === `https://github.com/${pin.repo}/releases/download/${pin.tag}/${asset}`) return new Response(drop
      ? new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(bytes.subarray(0, 8))); controller.error(Error("connection reset")); } })
      : new Uint8Array(corrupt ? [...bytes.subarray(0, -1), bytes.at(-1)! ^ 1] : bytes));
    if (drop && url.startsWith("https://api.github.com/repos/")) return new Response(null, { status: 404 });
    throw Error(`Unexpected request: ${url}`);
  }) as unknown as typeof fetch;
  const failure = async (digest: string | null, drop = false, corrupt = false) => {
    const home = temp();
    const message = await prepareBrowser(home, undefined, { request: request(digest, drop, corrupt), installed: () => [] }).then(() => "resolved", (error: unknown) => String(error));
    return { message, kept: readdirSync(join(home, "browsers")) };
  };
  expect(await failure(null)).toEqual({ message: expect.stringContaining("has no published SHA-256 digest"), kept: [] });
  // Another owner of the upstream name cannot publish other bytes for the pinned build.
  expect(await failure("0".repeat(64))).toEqual({ message: expect.stringContaining("has an unexpected SHA-256 digest"), kept: [] });
  expect(await failure(hash(bytes), false, true)).toEqual({ message: expect.stringContaining("integrity check failed"), kept: [] });
  expect(await failure(hash(bytes), true)).toEqual({ message: expect.stringContaining("Cannot download Camoufox (connection reset). Check the connection"), kept: [] });
  const home = temp(), result = await prepareBrowser(home, undefined, { request: request(), installed: () => [] });
  expect(result.source).toBe("downloaded");
  expect(statSync(result.executable).mode & 0o111).not.toBe(0);
  expect(JSON.parse(readFileSync(join(home, "browsers", pairedBrowser(), "version.json"), "utf8"))).toMatchObject({ asset, sha256: hash(bytes) });
  } finally { pins[asset] = pinned; }
});

test.each(["restored", "archive", "bad-digest"] as const)("browser release fallback handles %s", async scenario => {
  const pin = browserPin();
  const primary = { repository: pin.repo, tag: pin.tag };
  const restored = { repository: "CamoufoxCloud/camoufox", tag: pin.tag };
  const archive = { repository: "jo-inc/camofox-browser", tag: "camoufox-backup-428447379" };
  const sources = [primary, restored, archive];
  const pattern = browserAssetPattern();
  const [name, digest] = Object.entries(releaseSources.browser.sha256).find(([name]) => pattern.test(name))!;
  const visited: string[] = [];
  const request = (async (url: string) => {
    const source = sources.find(({ repository, tag }) => url === `https://api.github.com/repos/${repository}/releases/tags/${tag}`)!;
    visited.push(source.repository);
    if (source === primary) return new Response(null, { status: 404 });
    return Response.json({ tag_name: source.tag, assets: source === restored && scenario === "archive" ? [] : [
      { name, size: 1, digest: `sha256:${scenario === "bad-digest" ? "0".repeat(64) : digest}`,
        browser_download_url: `https://github.com/${source.repository}/releases/download/${source.tag}/${name}` },
    ] });
  }) as unknown as typeof fetch;
  const result = readBrowserRelease(request);
  if (scenario === "bad-digest") await expect(result).rejects.toThrow("unexpected SHA-256 digest");
  else await expect(result).resolves.toMatchObject({ origin: (scenario === "archive" ? archive : restored).repository });
  expect(visited).toEqual(sources.slice(0, scenario === "archive" ? 3 : 2).map(source => source.repository));
});

test.each(["valid", "wrong digest", "HTTP asset"] as const)("the HTTPS manifest fallback handles a %s asset", async scenario => {
  const manifest = "https://mirror.example.test/releases/v1.json", url = "https://files.example.test/browser.zip";
  const name = "browser.zip", bytes = Buffer.from("fixture"), sha256 = hash(bytes), tag = "v1";
  const options = { label: "Camoufox", match: (asset: string) => asset === name, maxBytes: 32, timeoutMs: 1000 };
  const sources: ReleaseAssetRequest[] = [
    { ...options, url: "https://github.com/owner/project/releases/tag/v1" },
    { ...options, url: manifest, sha256: { [name]: sha256 } },
  ];
  const visited: string[] = [];
  const request = (async (target: string) => {
    visited.push(target);
    if (target === "https://api.github.com/repos/owner/project/releases/tags/v1") return new Response(null, { status: 404 });
    if (target === manifest) return Response.json({ tag, assets: [{ name, size: bytes.length,
      sha256: scenario === "wrong digest" ? "0".repeat(64) : sha256,
      url: scenario === "HTTP asset" ? url.replace("https:", "http:") : url }] });
    if (target === url) return new Response(bytes);
    throw Error(`Unexpected request: ${target}`);
  }) as unknown as typeof fetch;
  const file = join(temp(), name);
  const download = withReleaseFallback(sources, async source => downloadReleaseAsset(source, await readRelease(source, request), file, request));
  if (scenario === "valid") {
    await expect(download).resolves.toMatchObject({ origin: manifest, release: tag, sha256 });
    expect(readFileSync(file)).toEqual(bytes);
    expect(visited.slice(1)).toEqual([manifest, url]);
  } else {
    await expect(download).rejects.toThrow(scenario === "wrong digest" ? "unexpected SHA-256 digest" : "unexpected metadata");
    expect(existsSync(file)).toBe(false);
    expect(visited.slice(1)).toEqual([manifest]);
  }
});

test("a GitHub rate limit names the limit instead of the connection", async () => {
  const limited = (async () => new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1794316800" } })) as unknown as typeof fetch;
  await expect(readRelease({ label: "location-data", url: "https://github.com/owner/name/releases/latest", match: () => true, maxBytes: 1, timeoutMs: 1000 }, limited))
    .rejects.toThrow("GitHub limits release requests from this network. Run stelz setup again after");
});
