import { test, expect } from "bun:test";
import { resolve, join, dirname } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { checkBundledArchive, inspectBundledDependencies } from "../../scripts/bundled-dependencies.ts";
import { externalizeNativeDependencies } from "../../scripts/release-archive.ts";

const required = [
  "node_modules/@askjo/camofox-browser/package.json",
  "node_modules/@askjo/camofox-browser/server.js",
  "node_modules/@askjo/camofox-browser/plugins/persistence/index.js",
  "node_modules/camoufox-js/package.json",
  "node_modules/camoufox-js/dist/utils.js",
].map(path => ({ path }));

test("the installed Camofox and both launcher resolution paths contain the committed patches", () => {
  const files = inspectBundledDependencies(resolve(import.meta.dir, "../.."));
  expect(Object.keys(files)).toHaveLength(4);
  expect(files["@askjo/camofox-browser/server.js"]).toContain("launchProfileBrowser");
  expect(files["camoufox-js/dist/utils.js"]).toContain("../Resources/properties.json");
});

test("bundled dependency sources and notices are permitted", () => {
  expect(() => checkBundledArchive([...required,
    { path: "node_modules/better-sqlite3/src/better_sqlite3.cpp" },
    { path: "node_modules/better-sqlite3/LICENSE" },
  ])).not.toThrow();
});

test("the archive must contain both patched packages", () => {
  expect(() => checkBundledArchive(required.slice(0, -1))).toThrow("missing bundled");
});

for (const path of [
  "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
  "node_modules/camoufox-js/.cache/browser/file",
  "node_modules/@askjo/camofox-browser/secrets.env",
  "node_modules/@askjo/camofox-browser/.git/config",
  "../../node_modules/escape/LICENSE",
]) test(`archive rejects ${path}`, () => {
  expect(() => checkBundledArchive([...required, { path }])).toThrow("Unsafe");
});

test("native packages install separately while prepared JavaScript and pure dependencies remain bundled", () => {
  const product = mkdtempSync(join(tmpdir(), "stelz-native-release-"));
  const file = (path: string, text: string) => { mkdirSync(dirname(join(product, path)), { recursive: true }); writeFileSync(join(product, path), text); };
  try {
    file("package.json", JSON.stringify({ dependencies: { "better-sqlite3": "13.0.1", impit: "0.14.8" } }));
    for (const name of ["@askjo/camofox-browser", "camoufox-js"]) file(`node_modules/${name}/package.json`, JSON.stringify({
      dependencies: { "better-sqlite3": "^13.0.0", impit: "^0.14.8", retained: "1.0.0" },
    }));
    file("node_modules/@askjo/camofox-browser/server.js", "prepared JavaScript");
    file("node_modules/retained/LICENSE", "retained license");
    const native = ["better-sqlite3", "camoufox-js/node_modules/better-sqlite3", "impit", "impit-darwin-arm64"];
    for (const name of native) file(`node_modules/${name}/package.json`, "{}");
    externalizeNativeDependencies(product);
    for (const name of native) expect(existsSync(join(product, "node_modules", name))).toBe(false);
    expect(JSON.parse(readFileSync(join(product, "node_modules/camoufox-js/package.json"), "utf8")).dependencies).toEqual({ retained: "1.0.0" });
    expect(JSON.parse(readFileSync(join(product, "package.json"), "utf8")).dependencies).toEqual({ "better-sqlite3": "13.0.1", impit: "0.14.8" });
    expect(readFileSync(join(product, "node_modules/@askjo/camofox-browser/server.js"), "utf8")).toBe("prepared JavaScript");
    expect(readFileSync(join(product, "node_modules/retained/LICENSE"), "utf8")).toBe("retained license");
  } finally { rmSync(product, { recursive: true, force: true }); }
});
