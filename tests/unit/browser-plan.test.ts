import { describe, expect, test } from "bun:test";
import { browserPlan } from "../../scripts/browser-tests.ts";

const commands = (...files: string[]) => browserPlan(files).map(check => [check.script, ...check.args].join(" "));
describe("local browser selection", () => {
  test("unrelated changes need no runtime or browser", () => {
    expect(commands("README.md", "tests/unit/example.test.ts")).toEqual([]);
  });
  test("typing alone keeps its standalone check", () => {
    expect(commands("src/browser/typing.ts")).toEqual(["test:seed", "test:typing"]);
  });
  test("integration alone does not add typing", () => {
    expect(commands("tests/browser/integration.ts")).toEqual(["test:seed", "test:integration"]);
  });
  test("integration and typing share one browser, regardless of path order or duplicates", () => {
    const files = ["tests/browser/typing-browser.ts", "tests/browser/integration.ts", "tests/browser/typing-browser.ts"];
    expect(commands(...files)).toEqual(["test:seed", "test:integration --typing"]);
    expect(commands(...files.reverse())).toEqual(["test:seed", "test:integration --typing"]);
  });
  test("window-only checks stay standalone and the manual close check stays separate", () => {
    expect(commands("tests/browser/profile-windows-browser.ts")).toEqual(["test:seed", "test:windows"]);
    expect(commands("tests/browser/integration.ts", "tests/browser/profile-windows-browser.ts")).toEqual(["test:seed", "test:integration --windows"]);
    expect(commands("tests/browser/integration.ts", "src/browser/window-activation.ts")).toEqual(["test:seed", "test:integration --windows", "test:window-close"]);
  });
  test("typing and windows without integration keep both standalone checks", () => {
    expect(commands("tests/browser/typing-browser.ts", "tests/browser/profile-windows-browser.ts")).toEqual(["test:seed", "test:windows", "test:typing"]);
  });
  test("core changes preserve all suites and reuse integration browsers", () => {
    expect(commands("src/browser/catalog.ts")).toEqual([
      "test:seed", "test:integration --typing --windows", "test:concurrency", "test:native", "test:transfer",
      "test:window-close", "test:proxy", "test:ui:browser", "pack", "test:setup", "pack", "test:location",
    ]);
  });
  test("new MCP paths are selected without requiring tracked files", () => {
    expect(commands("src/mcp/new/untracked.ts")).toEqual(commands("src/browser/catalog.ts"));
  });
  test("startup, window, and proxy changes keep their respective coverage", () => {
    expect(commands("src/cli/profile-fingerprint.ts")).toEqual(["test:seed", "test:integration", "pack", "test:setup"]);
    expect(commands("src/browser/window-activation.ts")).toEqual(["test:seed", "test:windows", "test:window-close"]);
    expect(commands("tests/helpers/dedicated-proxy.ts")).toEqual(["test:seed", "test:proxy", "pack", "test:location"]);
  });
  test("UI and archive-only checks do not prepare an unused source runtime", () => {
    expect(commands("ui/new-component.tsx")).toEqual(["build", "test:ui:browser"]);
    expect(commands("tests/package/setup.ts")).toEqual(["pack", "test:setup"]);
  });
});
