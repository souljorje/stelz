import { mkdirSync, chmodSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
const root = join(import.meta.dir, "..");
rmSync(join(root, "dist"), { recursive: true, force: true });
mkdirSync(join(root, "dist"), { recursive: true });
for (const name of ["cli", "supervisor"]) {
  const result = await Bun.build({ entrypoints: [join(root, "src", `${name}.ts`)], target: "bun", packages: "external", format: "esm", outdir: join(root, "dist"), naming: `${name}.js` });
  if (!result.success) throw Error(result.logs.join("\n"));
  chmodSync(join(root, "dist", `${name}.js`), 0o755);
}
const plugin = await Bun.build({ entrypoints: [join(root, "src/plugin.ts")], target: "node", packages: "external", format: "esm", outdir: join(root, "dist"), naming: "plugin.js" });
if (!plugin.success) throw Error(plugin.logs.join("\n"));
const ui = await Bun.build({
  entrypoints: [join(root, "ui/index.html")], target: "browser", format: "esm",
  outdir: join(root, "dist/ui"), minify: true,
  loader: { ".woff2": "file", ".woff": "file" },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
if (!ui.success) throw Error(ui.logs.join("\n"));
const theme = await Bun.build({
  entrypoints: [join(root, "ui/theme-init.ts")], target: "browser", format: "iife",
  outdir: join(root, "dist/ui"), naming: "theme-[hash].js", minify: true,
});
if (!theme.success) throw Error(theme.logs.join("\n"));
const themeScript = theme.outputs.find(output => output.path.endsWith(".js"));
if (!themeScript) throw Error("The UI theme bootstrap was not built.");
const htmlPath = join(root, "dist/ui/index.html");
const html = await Bun.file(htmlPath).text();
await Bun.write(htmlPath, html.replace("</title>", `</title><script src="./${basename(themeScript.path)}"></script>`));
// Some Bun versions inline CSS font URLs. Keep fonts in local files for font-src 'self'.
for (const output of ui.outputs) {
  if (!output.path.endsWith(".css")) continue;
  const fonts: Promise<number>[] = [];
  const css = (await output.text()).replace(/url\((["']?)data:font\/(woff2?);base64,([A-Za-z0-9+/=]+)\1\)/g, (_match, _quote, format: string, encoded: string) => {
    const bytes = Buffer.from(encoded, "base64");
    const name = `font-${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.${format}`;
    fonts.push(Bun.write(join(root, "dist/ui", name), bytes));
    return `url(./${name})`;
  });
  await Promise.all(fonts);
  await Bun.write(output.path, css);
}
for (const [name, path] of [
  ["react", "react/LICENSE"], ["react-dom", "react-dom/LICENSE"], ["scheduler", "scheduler/LICENSE"],
  ["ibm-plex-sans", "@fontsource/ibm-plex-sans/LICENSE"], ["ibm-plex-mono", "@fontsource/ibm-plex-mono/LICENSE"],
]) await Bun.write(join(root, "dist/ui/licenses", `${name}.txt`), Bun.file(join(root, "node_modules", path!)));
console.log("Built standalone CLI, browser service, and local UI.");
