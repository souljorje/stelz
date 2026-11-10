import { afterEach, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { prepareBrowser } from "../../src/browser/browser-setup.ts";
import { browserExecutable, browserPin, pairedBrowser } from "../../src/browser/camoufox.ts";
import { hash } from "../../src/browser/location.ts";
import { readRelease } from "../../src/browser/release-asset.ts";

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
  await expect(prepareBrowser(home, join(home, "missing"), { request: offline })).rejects.toThrow("Correct or remove CAMOUFOX_EXECUTABLE");
  await expect(prepareBrowser(home, unpaired, { request: offline })).rejects.toThrow("is not supported");
  const configured = browserFixture(join(home, "configured"));
  expect(await prepareBrowser(home, configured, { request: offline, installed: () => { throw Error("No cache read"); } }))
    .toEqual({ executable: configured, source: "configured" });
});

test("setup reuses its copy, or clones the paired upstream install without a download", async () => {
  const home = temp(), cache = join(home, "cache/156");
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
  const request = (digest: string | null = hash(bytes), drop = false) => (async (url: string) => {
    if (url === `https://api.github.com/repos/${pin.repo}/releases/tags/${pin.tag}`) return Response.json({ tag_name: pin.tag, assets: [
      { name: `camoufox-${pin.version}-${pin.build}-lin.x86_64.zip`, digest: `sha256:${"1".repeat(64)}`, size: 1, browser_download_url: "https://example.test/other" },
      { name: asset, ...(digest ? { digest: `sha256:${digest}` } : {}), size: bytes.length, browser_download_url: `https://github.com/${pin.repo}/releases/download/${pin.tag}/${asset}` }] });
    // A dropped connection ends the body after its first bytes.
    if (url === `https://github.com/${pin.repo}/releases/download/${pin.tag}/${asset}`) return new Response(drop
      ? new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(bytes.subarray(0, 8))); controller.error(Error("connection reset")); } })
      : new Uint8Array(bytes));
    throw Error(`Unexpected request: ${url}`);
  }) as unknown as typeof fetch;
  const failure = async (digest: string | null, drop = false) => {
    const home = temp();
    const message = await prepareBrowser(home, undefined, { request: request(digest, drop), installed: () => [] }).then(() => "resolved", (error: unknown) => String(error));
    return { message, kept: readdirSync(join(home, "browsers")) };
  };
  expect(await failure(null)).toEqual({ message: expect.stringContaining("has no published SHA-256 digest"), kept: [] });
  expect(await failure("0".repeat(64))).toEqual({ message: expect.stringContaining("integrity check failed"), kept: [] });
  expect(await failure(hash(bytes), true)).toEqual({ message: expect.stringContaining("Cannot download Camoufox (connection reset). Check the connection"), kept: [] });
  const home = temp(), result = await prepareBrowser(home, undefined, { request: request(), installed: () => [] });
  expect(result.source).toBe("downloaded");
  expect(statSync(result.executable).mode & 0o111).not.toBe(0);
  expect(JSON.parse(readFileSync(join(home, "browsers", pairedBrowser(), "version.json"), "utf8"))).toMatchObject({ asset, sha256: hash(bytes) });
});

test("a GitHub rate limit names the limit instead of the connection", async () => {
  const limited = (async () => new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1794316800" } })) as unknown as typeof fetch;
  await expect(readRelease({ label: "location-data", repository: "owner/name", match: () => true, maxBytes: 1, timeoutMs: 1000 }, limited))
    .rejects.toThrow("GitHub limits release requests from this network. Run stelz setup again after");
});
