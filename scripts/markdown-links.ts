import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function checkMarkdownLinks(paths: string[]) {
  let checked = 0;
  function visit(path: string) {
    if (statSync(path).isDirectory()) {
      for (const name of readdirSync(path)) visit(resolve(path, name));
      return;
    }
    if (!path.endsWith(".md")) return;
    const text = readFileSync(path, "utf8").replace(/```[\s\S]*?```/g, "");
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const href = match[1]!.replace(/^<|>$/g, "");
      if (/^[a-z][a-z\d+.-]*:/i.test(href)) continue;
      const [file, anchor] = href.split("#");
      const target = file ? resolve(dirname(path), decodeURIComponent(file)) : path;
      if (!existsSync(target)) throw Error(`Broken Markdown link in ${path}: ${href}`);
      if (anchor && target.endsWith(".md")) {
        const headings = [...readFileSync(target, "utf8").matchAll(/^#{1,6}\s+(.+)$/gm)].map(match =>
          match[1]!.toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, "").replace(/\s/g, "-"));
        if (!headings.includes(anchor)) throw Error(`Broken Markdown anchor in ${path}: ${href}`);
      }
      checked++;
    }
  }
  for (const path of paths) visit(path);
  return checked;
}
