#!/usr/bin/env bun
// Print the table of listed browser tools for docs/mcp.md. The unit test checks that the document holds this table.
import { browserTools, type Contracts } from "../src/browser/catalog.ts";

// The package manifest pins Camofox, and tests read the same file. A prepared runtime is not needed.
const contracts = new URL("../node_modules/@askjo/camofox-browser/mcp/lib/tool-contracts.mjs", import.meta.url).href;
const brief = (text: string) => (text.match(/^.*?[.!?](?=\s|$)/s)?.[0] ?? text).replace(/\s+/g, " ").replace(/[|<]/g, "\\$&");

export async function toolTable(): Promise<string> {
  const { TOOL_DEFS } = await import(contracts) as Contracts;
  return ["| Tool | Group | Policy | Description |", "| --- | --- | --- | --- |",
    ...[...browserTools(TOOL_DEFS).values()].map(({ entry, tool }) => `| \`${tool.name}\` | ${entry.group} | ${entry.policy} | ${brief(tool.description)} |`),
  ].join("\n");
}

if (import.meta.main) console.log(await toolTable());
