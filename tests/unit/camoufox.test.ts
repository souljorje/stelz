import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { browserAssetPattern, browserExecutable, browserPackage, browserPin, coherenceViolations, fingerprintModel, hostRendering, launcher, pairedBrowser } from "../../src/browser/camoufox.ts";

test("the exactly pinned camoufox still exports every internal that Stelz uses", () => {
  const pinned = JSON.parse(readFileSync("package.json", "utf8")).dependencies.camoufox;
  expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
  expect(JSON.parse(readFileSync("node_modules/camoufox/package.json", "utf8")).version).toBe(pinned);
  expect(JSON.parse(readFileSync("node_modules/@askjo/camofox-browser/package.json", "utf8")).dependencies.camoufox).toBe(pinned);
  const root = createRequire(import.meta.url), upstream = createRequire(root.resolve("@askjo/camofox-browser/package.json"));
  expect(upstream.resolve("camoufox/package.json")).toBe(root.resolve("camoufox/package.json"));
  expect(coherenceViolations({}, "mac")).toEqual([]);
  const utils = launcher(), model = fingerprintModel();
  for (const name of ["getEnvVars", "getPrefEnvVars", "getTargetOs"] as const) expect(typeof utils[name]).toBe("function");
  expect(utils.STOCK_MEDIA_DEFAULTS).toEqual({ colorScheme: null, reducedMotion: null, forcedColors: null, contrast: null });
  expect(typeof hostRendering().setWebgpu).toBe("function");
  expect(hostRendering().WEBGPU_BLOCKLIST_PREF).toBe("gfx.blacklist.webgpu");
  for (const name of ["isModelInstalled", "ensureModel", "modelDir", "setModelDir"] as const) expect(typeof model[name]).toBe("function");
  expect(model.MODEL_PIN.files.length).toBeGreaterThan(0);
  expect(pairedBrowser()).toMatch(/^\d+\.\d+\.\d+-\w+\.\d+$/);
  expect(browserPin()).toMatchObject({ repo: expect.stringMatching(/^[\w.-]+\/[\w.-]+$/), tag: expect.stringMatching(/^v/) });
  const { version, build } = browserPin(), asset = `camoufox-${version}-${build}-mac.arm64.zip`;
  if (process.platform === "darwin" && process.arch === "arm64") expect(browserAssetPattern().exec(asset)?.groups).toMatchObject({ version, build });
  for (const name of ["unzip", "makeExecutable", "listInstalled"] as const) expect(typeof browserPackage()[name]).toBe("function");
  if (process.platform === "darwin") expect(browserExecutable("/b")).toBe("/b/Camoufox.app/Contents/MacOS/camoufox");
});
