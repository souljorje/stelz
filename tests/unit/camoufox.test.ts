import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { browserAssetPattern, browserExecutable, browserPackage, browserPin, coherenceViolations, fingerprintModel, launcher, pairedBrowser } from "../../src/browser/camoufox.ts";

test("the exactly pinned camoufox still exports every internal that Stelz uses", () => {
  expect(JSON.parse(readFileSync("package.json", "utf8")).dependencies.camoufox).toMatch(/^\d+\.\d+\.\d+$/);
  expect(coherenceViolations({}, "mac")).toEqual([]);
  const utils = launcher(), model = fingerprintModel();
  for (const name of ["getEnvVars", "getPrefEnvVars", "getTargetOs", "withStockMediaDefaults"] as const) expect(typeof utils[name]).toBe("function");
  for (const name of ["isModelInstalled", "ensureModel"] as const) expect(typeof model[name]).toBe("function");
  expect(model.MODEL_PIN.files.length).toBeGreaterThan(0);
  expect(pairedBrowser()).toMatch(/^\d+\.\d+\.\d+-\w+\.\d+$/);
  expect(browserPin()).toMatchObject({ repo: expect.stringMatching(/^[\w.-]+\/[\w.-]+$/), tag: expect.stringMatching(/^v/) });
  const { version, build } = browserPin(), asset = `camoufox-${version}-${build}-mac.arm64.zip`;
  if (process.platform === "darwin" && process.arch === "arm64") expect(browserAssetPattern().exec(asset)?.groups).toMatchObject({ version, build });
  for (const name of ["unzip", "makeExecutable", "listInstalled"] as const) expect(typeof browserPackage()[name]).toBe("function");
  if (process.platform === "darwin") expect(browserExecutable("/b")).toBe("/b/Camoufox.app/Contents/MacOS/camoufox");
});
