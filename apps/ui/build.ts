import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const root = join(import.meta.dir, "../..");
const ui = await Bun.build({
  entrypoints: [join(root, "apps/ui/index.html")], target: "browser", format: "esm",
  outdir: join(root, "packages/stelz/dist/ui"), minify: true,
  loader: { ".woff2": "file", ".woff": "file" },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
if (!ui.success) throw Error(ui.logs.join("\n"));
const theme = await Bun.build({
  entrypoints: [join(root, "apps/ui/src/theme-init.ts")], target: "browser", format: "iife",
  outdir: join(root, "packages/stelz/dist/ui"), naming: "theme-[hash].js", minify: true,
});
if (!theme.success) throw Error(theme.logs.join("\n"));
const themeScript = theme.outputs.find(output => output.path.endsWith(".js"));
if (!themeScript) throw Error("The UI theme bootstrap was not built.");
const htmlPath = join(root, "packages/stelz/dist/ui/index.html");
const html = await Bun.file(htmlPath).text();
await Bun.write(htmlPath, html.replace("</title>", `</title><script src="./${basename(themeScript.path)}"></script>`));
// Some Bun versions inline CSS font URLs. Keep fonts in local files for font-src 'self'.
for (const output of ui.outputs) {
  if (!output.path.endsWith(".css")) continue;
  const fonts: Promise<number>[] = [];
  const css = (await output.text()).replace(/url\((["']?)data:font\/(woff2?);base64,([A-Za-z0-9+/=]+)\1\)/g, (_match, _quote, format: string, encoded: string) => {
    const bytes = Buffer.from(encoded, "base64");
    const name = `font-${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.${format}`;
    fonts.push(Bun.write(join(root, "packages/stelz/dist/ui", name), bytes));
    return `url(./${name})`;
  });
  await Promise.all(fonts);
  await Bun.write(output.path, css);
}
for (const [name, path] of [
  ["react", "react/LICENSE"], ["react-dom", "react-dom/LICENSE"], ["scheduler", "scheduler/LICENSE"],
  ["ibm-plex-sans", "@fontsource/ibm-plex-sans/LICENSE"], ["ibm-plex-mono", "@fontsource/ibm-plex-mono/LICENSE"],
]) {
  const packageName = path!.slice(0, path!.lastIndexOf("/"));
  const resolver = packageName === "scheduler" ? createRequire(require.resolve("react-dom/package.json")) : require;
  const source = join(dirname(resolver.resolve(`${packageName}/package.json`)), "LICENSE");
  await Bun.write(join(root, "packages/stelz/dist/ui/licenses", `${name}.txt`), Bun.file(source));
}
