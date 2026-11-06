import { resolve, join, basename } from "node:path";
import { packPackage } from "./bundle-package.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { inspectPackageArchive } from "./package-archive.ts";

const root = resolve(import.meta.dir, ".."), args = process.argv.slice(2);
const flags = new Map<string, string>();
for (let index = 0; index < args.length; index += 2) {
  const name = args[index]!, value = args[index + 1];
  if (!["--destination", "--publish-plan"].includes(name) || flags.has(name) || !value || value.startsWith("--"))
    throw Error("Use: bun run pack [--destination DIRECTORY] [--publish-plan FILE]");
  flags.set(name, value);
}
const destination = resolve(flags.get("--destination") || join(root, "release-artifacts"));
mkdirSync(destination, { recursive: true });
await import("./build.ts");
const result = await packPackage(root, destination, { publishPlan: flags.get("--publish-plan") });
const candidate = inspectPackageArchive(join(destination, result.filename));
writeFileSync(`${candidate.archive}.sha256`, `${candidate.sha256}  ${basename(result.filename)}\n`);
console.log(JSON.stringify({ archive: candidate.archive, sha256: candidate.sha256, version: candidate.manifest.version }));
