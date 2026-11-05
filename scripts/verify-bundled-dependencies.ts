import { readFileSync, existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, isAbsolute } from "node:path";
import { assertPatchedDependencies } from "../packages/stelz/src/browser/camofox-adapter.ts";

function packageDirectory(name: string, from: string): string {
  const require = createRequire(join(from, "package.json"));
  let candidate: string;
  try { candidate = dirname(require.resolve(name + "/package.json")); }
  catch { candidate = dirname(require.resolve(name)); }
  for (;;) {
    const manifest = join(candidate, "package.json");
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === name) return realpathSync(candidate);
    const parent = dirname(candidate);
    if (parent === candidate) throw Error("Cannot resolve bundled dependency: " + name);
    candidate = parent;
  }
}

function dependencies(product: string) {
  const upstream = packageDirectory("@askjo/camofox-browser", product);
  const launcher = packageDirectory("camoufox-js", product);
  const upstreamLauncher = packageDirectory("camoufox-js", upstream);
  assertPatchedDependencies(upstream, launcher);
  // Camofox must not resolve an unpatched nested copy of the launcher.
  assertPatchedDependencies(upstream, upstreamLauncher);
  return { upstream, launcher, upstreamLauncher };
}

/** Check the actual dependency resolution used by both Stelz and Camofox. */
export function verifyBundledDependencies(product: string, expectedSource?: string) {
  const manifest = JSON.parse(readFileSync(join(product, "package.json"), "utf8"));
  for (const name of ["@askjo/camofox-browser", "camoufox-js"]) {
    if (!Array.isArray(manifest.bundleDependencies) || !manifest.bundleDependencies.includes(name))
      throw Error("The release must bundle " + name);
  }
  const installed = dependencies(product);
  if (!expectedSource) return;
  const expected = dependencies(expectedSource), modules = realpathSync(join(product, "node_modules"));
  for (const directory of Object.values(installed)) {
    const path = relative(modules, directory);
    if (path === ".." || path.startsWith("../") || isAbsolute(path))
      throw Error("Bundled dependency resolved outside the installed package: " + directory);
  }
  for (const file of ["server.js", "lib/camoufox-executable.js", "plugins/persistence/index.js"]) {
    if (!readFileSync(join(installed.upstream, file)).equals(readFileSync(join(expected.upstream, file))))
      throw Error("The installed Camofox patch differs from the tested build: " + file);
  }
  const launcher = readFileSync(join(expected.launcher, "dist/utils.js"));
  for (const directory of [installed.launcher, installed.upstreamLauncher]) {
    if (!readFileSync(join(directory, "dist/utils.js")).equals(launcher))
      throw Error("The installed launcher patch differs from the tested build.");
  }
}

export function verifyBundledArchive(paths: readonly string[]) {
  for (const path of [
    "node_modules/@askjo/camofox-browser/server.js",
    "node_modules/@askjo/camofox-browser/lib/camoufox-executable.js",
    "node_modules/@askjo/camofox-browser/plugins/persistence/index.js",
    "node_modules/camoufox-js/dist/utils.js",
  ]) if (!paths.includes(path)) throw Error("Archive is missing a bundled patched file: " + path);
  for (const path of paths) {
    if (path === "examples/secrets.env") continue;
    if (/(?:^|\/)(?:\.git|\.state|\.runtime|\.cache|Camoufox\.app)(?:\/|$)/.test(path)
      || /(?:^|\/)(?:\.env|secrets\.env|cookies\.sqlite|places\.sqlite|camoufox\.exe)$/.test(path))
      throw Error("Archive contains private state, a cache, or a browser binary: " + path);
  }
}
