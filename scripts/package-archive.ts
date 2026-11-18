import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkBundledArchive, inspectBundledDependencies } from "./bundled-dependencies.ts";

export function packageArguments(args: string[], allowed: readonly string[] = []) {
  let archive: string | undefined;
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--archive" && archive === undefined && args[index + 1] && !args[index + 1]!.startsWith("--")) archive = resolve(args[++index]!);
    else if (allowed.includes(argument) && !flags.has(argument)) flags.add(argument);
    else throw Error("Use --archive FILE and the documented acceptance flags.");
  }
  return { archive, flags };
}

function archiveSha256(archive: string) {
  return createHash("sha256").update(readFileSync(archive)).digest("hex");
}

export function inspectPackageArchive(file: string) {
  const archive = resolve(file);
  const sha256 = archiveSha256(archive);
  function tar(args: string[]) {
    const result = Bun.spawnSync(["tar", ...args], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode) throw Error("Cannot read the release archive.");
    return result.stdout.toString();
  }
  const entries = tar(["-tzf", archive]).split("\n").filter(Boolean);
  if (entries.some(path => !path.startsWith("package/") || path.split("/").includes("..") || path.includes("\\")) || new Set(entries).size !== entries.length)
    throw Error("The release archive contains unsafe or duplicate paths.");
  const files = entries.filter(path => !path.endsWith("/")).map(path => ({ path: path.slice("package/".length) }));
  checkBundledArchive(files);
  // Publint checks package metadata. These checks protect the patched Camofox payload.
  for (const [path, source] of Object.entries(inspectBundledDependencies(resolve(import.meta.dir, "..")))) {
    if (tar(["-xOf", archive, `package/node_modules/${path}`]) !== source)
      throw Error("The release archive changed a patched dependency: " + path);
  }
  if (archiveSha256(archive) !== sha256) throw Error("The release archive changed during inspection.");
  return { archive, sha256, files };
}

export function assertArchiveUnchanged(candidate: { archive: string; sha256: string }) {
  if (archiveSha256(candidate.archive) !== candidate.sha256) throw Error("The tested release archive changed. Repeat acceptance before publication.");
}
