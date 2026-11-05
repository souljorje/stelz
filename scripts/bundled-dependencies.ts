import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { assertBundledPatches } from "../packages/stelz/src/browser/camofox-adapter.ts";

const serverName = "@askjo/camofox-browser";
const launcherName = "camoufox-js";
const serverFiles = ["server.js", "lib/camoufox-executable.js", "plugins/persistence/index.js"];

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

/** Check the actual installed packages, including Camofox's own launcher resolution. */
export function inspectBundledDependencies(product: string): Record<string, string> {
  const manifest = JSON.parse(readFileSync(join(product, "package.json"), "utf8"));
  const bundled: unknown = manifest.bundleDependencies;
  if (!Array.isArray(bundled) || bundled.length !== 2 || ![serverName, launcherName].every(name => bundled.includes(name))) {
    throw Error("Stelz must bundle the two patched Camofox packages.");
  }
  const server = packageDirectory(serverName, product);
  const launcher = packageDirectory(launcherName, product);
  const nestedLauncher = packageDirectory(launcherName, server);
  for (const [name, path] of [[serverName, server], [launcherName, launcher], [launcherName, nestedLauncher]]) {
    const dependency = JSON.parse(readFileSync(join(path!, "package.json"), "utf8"));
    if (dependency.name !== name || dependency.version !== manifest.dependencies[name!]) {
      throw Error(`Unexpected ${name} version in the prepared dependency tree.`);
    }
  }
  assertBundledPatches(server, launcher);
  assertBundledPatches(server, nestedLauncher);
  const snapshot: Record<string, string> = {};
  for (const file of serverFiles) snapshot[`${serverName}/${file}`] = readFileSync(join(server, file), "utf8");
  snapshot[`${launcherName}/dist/utils.js`] = readFileSync(join(launcher, "dist/utils.js"), "utf8");
  if (readFileSync(join(nestedLauncher, "dist/utils.js"), "utf8") !== snapshot[`${launcherName}/dist/utils.js`]) {
    throw Error("Camofox resolves a different launcher implementation.");
  }
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
    `node_modules/${launcherName}/package.json`,
    `node_modules/${launcherName}/dist/utils.js`,
  ]) if (!paths.includes(required)) throw Error("Archive is missing bundled dependency file: " + required);
  for (const path of paths) {
    if (!path.startsWith("node_modules/")) continue;
    if (/(^|\/)(?:\.git|\.state|\.runtime|browser-data|\.cache|playwright-browsers)(?:\/|$)/.test(path)
      || /(^|\/)(?:\.env|secrets\.env|access-key|cookies\.sqlite)$/.test(path)
      || /\.(?:node|dylib|dll|exe|so(?:\.\d+)*)$/i.test(path)) {
      throw Error("Unsafe or platform-specific bundled artifact: " + path + ". Pack from a clean scripts-disabled install.");
    }
  }
}
