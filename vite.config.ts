import { rmSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "vite";
import { inspectBundledDependencies } from "./scripts/bundled-dependencies.ts";

const root = import.meta.dirname;
const dist = join(root, "dist"), ui = join(dist, "ui");

export default defineConfig({
  root: join(root, "ui"), base: "./", publicDir: false,
  build: { emptyOutDir: false, outDir: ui, assetsInlineLimit: 0, modulePreload: false },
  environments: {
    client: {
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      build: { license: { fileName: "licenses.json" } },
    },
    plugin: {
      consumer: "server", resolve: { external: true },
      build: {
        ssr: join(root, "src/browser/plugin.ts"), target: "node24", outDir: dist, minify: false,
        rolldownOptions: { output: { format: "es", entryFileNames: "plugin.js", codeSplitting: false } },
      },
    },
    theme: {
      consumer: "client",
      build: {
        ssr: false,
        lib: { entry: join(root, "ui/src/theme-init.ts"), formats: ["iife"], name: "StelzTheme" },
        rolldownOptions: { output: { entryFileNames: "theme.js" } },
      },
    },
  },
  builder: {
    sharedConfigBuild: true,
    async buildApp(builder) {
      inspectBundledDependencies(root);
      // These builds share dist/, so clear it once before starting them.
      rmSync(dist, { recursive: true, force: true });
      await Promise.all(Object.values(builder.environments).map(environment => builder.build(environment)));
    },
  },
});
