import { inspectBundledDependencies } from "./bundled-dependencies.ts";
import { mkdirSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
const root = join(import.meta.dir, "..");
inspectBundledDependencies(root);
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
for (const [name, domain, target] of [["cli", "cli", "bun"], ["supervisor", "runtime", "bun"], ["plugin", "browser", "node"]] as const) {
  const result = await Bun.build({ entrypoints: [join(root, "src", domain, name + ".ts")], target, packages: "external", format: "esm", outdir: dist, naming: name + ".js" });
  if (!result.success) throw Error(result.logs.join("\n"));
  if (name !== "plugin") chmodSync(join(dist, name + ".js"), 0o755);
}
const ui = Bun.spawn([process.execPath, join(root, "ui/build.ts")], { stdout: "inherit", stderr: "inherit" });
if (await ui.exited) throw Error("UI build failed.");
console.log("Built standalone CLI, browser service, and local UI.");
