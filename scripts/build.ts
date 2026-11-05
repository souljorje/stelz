import { inspectBundledDependencies } from "./bundled-dependencies.ts";
import { mkdirSync, chmodSync, rmSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkMarkdownLinks } from "./markdown-links.ts";
const root = join(import.meta.dir, "..");
const product = join(root, "packages/stelz");
inspectBundledDependencies(product);
const dist = join(product, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
for (const [name, domain, target] of [["cli", "cli", "bun"], ["supervisor", "runtime", "bun"], ["plugin", "browser", "node"]] as const) {
  const result = await Bun.build({ entrypoints: [join(product, "src", domain, name + ".ts")], target, packages: "external", format: "esm", outdir: dist, naming: name + ".js" });
  if (!result.success) throw Error(result.logs.join("\n"));
  if (name !== "plugin") chmodSync(join(dist, name + ".js"), 0o755);
}
const ui = Bun.spawn([process.execPath, "run", "build"], { cwd: join(root, "apps/ui"), stdout: "inherit", stderr: "inherit" });
if (await ui.exited) throw Error("UI build failed.");
for (const name of ["docs", "examples"]) {
  rmSync(join(product, name), { recursive: true, force: true });
  cpSync(join(root, name), join(product, name), { recursive: true });
}
for (const name of ["README.md", "THIRD_PARTY_NOTICES.md"]) cpSync(join(root, name), join(product, name));
const agents = join(product, "docs/agents.md");
writeFileSync(agents, readFileSync(agents, "utf8").replace("../packages/stelz/skills/", "../skills/"));
checkMarkdownLinks([join(root, "README.md"), join(root, "docs"), join(root, "examples"), join(product, "skills")]);
checkMarkdownLinks([join(product, "README.md"), join(product, "docs"), join(product, "examples"), join(product, "skills")]);
console.error("Built standalone CLI, browser service, and local UI.");
