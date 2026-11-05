import { resolve, join } from "node:path";
import { packRelease } from "./release-archive.ts";

const root = resolve(import.meta.dir, ".."), args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--destination")) throw Error("Use: bun run pack [--destination DIRECTORY]");
const destination = resolve(args[1] || root);
const result = await packRelease(join(root, "packages/stelz"), destination);
console.log(join(destination, result.filename));
