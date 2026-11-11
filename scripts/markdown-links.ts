import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

function withoutCodeFences(text: string) {
  let fence = "";
  return text.split("\n").map(line => {
    const marker = /^[ \t]*(`{3,}|~{3,})/.exec(line)?.[1];
    if (!fence) {
      if (!marker) return line;
      fence = marker;
    } else if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) {
      fence = "";
    }
    return "";
  }).join("\n");
}

function headingAnchors(text: string) {
  const anchors = new Set<string>();
  for (const match of withoutCodeFences(text).matchAll(/^#{1,6}[ \t]+(.+)$/gm)) {
    const base = match[1]!.replace(/[ \t]+#+[ \t]*$/, "").trim().toLowerCase()
      .replace(/[^\p{L}\p{N}_\-\s]/gu, "").replace(/\s/g, "-");
    let anchor = base, suffix = 0;
    while (anchors.has(anchor)) anchor = `${base}-${++suffix}`;
    anchors.add(anchor);
  }
  return anchors;
}

function imageReferences(text: string) {
  const references: string[] = [];
  for (const tag of text.matchAll(/<(?:img|source)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    for (const attribute of tag[0].matchAll(/\s([a-z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)) {
      const name = attribute[1]!.toLowerCase();
      if (name !== "src" && name !== "srcset") continue;
      let value = (attribute[2] ?? attribute[3] ?? attribute[4]!).trim();
      if (name === "src") {
        if (value) references.push(value);
        continue;
      }
      // Commas can belong to a URL. Descriptors end at the next comma.
      while (value) {
        value = value.replace(/^[\s,]+/, "");
        const url = /^\S+/.exec(value)?.[0];
        if (!url) break;
        references.push(url.replace(/,+$/, ""));
        value = value.slice(url.length);
        if (url.endsWith(",")) continue;
        const comma = value.indexOf(",");
        value = comma < 0 ? "" : value.slice(comma + 1);
      }
    }
  }
  return references;
}

export function checkMarkdownLinks(paths: string[]) {
  let checked = 0;
  const visited = new Set<string>();
  function visit(input: string) {
    const path = realpathSync(input);
    if (visited.has(path)) return;
    visited.add(path);
    if (statSync(path).isDirectory()) {
      for (const name of readdirSync(path)) visit(resolve(path, name));
      return;
    }
    if (!path.endsWith(".md")) return;
    const text = withoutCodeFences(readFileSync(path, "utf8"));
    const references = [...text.matchAll(/\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)/g)]
      .map(match => match[1] ?? match[2]!);
    references.push(...imageReferences(text));
    for (const href of references) {
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) continue;
      const [location, anchor] = href.split("#", 2);
      const file = location!.split("?", 1)[0]!;
      const target = file ? resolve(dirname(path), decodeURIComponent(file)) : path;
      if (!existsSync(target)) throw Error(`Broken Markdown link in ${path}: ${href}`);
      if (anchor && target.endsWith(".md")) {
        if (!headingAnchors(readFileSync(target, "utf8")).has(decodeURIComponent(anchor)))
          throw Error(`Broken Markdown anchor in ${path}: ${href}`);
      }
      checked++;
    }
  }
  for (const path of paths) visit(path);
  return checked;
}

/** The repository documentation that `bun run check:docs` checks. */
export const DOCUMENTATION = ["README.md", "CONTRIBUTING.md", "AGENTS.md", "docs", "examples", "skills"];

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  console.log(`Checked ${checkMarkdownLinks(DOCUMENTATION.map(path => resolve(root, path)))} Markdown links.`);
}
