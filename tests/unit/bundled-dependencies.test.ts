import { test, expect } from "bun:test";
import { resolve, join, dirname } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { checkBundledArchive, inspectBundledDependencies } from "../../scripts/bundled-dependencies.ts";
import { externalizeNativeDependencies, pruneUnreachableDependencies } from "../../scripts/bundle-package.ts";

const required = [
  "node_modules/@askjo/camofox-browser/package.json",
  "node_modules/@askjo/camofox-browser/server.js",
  "node_modules/@askjo/camofox-browser/plugins/persistence/index.js",
].map(path => ({ path }));

test("the installed Camofox contains the committed patches", () => {
  const files = inspectBundledDependencies(resolve(import.meta.dir, "../.."));
  expect(Object.keys(files)).toHaveLength(5);
  expect(files["@askjo/camofox-browser/lib/stelz-click-guard.js"]).toContain("performing click action");
  expect(files["@askjo/camofox-browser/lib/new-page-recovery.js"]).toContain("createProfilePage(session.context)");
  expect(files["@askjo/camofox-browser/server.js"]).toContain("from 'camoufox';");
});

test("bundled dependency sources and notices are permitted", () => {
  expect(() => checkBundledArchive([...required,
    { path: "node_modules/better-sqlite3/src/better_sqlite3.cpp" },
    { path: "node_modules/better-sqlite3/LICENSE" },
  ])).not.toThrow();
});

test("the archive must contain patched Camofox and no camoufox-js", () => {
  expect(() => checkBundledArchive(required.slice(0, -1))).toThrow("missing bundled");
  expect(() => checkBundledArchive([...required, { path: "node_modules/camoufox-js/package.json" }])).toThrow("camoufox-js");
});

for (const path of [
  "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
  "node_modules/@askjo/camofox-browser/.cache/browser/file",
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
    file("node_modules/@askjo/camofox-browser/package.json", JSON.stringify({
      dependencies: { "better-sqlite3": "^13.0.0", impit: "^0.14.8", retained: "1.0.0" },
    }));
    file("node_modules/@askjo/camofox-browser/server.js", "prepared JavaScript");
    file("node_modules/camoufox/package.json", JSON.stringify({ dependencies: { impit: "^0.14.1", retained: "1.0.0" } }));
    file("node_modules/retained/LICENSE", "retained license");
    const native = ["better-sqlite3", "@askjo/camofox-browser/node_modules/better-sqlite3", "impit", "impit-darwin-arm64"];
    for (const name of native) file(`node_modules/${name}/package.json`, "{}");
    externalizeNativeDependencies(product);
    for (const name of native) expect(existsSync(join(product, "node_modules", name))).toBe(false);
    for (const name of ["@askjo/camofox-browser", "camoufox"])
      expect(JSON.parse(readFileSync(join(product, `node_modules/${name}/package.json`), "utf8")).dependencies).toEqual({ retained: "1.0.0" });
    expect(JSON.parse(readFileSync(join(product, "package.json"), "utf8")).dependencies).toEqual({ "better-sqlite3": "13.0.1", impit: "0.14.8" });
    expect(readFileSync(join(product, "node_modules/@askjo/camofox-browser/server.js"), "utf8")).toBe("prepared JavaScript");
    expect(readFileSync(join(product, "node_modules/retained/LICENSE"), "utf8")).toBe("retained license");
  } finally { rmSync(product, { recursive: true, force: true }); }
});

test("the release keeps only packages that a manifest reaches", () => {
  const product = mkdtempSync(join(tmpdir(), "stelz-prune-release-"));
  const file = (path: string, value: object) => { mkdirSync(dirname(join(product, path)), { recursive: true }); writeFileSync(join(product, path), JSON.stringify(value)); };
  try {
    file("package.json", { dependencies: { "@askjo/camofox-browser": "1.18.1" } });
    file("node_modules/@askjo/camofox-browser/package.json", { dependencies: { express: "5" } });
    file("node_modules/express/package.json", { dependencies: { nested: "1" } });
    file("node_modules/express/node_modules/nested/package.json", {});
    file("node_modules/camoufox-js/package.json", { dependencies: { orphan: "1" } });
    file("node_modules/orphan/package.json", {});
    pruneUnreachableDependencies(product);
    for (const name of ["@askjo/camofox-browser", "express", "express/node_modules/nested"]) expect(existsSync(join(product, "node_modules", name))).toBe(true);
    for (const name of ["camoufox-js", "orphan"]) expect(existsSync(join(product, "node_modules", name))).toBe(false);
  } finally { rmSync(product, { recursive: true, force: true }); }
});
