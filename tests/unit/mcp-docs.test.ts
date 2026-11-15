import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { toolTable } from "../../scripts/mcp-tools.ts";

test("the tool table in docs/mcp.md matches the catalog", async () => {
  const doc = readFileSync(new URL("../../docs/mcp.md", import.meta.url), "utf8");
  const shown = doc.match(/<!-- tools:start -->\n([\s\S]*?)\n<!-- tools:end -->/)?.[1];
  expect(shown, "docs/mcp.md needs the markers <!-- tools:start --> and <!-- tools:end -->.").toBeDefined();
  expect(shown, "The tool table in docs/mcp.md is out of date. Run `bun scripts/mcp-tools.ts` and put its output between the markers.").toBe(await toolTable());
});
