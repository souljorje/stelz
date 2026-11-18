import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defineConfig } from "vite";
import { inspectBundledDependencies } from "./scripts/bundled-dependencies.ts";

const root = import.meta.dirname;
const dist = join(root, "dist"), ui = join(dist, "ui");
const require = createRequire(import.meta.url);

export default defineConfig({
  root: join(root, "ui"), base: "./", publicDir: false,
  build: { emptyOutDir: false, outDir: ui, assetsInlineLimit: 0, modulePreload: false },
  environments: {
    client: { define: { "process.env.NODE_ENV": JSON.stringify("production") } },
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
        rolldownOptions: { output: { entryFileNames: "theme-[hash].js" } },
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

      // Keep the theme script blocking and external for the UI's CSP and first paint.
      const theme = readdirSync(ui).find(name => /^theme-.*\.js$/.test(name));
      if (!theme) throw Error("The UI theme bootstrap was not built.");
      const htmlPath = join(ui, "index.html");
      writeFileSync(htmlPath, readFileSync(htmlPath, "utf8").replace("</title>", `</title><script src="./${theme}"></script>`));

      mkdirSync(join(ui, "licenses"), { recursive: true });
      for (const [name, packageName] of [
        ["react", "react"], ["react-dom", "react-dom"], ["scheduler", "scheduler"],
        ["ibm-plex-sans", "@fontsource/ibm-plex-sans"], ["ibm-plex-mono", "@fontsource/ibm-plex-mono"],
      ] as const) {
        const resolver = packageName === "scheduler" ? createRequire(require.resolve("react-dom/package.json")) : require;
        copyFileSync(join(dirname(resolver.resolve(`${packageName}/package.json`)), "LICENSE"), join(ui, "licenses", `${name}.txt`));
      }
    },
  },
});
