import { $ } from "bun";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { inspectBundledDependencies } from "./bundled-dependencies.ts";
import { NATIVE_DEPENDENCIES } from "../src/browser/native-dependencies.ts";

const nativePackages = NATIVE_DEPENDENCIES;
const preparedPackages = ["@askjo/camofox-browser", "camoufox"] as const;

// Native dependencies stay explicit at the product root so npm installs their target binaries.
// npm expects a bundled package's dependencies inside the bundle, so bundled manifests drop their native edges.
// Only the temporary release tree changes. The prepared workspace packages remain intact.
export function externalizeNativeDependencies(product: string) {
  const manifest = JSON.parse(readFileSync(join(product, "package.json"), "utf8"));
  for (const name of nativePackages) {
    if (typeof manifest.dependencies?.[name] !== "string" || !/^\d+\.\d+\.\d+$/.test(manifest.dependencies[name]))
      throw Error("Pin the existing native dependency version: " + name);
  }
  for (const name of preparedPackages) {
    const file = join(product, "node_modules", name, "package.json"), dependency = JSON.parse(readFileSync(file, "utf8"));
    for (const section of ["dependencies", "optionalDependencies"]) for (const native of nativePackages) {
      const range = dependency[section]?.[native];
      if (range === undefined) continue;
      if (!Bun.semver.satisfies(manifest.dependencies[native], range)) throw Error("Incompatible native dependency: " + native);
      delete dependency[section][native];
    }
    writeFileSync(file, JSON.stringify(dependency, null, 2) + "\n");
  }
  function visit(modules: string) {
    for (const entry of readdirSync(modules, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const packages = entry.name.startsWith("@") ? readdirSync(join(modules, entry.name)).map(name => `${entry.name}/${name}`) : [entry.name];
      for (const name of packages) {
        const folder = join(modules, name);
        if (lstatSync(folder).isSymbolicLink()) throw Error("A release dependency must not link to the workspace: " + name);
        if (nativePackages.includes(name as typeof nativePackages[number]) || /^impit-(?:darwin|linux|win32)-/.test(name)) {
          rmSync(folder, { recursive: true, force: true });
          continue;
        }
        const nested = join(folder, "node_modules");
        try { if (lstatSync(nested).isDirectory()) visit(nested); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    }
  }
  visit(join(product, "node_modules"));
}

// Camofox's registry metadata still installs camoufox-js. Keep only packages that a manifest reaches.
export function pruneUnreachableDependencies(product: string) {
  const reached = new Set<string>();
  function locate(from: string, name: string) {
    for (let directory = from; ; directory = dirname(directory)) {
      const folder = join(directory, "node_modules", name);
      if (existsSync(join(folder, "package.json"))) return folder;
      if (directory === product) return undefined;
    }
  }
  function reach(folder: string) {
    if (reached.has(folder)) return;
    reached.add(folder);
    const manifest = JSON.parse(readFileSync(join(folder, "package.json"), "utf8"));
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies })) {
      const target = locate(folder, name);
      if (target) reach(target);
    }
  }
  function prune(modules: string) {
    if (!existsSync(modules)) return;
    for (const entry of readdirSync(modules)) {
      if (entry.startsWith(".")) continue;
      for (const name of entry.startsWith("@") ? readdirSync(join(modules, entry)).map(name => `${entry}/${name}`) : [entry]) {
        const folder = join(modules, name);
        if (reached.has(folder)) prune(join(folder, "node_modules"));
        else rmSync(folder, { recursive: true, force: true });
      }
    }
  }
  reach(product);
  prune(join(product, "node_modules"));
}

// Materialize Bun's dependency links in an isolated tree. The caller packs it with npm or Changesets.
if (import.meta.main) {
  const product = resolve(import.meta.dir, "..");
  inspectBundledDependencies(product);
  const stage = mkdtempSync(join(tmpdir(), "stelz-release-tree-"));
  try {
    await $`${process.execPath} pm pack --quiet --destination ${stage} --ignore-scripts`.cwd(product).quiet();
    const archive = join(stage, readdirSync(stage).find(name => name.endsWith(".tgz"))!);
    const paths = (await $`tar -tzf ${archive}`.text()).split("\n").filter(Boolean);
    if (paths.some(path => !path.startsWith("package/") || path.split("/").includes("..") || path.includes("\\")))
      throw Error("The release archive contains a path outside its package.");
    await $`tar -xzf ${archive} --strip-components=1 -C ${stage}`.quiet();
    rmSync(archive);
    externalizeNativeDependencies(stage);
    pruneUnreachableDependencies(stage);
    mkdirSync(join(stage, ".changeset"));
    copyFileSync(join(product, ".changeset/config.json"), join(stage, ".changeset/config.json"));
    console.log(stage);
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}
