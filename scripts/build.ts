import { inspectBundledDependencies } from "./bundled-dependencies.ts";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
const root = join(import.meta.dir, "..");
inspectBundledDependencies(root);
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
// Bun runs the CLI and supervisor from src/. Camofox loads the plugin in Node, so it ships built.
const plugin = await Bun.build({ entrypoints: [join(root, "src/browser/plugin.ts")], target: "node", packages: "external", format: "esm", outdir: dist, naming: "plugin.js" });
if (!plugin.success) throw Error(plugin.logs.join("\n"));
const ui = Bun.spawn([process.execPath, join(root, "ui/build.ts")], { stdout: "inherit", stderr: "inherit" });
if (await ui.exited) throw Error("UI build failed.");
console.log("Built the browser plugin and the local UI.");
