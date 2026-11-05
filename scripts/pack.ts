import { resolve, join } from "node:path";
import { packRelease } from "./release-archive.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { inspectReleaseCandidate } from "./release-candidate.ts";

const root = resolve(import.meta.dir, ".."), args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--destination")) throw Error("Use: bun run pack [--destination DIRECTORY]");
const destination = resolve(args[1] || root);
mkdirSync(destination, { recursive: true });
const result = await packRelease(join(root, "packages/stelz"), destination);
const candidate = inspectReleaseCandidate(join(destination, result.filename));
writeFileSync(`${candidate.archive}.sha256`, `${candidate.sha256}  ${result.filename}\n`);
const commit = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root, stdout: "pipe", stderr: "pipe" });
if (commit.exitCode) throw Error("Cannot identify the release source commit.");
writeFileSync(join(destination, "candidate.json"), JSON.stringify({ version: candidate.manifest.version,
  filename: result.filename, sha256: candidate.sha256, sourceCommit: commit.stdout.toString().trim() }, null, 2) + "\n");
console.log(JSON.stringify({ archive: candidate.archive, sha256: candidate.sha256, version: candidate.manifest.version }));
