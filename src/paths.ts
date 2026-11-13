import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
// Bun runs the CLI and supervisor from source, in development and in the package.
export const entry = (name: "cli" | "supervisor") => join(ROOT, "src", name === "cli" ? "cli" : "runtime", name + ".ts");
