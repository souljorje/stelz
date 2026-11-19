import { createHash } from "node:crypto";
import { closeSync, constants, fsyncSync, openSync, rmSync, writeSync } from "node:fs";

export type ReleaseAssetRequest = {
  url: string; label: string; match: (name: string) => boolean; maxBytes: number; timeoutMs: number;
  sha256?: Readonly<Record<string, string>>;
};
type AssetMetadata = { name: string; size: number; digest?: string; browser_download_url?: string; sha256?: string; url?: string };
export type Release = { origin: string; tag: string; asset: { name: string; size: number; sha256: string; url: string } };
class ReleaseUnavailableError extends Error {}

export function githubReleaseUrl(repository: string, tag: string) {
  return `https://github.com/${repository}/releases/tag/${tag}`;
}

function httpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const url = URL.parse(value);
  return !!url && url.protocol === "https:" && !url.username && !url.password;
}

/** Try another source when a release or its asset is unavailable. Fail on invalid metadata or bytes. */
export async function withReleaseFallback<T>(sources: readonly ReleaseAssetRequest[], use: (source: ReleaseAssetRequest) => Promise<T>) {
  const failures: string[] = [];
  for (const source of sources) {
    try { return await use(source); }
    catch (error) {
      if (!(error instanceof ReleaseUnavailableError) || sources.length === 1) throw error;
      failures.push(`${source.url}: ${error.message}`);
    }
  }
  throw Error(failures.join("\n"));
}

/** Resolve one asset and check its published size, URL, and SHA-256 digest. */
export async function readRelease(request: ReleaseAssetRequest, fetcher: typeof fetch = fetch): Promise<Release> {
  const { label, url } = request, unavailable = `Check the connection and run stelz setup again.`;
  if (!httpsUrl(url)) throw Error("A release source needs an HTTPS URL without credentials.");
  const github = /^https:\/\/github\.com\/(?<repository>[\w.-]+\/[\w.-]+)\/releases\/(?:tag\/(?<tag>[\w.-]+)|latest)$/.exec(url)?.groups;
  const endpoint = github
    ? `https://api.github.com/repos/${github.repository}/releases/${github.tag ? `tags/${github.tag}` : "latest"}`
    : url;
  const signal = AbortSignal.timeout(30_000);
  let response: Response;
  try {
    response = await fetcher(endpoint, github
      ? { signal, headers: { Accept: "application/vnd.github+json" } }
      : { signal, headers: { Accept: "application/json" }, redirect: "manual" });
  } catch (error) {
    throw new ReleaseUnavailableError(`Cannot read the ${label} release (${(error as Error).message}). ${unavailable}`);
  }
  if (!response.ok) {
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    if (github && [403, 429].includes(response.status) && response.headers.get("x-ratelimit-remaining") === "0")
      throw new ReleaseUnavailableError(`GitHub limits release requests from this network. Run stelz setup again after ${reset > 0 ? new Date(reset * 1000).toLocaleTimeString() : "an hour"}.`);
    throw new ReleaseUnavailableError(`Cannot read the ${label} release (HTTP ${response.status}). ${unavailable}`);
  }
  const value = await response.json() as { tag_name?: string; tag?: string; assets?: AssetMetadata[] };
  const tag = (github ? value?.tag_name : value?.tag) ?? "";
  const invalid = (reason: string) => Error(`The ${label} release ${tag || "(unknown)"} ${reason}. Run stelz setup again after the release is available.`);
  if (typeof tag !== "string" || !/^[\w.-]+$/.test(tag) || (github?.tag && tag !== github.tag))
    throw invalid(github?.tag ? `does not match the expected tag ${github.tag}` : "has an invalid tag");
  if (!Array.isArray(value.assets) || value.assets.some(asset => typeof asset?.name !== "string")) throw invalid("has an invalid asset list");
  const assets = value.assets.filter(asset => request.match(asset.name)), asset = assets[0];
  if (!asset) throw new ReleaseUnavailableError(invalid("has no matching asset for this platform").message);
  if (assets.length > 1) throw invalid(`has ${assets.length} matching assets for this platform instead of one`);
  const { name, size } = asset;
  const sha256 = github
    ? /^sha256:([a-f0-9]{64})$/.exec(typeof asset.digest === "string" ? asset.digest : "")?.[1]
    : asset.sha256;
  if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) throw invalid(`has no published SHA-256 digest for ${name}`);
  if (request.sha256 && sha256 !== request.sha256[name]) throw invalid(`has an unexpected SHA-256 digest for ${name}`);
  const assetUrl = github ? asset.browser_download_url : asset.url;
  if (!httpsUrl(assetUrl) || !Number.isSafeInteger(size) || size <= 0 || size > request.maxBytes ||
    (github && assetUrl !== `https://github.com/${github.repository}/releases/download/${tag}/${encodeURIComponent(name)}`))
    throw invalid(`has unexpected metadata for ${name}`);
  return { origin: github?.repository ?? url, tag, asset: { name, size, sha256, url: assetUrl } };
}

/**
 * Download a release asset to a new file and verify its SHA-256 digest.
 * A missing digest, an unexpected URL, or a size or digest mismatch fails and removes the file.
 */
export async function downloadReleaseAsset(request: ReleaseAssetRequest, release: Release, file: string, fetcher: typeof fetch = fetch) {
  const { label } = request, signal = AbortSignal.timeout(request.timeoutMs);
  const { origin, tag, asset } = release;
  const unavailable = (error?: Error) => new ReleaseUnavailableError(`Cannot download ${label}${error ? ` (${error.message})` : ""}. Check the connection and run stelz setup again.`);
  const response = await fetcher(asset.url, { signal }).catch((error: Error) => { throw unavailable(error); });
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
    if (length !== asset.size || digest.digest("hex") !== asset.sha256) throw Error(`The ${label} integrity check failed. Run stelz setup again.`);
    fsyncSync(fd); complete = true;
  } finally {
    closeSync(fd);
    if (!complete) rmSync(file, { force: true });
  }
  return { origin, name: asset.name, release: tag, sha256: asset.sha256, size: length };
}
