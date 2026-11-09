/**
 * The only Stelz module that imports camoufox internals. `package.json` pins camoufox exactly,
 * and tests/unit/camoufox.test.ts checks every name used here.
 * Coherence is pure. The launcher utilities import native addons, so they load on first use only.
 */
import { createRequire } from "node:module";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { validate } from "camoufox/dist/coherence.js";

const load = createRequire(import.meta.url);
export const coherenceViolations = validate;
export const launcher = () => load("camoufox/dist/utils.js") as typeof import("camoufox/dist/utils.js");
export const fingerprintModel = () => load("camoufox/dist/fpgen/index.js") as typeof import("camoufox/dist/fpgen/index.js");
/** Upstream's installed check excludes values.dat. Check its indexed length without triggering decompression or downloads. */
export function isPreparedModel(directory: string): boolean {
  if (!fingerprintModel().isModelInstalled(directory)) return false;
  try {
    const values: unknown = JSON.parse(zstdDecompressSync(readFileSync(join(directory, "values.json.zst"))).toString("utf8"));
    if (!values || typeof values !== "object" || Array.isArray(values)) return false;
    let size = 0;
    for (const [offset, length] of Object.entries(values)) {
      const start = Number.parseInt(offset, 16);
      if (!/^[a-f\d]+$/i.test(offset) || !Number.isSafeInteger(start) || typeof length !== "number" ||
          !Number.isSafeInteger(length) || length < 0 || !Number.isSafeInteger(start + length)) return false;
      size = Math.max(size, start + length);
    }
    const data = statSync(join(directory, "values.dat"));
    return size > 0 && data.isFile() && data.size === size;
  } catch { return false; }
}
/** The browser build that this launcher release pairs with, as `version-build`. */
export function pairedBrowser() {
  const { version, build } = load("camoufox/dist/data-files/browser-pin.json") as { version: string; build: string };
  return `${version}-${build}`;
}
