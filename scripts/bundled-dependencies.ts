import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { assertBundledPatches } from "../src/browser/camofox-adapter.ts";

const serverName = "@askjo/camofox-browser";
const serverFiles = ["server.js", "lib/browser-identity.js", "lib/new-page-recovery.js", "lib/stelz-click-guard.js", "lib/stelz-page-ownership.js", "plugins/persistence/index.js"];

function packageDirectory(name: string, from: string): string {
  const require = createRequire(join(from, "package.json"));
  let path: string;
  try { path = dirname(require.resolve(`${name}/package.json`)); }
  catch { path = dirname(require.resolve(name)); }
  for (;;) {
    const file = join(path, "package.json");
    if (existsSync(file) && JSON.parse(readFileSync(file, "utf8")).name === name) return path;
    const parent = dirname(path);
    if (parent === path) throw Error("Cannot resolve " + name);
    path = parent;
  }
}

/** Check the actual installed Camofox package and its Stelz patches. */
export function inspectBundledDependencies(product: string): Record<string, string> {
  const manifest = JSON.parse(readFileSync(join(product, "package.json"), "utf8"));
  const bundled: unknown = manifest.bundleDependencies;
  if (!Array.isArray(bundled) || bundled.length !== 1 || bundled[0] !== serverName) {
    throw Error("Stelz must bundle only the patched Camofox package.");
  }
  const server = packageDirectory(serverName, product);
  if (JSON.parse(readFileSync(join(server, "package.json"), "utf8")).version !== manifest.dependencies[serverName]) {
    throw Error(`Unexpected ${serverName} version in the prepared dependency tree.`);
  }
  assertBundledPatches(server);
  const snapshot: Record<string, string> = {};
  for (const file of serverFiles) snapshot[`${serverName}/${file}`] = readFileSync(join(server, file), "utf8");
  return snapshot;
}

/** Check archive contents without rejecting legitimate transitive dependency sources/licenses. */
export function checkBundledArchive(files: readonly { path: string }[]): void {
  const paths = files.map(file => file.path);
  if (paths.some(path => path.startsWith("/") || path.split("/").includes("..") || path.includes("\\")))
    throw Error("Unsafe archive path outside its package.");
  for (const required of [
    `node_modules/${serverName}/package.json`,
    `node_modules/${serverName}/server.js`,
    `node_modules/${serverName}/plugins/persistence/index.js`,
  ]) if (!paths.includes(required)) throw Error("Archive is missing bundled dependency file: " + required);
  if (paths.some(path => path.includes("node_modules/camoufox-js/"))) throw Error("Archive contains the removed camoufox-js launcher.");
  for (const path of paths) {
    if (!path.startsWith("node_modules/")) continue;
    if (/(^|\/)(?:\.git|\.state|\.runtime|browser-data|\.cache|playwright-browsers)(?:\/|$)/.test(path)
      || /(^|\/)(?:\.env|secrets\.env|access-key|cookies\.sqlite)$/.test(path)
      || /\.(?:node|dylib|dll|exe|so(?:\.\d+)*)$/i.test(path)) {
      throw Error("Unsafe or platform-specific bundled artifact: " + path + ". Pack from a clean scripts-disabled install.");
    }
  }
}
