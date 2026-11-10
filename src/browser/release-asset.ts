import { createHash } from "node:crypto";
import { closeSync, constants, fsyncSync, openSync, rmSync, writeSync } from "node:fs";

export type ReleaseAssetRequest = {
  label: string; repository: string; tag?: string; match: (name: string) => boolean; maxBytes: number; timeoutMs: number;
};
type Asset = { name: string; digest?: string; size: number; browser_download_url: string };
export type Release = { tag: string; asset: Asset & { digest: string } };

/** Read one GitHub release and check its single matching asset. Only a published SHA-256 digest is acceptable. */
export async function readRelease(request: ReleaseAssetRequest, fetcher: typeof fetch = fetch, signal = AbortSignal.timeout(30_000)): Promise<Release> {
  const { label, repository } = request, unavailable = `Check the connection and run stelz setup again.`;
  const response = await fetcher(`https://api.github.com/repos/${repository}/releases/${request.tag ? `tags/${request.tag}` : "latest"}`,
    { signal, headers: { Accept: "application/vnd.github+json" } })
    .catch((error: Error) => { throw Error(`Cannot read the ${label} release (${error.message}). ${unavailable}`); });
  if (!response.ok) {
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    if ([403, 429].includes(response.status) && response.headers.get("x-ratelimit-remaining") === "0")
      throw Error(`GitHub limits release requests from this network. Run stelz setup again after ${reset > 0 ? new Date(reset * 1000).toLocaleTimeString() : "an hour"}.`);
    throw Error(`Cannot read the ${label} release. ${unavailable}`);
  }
  const value = await response.json() as { tag_name?: string; assets?: Asset[] };
  const assets = value.assets?.filter(asset => request.match(asset.name)) ?? [];
  const asset = assets[0], tag = value.tag_name ?? "";
  const invalid = (reason: string) => Error(`The ${label} release ${tag || "(unknown)"} ${reason}. Run stelz setup again after the release is available.`);
  if (!/^[\w.-]+$/.test(tag) || (request.tag && tag !== request.tag)) throw invalid(`does not match the expected release ${request.tag ?? "latest"}`);
  if (assets.length !== 1 || !asset) throw invalid(`has ${assets.length} matching assets for this platform instead of one`);
  // Upstream skips verification without a digest. Stelz refuses the download.
  if (!/^sha256:[a-f0-9]{64}$/.test(asset.digest || "")) throw invalid(`has no published SHA-256 digest for ${asset.name}`);
  if (asset.browser_download_url !== `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(asset.name)}` ||
    !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > request.maxBytes) throw invalid(`has unexpected metadata for ${asset.name}`);
  return { tag, asset: asset as Release["asset"] };
}

/**
 * Download one GitHub release asset to a new file and verify the SHA-256 digest that GitHub publishes for it.
 * A missing digest, an unexpected URL, or a size or digest mismatch fails and removes the file.
 */
export async function downloadReleaseAsset(request: ReleaseAssetRequest, file: string, fetcher: typeof fetch = fetch, release?: Release) {
  const { label } = request, signal = AbortSignal.timeout(request.timeoutMs);
  const { tag, asset } = release ?? await readRelease(request, fetcher, signal);
  const unavailable = (error?: Error) => Error(`Cannot download ${label}${error ? ` (${error.message})` : ""}. Check the connection and run stelz setup again.`);
  const response = await fetcher(asset.browser_download_url, { signal }).catch((error: Error) => { throw unavailable(error); });
  if (!response.ok || !response.body) throw unavailable();
  const reader = response.body.getReader();
  const digest = createHash("sha256"), fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  let length = 0, complete = false;
  try {
    // A dropped connection or the deadline ends the read.
    for (;;) {
      const { done, value: chunk } = await reader.read().catch((error: Error) => { throw unavailable(error); });
      if (done) break;
      length += chunk.length;
      if (length > asset.size) throw Error(`The ${label} download exceeds its release size.`);
      digest.update(chunk); writeSync(fd, chunk);
    }
    if (length !== asset.size || digest.digest("hex") !== asset.digest.slice(7)) throw Error(`The ${label} integrity check failed. Run stelz setup again.`);
    fsyncSync(fd); complete = true;
  } finally {
    closeSync(fd);
    if (!complete) rmSync(file, { force: true });
  }
  return { name: asset.name, release: tag, sha256: asset.digest.slice(7), size: length };
}
