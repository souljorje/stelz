import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";
import { build } from "vite";
const require = createRequire(import.meta.url);
const root = join(import.meta.dir, "..");
const out = join(root, "dist/ui");
const theme = await Bun.build({
  entrypoints: [join(root, "ui/src/theme-init.ts")], target: "browser", format: "iife",
  outdir: out, naming: "theme-[hash].js", minify: true,
});
if (!theme.success) throw Error(theme.logs.join("\n"));
await build({
  root: join(root, "ui"), configFile: false, base: "./",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: { outDir: out, emptyOutDir: false, minify: true, assetsInlineLimit: 0, modulePreload: false },
});
const themeScript = theme.outputs.find(output => output.path.endsWith(".js"));
if (!themeScript) throw Error("The UI theme bootstrap was not built.");
const htmlPath = join(out, "index.html");
const html = await Bun.file(htmlPath).text();
await Bun.write(htmlPath, html.replace("</title>", `</title><script src="./${basename(themeScript.path)}"></script>`));
for (const [name, path] of [
  ["react", "react/LICENSE"], ["react-dom", "react-dom/LICENSE"], ["scheduler", "scheduler/LICENSE"],
  ["ibm-plex-sans", "@fontsource/ibm-plex-sans/LICENSE"], ["ibm-plex-mono", "@fontsource/ibm-plex-mono/LICENSE"],
]) {
  const packageName = path!.slice(0, path!.lastIndexOf("/"));
  const resolver = packageName === "scheduler" ? createRequire(require.resolve("react-dom/package.json")) : require;
  const source = join(dirname(resolver.resolve(`${packageName}/package.json`)), "LICENSE");
  await Bun.write(join(out, "licenses", `${name}.txt`), Bun.file(source));
}
