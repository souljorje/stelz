import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { checkBundledArchive, inspectBundledDependencies } from "./bundled-dependencies.ts";
import { inspectPackageArchive } from "./package-archive.ts";
import { NATIVE_DEPENDENCIES } from "../src/browser/native-dependencies.ts";

type PackResult = { filename: string; files: Array<{ path: string }> };
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

// Bun resolves dependency links. npm packs the prepared physical release tree.
export async function packPackage(product: string, destination: string, options: {
  env?: Record<string, string>;
  publishPlan?: string;
} = {}): Promise<PackResult> {
  inspectBundledDependencies(product);
  const temporary = mkdtempSync(join(tmpdir(), "stelz-release-tree-"));
  const env = { ...(options.env ?? process.env), npm_config_cache: join(temporary, "npm-cache"), npm_config_ignore_scripts: "true" };
  async function run(command: string[], cwd: string) {
    const child = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code) throw Error(err || out || `${command[0]} failed.`);
    return out;
  }
  try {
    await run([process.execPath, "pm", "pack", "--quiet", "--destination", temporary, "--ignore-scripts"], product);
    const archive = join(temporary, readdirSync(temporary).find(name => name.endsWith(".tgz"))!);
    const paths = (await run(["tar", "-tzf", archive], product)).split("\n").filter(Boolean);
    if (paths.some(path => !path.startsWith("package/") || path.split("/").includes("..") || path.includes("\\")))
      throw Error("The release archive contains a path outside its package.");
    await run(["tar", "-xzf", archive, "-C", temporary], product);
    const prepared = join(temporary, "package");
    externalizeNativeDependencies(prepared);
    pruneUnreachableDependencies(prepared);
    if (options.publishPlan) {
      mkdirSync(join(prepared, ".changeset"));
      writeFileSync(join(prepared, ".changeset/config.json"), readFileSync(join(product, ".changeset/config.json")));
      await run([Bun.which("node")!, join(product, "node_modules/@changesets/cli/bin.js"), "pack",
        "--from-publish-plan", resolve(options.publishPlan), "--out-dir", resolve(destination)], prepared);
      const plan = JSON.parse(readFileSync(join(destination, "publish-plan.json"), "utf8"));
      const releases = plan.plan.flat().filter((item: { kind: string }) => item.kind === "publish");
      if (releases.length !== 1 || releases[0].name !== "stelz") throw Error("Expected one Stelz release.");
      const filename = releases[0].tarball.path;
      const candidate = inspectPackageArchive(join(destination, filename));
      return { filename, files: candidate.files };
    }
    const result = JSON.parse(await run([Bun.which("npm")!, "pack", "--ignore-scripts", "--json", "--pack-destination", destination], prepared)) as PackResult[];
    if (result.length !== 1) throw Error("Expected one release archive.");
    checkBundledArchive(result[0]!.files);
    return result[0]!;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
