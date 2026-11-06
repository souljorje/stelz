import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkMarkdownLinks } from "../../scripts/markdown-links.ts";

const directories: string[] = [];
function temporary() {
  const directory = mkdtempSync(join(tmpdir(), "stelz-markdown-links-"));
  directories.push(directory);
  return directory;
}
function write(root: string, path: string, text: string) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

test("Markdown checks recurse through nested docs and resolve relative paths and anchors", () => {
  const root = temporary();
  const readme = write(root, "README.md", '[Testing](docs/development/testing.md#native-profiles "Test guide")\n');
  write(root, "docs/development/testing.md", "# Native profiles\n[Start](../getting-started.md#start-a-profile)\n[Here](#native-profiles)\n");
  write(root, "docs/getting-started.md", "# Start a profile\n[Notes](<development/test notes.md#repeat-1>)\n");
  write(root, "docs/development/test notes.md", "# Repeat\n# Repeat\n[Start](../getting-started.md?plain=1#start-a-profile)\n");
  expect(checkMarkdownLinks([readme, join(root, "docs")])).toBe(5);

  write(root, "docs/development/unlinked.md", "[Fixture](../../examples/missing.html)\n");
  expect(() => checkMarkdownLinks([join(root, "docs")])).toThrow("../../examples/missing.html");
});

test("Markdown checks reject missing headings and headings that occur only in fenced code", () => {
  const root = temporary();
  write(root, "docs/testing.md", "# Real heading\n~~~md\n# Example heading\n~~~\n");
  const readme = write(root, "README.md", "[Missing](docs/testing.md#missing-heading)\n");
  expect(() => checkMarkdownLinks([readme])).toThrow("Broken Markdown anchor");
  write(root, "README.md", "[Sample](docs/testing.md#example-heading)\n");
  expect(() => checkMarkdownLinks([readme])).toThrow("Broken Markdown anchor");
  write(root, "README.md", "[Real](docs/testing.md#real-heading)\n");
  expect(checkMarkdownLinks([readme])).toBe(1);
});

test.each([
  ["Markdown link", "[Missing](missing.png)"],
  ["Markdown image", "![Missing](missing.png)"],
  ["HTML image", '<img src="missing.png">'],
  ["HTML source", "<source src='missing.png'>"],
  ["image srcset candidate", '<img src="present.png" srcset="present.png 1x, missing.png 2x">'],
  ["source srcset candidate", "<source srcset='present.png 640w, missing.png 1280w'>"],
])("Markdown checks reject a broken %s path", (_name, reference) => {
  const root = temporary();
  write(root, "present.png", "image");
  const readme = write(root, "README.md", reference);
  expect(() => checkMarkdownLinks([readme])).toThrow("missing.png");
});

test("HTML image checks cover picture sources, srcset descriptors, and quoted or unquoted attributes", () => {
  const root = temporary();
  write(root, "assets/brand/light.svg", "<svg/>");
  write(root, "assets/brand/dark.svg", "<svg/>");
  write(root, "assets/screenshots/stelz-overview.png", "image");
  const readme = write(root, "README.md", `<picture>
  <SOURCE media="(prefers-color-scheme: dark)"
    SRCSET='assets/brand/dark.svg 1x, assets/brand/light.svg 2x'>
  <source srcset="assets/screenshots/stelz-overview.png 640w, assets/screenshots/stelz-overview.png 1280w">
  <img alt="Use src='unused.png' > preview" src=assets/screenshots/stelz-overview.png
    srcset="assets/brand/light.svg, assets/brand/dark.svg 2x" data-src="unused.png">
</picture>`);
  expect(checkMarkdownLinks([readme])).toBe(7);
});

test("Markdown and HTML checks skip remote URLs, including protocol-relative and data URLs", () => {
  const root = temporary();
  const readme = write(root, "README.md", `[Site](https://example.test/guide#remote)
[Mail](mailto:maintainer@example.test)
![Remote](//example.test/image.png)
<img src="HTTPS://example.test/image.png">
<source srcset="data:image/png;base64,AAAA 1x, https://example.test/large.png 2x, //example.test/larger.png 3x">
<img src="data:image/svg+xml,%3Csvg/%3E">`);
  expect(checkMarkdownLinks([readme])).toBe(0);
});

test("Markdown and HTML checks skip backtick and tilde fenced samples", () => {
  const root = temporary();
  write(root, "present.md", "# Present\n");
  const readme = write(root, "README.md", [
    "````md", "[Missing](missing.md)", "```", '<img src="missing.png">', "````",
    "~~~html", '<source srcset="missing.png 1x, also-missing.png 2x">', "~~~",
    "[Present](present.md#present)", "```md", "[Unclosed sample](missing.md)",
  ].join("\n"));
  expect(checkMarkdownLinks([readme])).toBe(1);
  write(root, "README.md", "```md\n[Sample](missing.md)\n```\n[Real](missing.md)\n");
  expect(() => checkMarkdownLinks([readme])).toThrow("missing.md");
});

test("canonical skill links resolve from the real directory through directory and file symlinks", () => {
  const root = temporary(), installed = join(root, "package");
  write(installed, "docs/bootstrap.md", "# Set up\n");
  const skill = write(installed, "skills/stelz-browser/SKILL.md", "[Setup](../../docs/bootstrap.md#set-up)\n[Recovery](references/recovery.md)\n");
  write(installed, "skills/stelz-browser/references/recovery.md", "[Setup](../../../docs/bootstrap.md#set-up)\n");
  const client = join(root, "client/skills");
  mkdirSync(client, { recursive: true });
  const alias = join(client, "stelz-browser");
  symlinkSync(dirname(skill), alias, "dir");
  const fileAlias = join(root, "client/SKILL.md");
  symlinkSync(skill, fileAlias);
  expect(checkMarkdownLinks([alias])).toBe(3);
  expect(checkMarkdownLinks([fileAlias])).toBe(2);
});

test("packaged documentation resolves without AGENTS and requires its README image assets", () => {
  const root = temporary();
  write(root, "README.md", `[Contribute](CONTRIBUTING.md)\n<picture><source srcset="assets/brand/logo.svg"><img src="assets/screenshots/stelz-overview.png"></picture>\n`);
  write(root, "CONTRIBUTING.md", "[Testing](docs/development/testing.md#package-checks)\n");
  write(root, "docs/development/testing.md", "# Package checks\n[Fixture](../../examples/onboarding-fixture.html)\n");
  write(root, "docs/bootstrap.md", "# Setup\n[Skill](../skills/stelz-browser/SKILL.md)\n");
  write(root, "docs/development/reports/onboarding-2026-11-05.md", "[Setup](../../bootstrap.md#setup)\n");
  write(root, "examples/onboarding-fixture.html", "<html></html>");
  write(root, "skills/stelz-browser/SKILL.md", "[Setup](../../docs/bootstrap.md#setup)\n");
  write(root, "assets/brand/logo.svg", "<svg/>");
  const screenshot = write(root, "assets/screenshots/stelz-overview.png", "image");
  const paths = ["README.md", "CONTRIBUTING.md", "docs", "examples", "skills"].map(path => join(root, path));
  expect(existsSync(join(root, "AGENTS.md"))).toBe(false);
  expect(checkMarkdownLinks(paths)).toBe(8);
  rmSync(screenshot);
  expect(() => checkMarkdownLinks(paths)).toThrow("assets/screenshots/stelz-overview.png");
});

test("source documentation includes developer AGENTS links when requested", () => {
  const root = temporary();
  const agents = write(root, "AGENTS.md", "[Testing](docs/development/testing.md#development)\n");
  expect(() => checkMarkdownLinks([agents])).toThrow("docs/development/testing.md#development");
  write(root, "docs/development/testing.md", "# Development\n");
  expect(checkMarkdownLinks([agents])).toBe(1);
});
