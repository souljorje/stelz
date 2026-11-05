import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// This module lives in src/ in development and dist/ after bundling.
export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export function entry(name: string) {
  const built = join(ROOT, "dist", name + ".js");
  if (existsSync(built)) return built;
  const domain = name === "cli" ? "cli" : "runtime";
  return join(ROOT, "src", domain, name + ".ts");
}
