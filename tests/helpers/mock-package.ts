import { copyFileSync, cpSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../../src/paths.ts";

/** Exercise the real source CLI against a fixture package with a mock compiled plugin. */
export function createMockPackage(parent: string) {
  const packageRoot = join(parent, "package");
  mkdirSync(join(packageRoot, "dist"), { recursive: true });
  cpSync(join(ROOT, "src"), join(packageRoot, "src"), { recursive: true });
  copyFileSync(join(ROOT, "package.json"), join(packageRoot, "package.json"));
  symlinkSync(join(ROOT, "node_modules"), join(packageRoot, "node_modules"), "dir");
  const plugin = "// Fixture plugin. The mock server does not launch a browser.\nexport function register() {}\n";
  writeFileSync(join(packageRoot, "dist/plugin.js"), plugin);
  return { packageRoot, plugin, cli: join(packageRoot, "src/cli/cli.ts"), runtime: join(packageRoot, "src/runtime/runtime.ts") };
}
