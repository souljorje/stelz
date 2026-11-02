import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
const root = join(import.meta.dir, "..");
mkdirSync(join(root, "dist"), { recursive: true });
for (const name of ["cli", "supervisor", "call"]) {
  const result = await Bun.build({ entrypoints: [join(root, "src", `${name}.ts`)], target: "bun", packages: "external", format: "esm", outdir: join(root, "dist"), naming: `${name}.js` });
  if (!result.success) throw Error(result.logs.join("\n"));
  chmodSync(join(root, "dist", `${name}.js`), 0o755);
}
const plugin = await Bun.build({ entrypoints: [join(root, "src/plugin.ts")], target: "node", packages: "external", format: "esm", outdir: join(root, "dist"), naming: "plugin.js" });
if (!plugin.success) throw Error(plugin.logs.join("\n"));
console.log("Built standalone CLI and browser service.");
