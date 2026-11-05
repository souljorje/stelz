import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, lstatSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { checkBundledArchive } from "./bundled-dependencies.ts";
import { NATIVE_DEPENDENCIES } from "../src/browser/native-dependencies.ts";

type PackResult = { filename: string; files: Array<{ path: string }>; size: number; shasum: string; integrity: string };
const nativePackages = NATIVE_DEPENDENCIES;
const preparedPackages = ["@askjo/camofox-browser", "camoufox-js"] as const;

// Native dependencies stay explicit at the product root so npm installs their target binaries.
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

// Prepare physical files from npm's package inventory, then create one archive.
export async function packRelease(product: string, destination: string, options: {
  env?: Record<string, string>;
} = {}): Promise<PackResult> {
  const temporary = mkdtempSync(join(tmpdir(), "stelz-release-tree-"));
  const env = { ...(options.env ?? process.env), npm_config_cache: join(temporary, "npm-cache") };
  async function run(command: string[], cwd: string) {
    const child = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code) throw Error(err || out || `${command[0]} failed.`);
    return out;
  }
  try {
    const inventory = JSON.parse(await run([Bun.which("npm")!, "pack", "--dry-run", "--ignore-scripts", "--json"], product)) as PackResult[];
    if (inventory.length !== 1) throw Error("Expected one release package inventory.");
    const prepared = join(temporary, "package");
    for (const { path } of inventory[0]!.files) {
      if (path.startsWith("/") || path.split("/").includes("..") || path.includes("\\"))
        throw Error("The release inventory contains a path outside its package.");
      const target = join(prepared, path);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(product, path), target);
    }
    externalizeNativeDependencies(prepared);
    const result = JSON.parse(await run([Bun.which("npm")!, "pack", "--ignore-scripts", "--json", "--pack-destination", destination], prepared)) as PackResult[];
    if (result.length !== 1) throw Error("Expected one release archive.");
    checkBundledArchive(result[0]!.files);
    return result[0]!;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
